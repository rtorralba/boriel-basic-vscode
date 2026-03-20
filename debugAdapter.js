const { LoggingDebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent, Thread, StackFrame, Scope, Source, Handles } = require('@vscode/debugadapter');
const { DebugProtocol } = require('@vscode/debugprotocol');
const net = require('net');
const child_process = require('child_process');
const fs = require('fs');
const path = require('path');

class BorielBasicDebugSession extends LoggingDebugSession {
    constructor() {
        super("borielbasic-debug.txt");
        console.log('[BorielBasicDebug] Constructor llamado');
        this._zesaruxProcess = null;
        this._debugSocket = null;
        this._socketBuffer = '';
        this._pendingResponses = new Map();
        this._breakpoints = new Map();
    this._pendingBreakpoints = []; // lista de { addrToken, clientLine }
    this._lastCommandSent = null;
    this._tapePlayUnsupported = false;
    this._autoBpForPc = null; // dirección para la que ya establecimos un breakpoint automático
    this._breakpointsEnabled = false;
    this._breakpointIdCounter = 1;
    this._breakpointAddrToId = new Map();
        // user breakpoints stored per source path: { '/abs/path/main.bas': Set([1,2,3]) }
        this._userBreakpointsByFile = {};
        // Si true, preferimos usar la secuencia enter-cpu-step -> cpu-step -> run
        // en lugar de intentar 'tape play'/'tape start'. Esto evita depender de
        // builds de ZEsarUX que no implementan esos comandos.
        this._preferCpuStepForRun = true;
        this._variableHandles = new Handles();
        this._configurationDone = false;
        this._stopped = false;
        this._currentLine = 0;
        this._lineMap = null; // Mapeo línea Boriel -> líneas ASM
        this._reverseLineMap = null; // Mapeo línea ASM -> línea Boriel
        this._asmLineToAddress = null; // Mapeo línea ASM -> dirección
    this._asmLabelAddressMap = {}; // mapa de etiqueta BAS___N___filename -> dirección (desde zxbasm Declaring)
        this._lastPC = null; // último PC leído del emulador
        this._previousPC = null; // PC anterior (para detectar isEndOfSub en ambas posiciones)
        this._lastAsmLine = null; // última línea ASM conocida para PC
        this._lastBasLine = null; // última línea Boriel conocida para PC
        this._lastSourceFile = null; // archivo fuente donde paró el breakpoint
        this._sourceFile = null; // Archivo fuente .bas
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);
        console.log('[BorielBasicDebug] Inicializado');
    }

    /**
     * Parse the ASM file to detect global variables: labels followed by DB/DW/DEFB/DEFW/DS directives.
     * Builds this._globalVariables = [ { name, asmLine, type, size, addr } ]
     */
    async _buildGlobalVariableMap(asmFile) {
        this._globalVariables = [];
        if (!asmFile || !fs.existsSync(asmFile)) return;
        try {
            const asmLines = fs.readFileSync(asmFile, 'utf8').split('\n').filter(line => line.trim() !== '');
            for (let i = 0; i < asmLines.length; i++) {
                const line = asmLines[i];
                const mLabel = line.match(/^\s*([A-Za-z_\.][A-Za-z0-9_\.]*)\s*:\s*$/);
                if (mLabel) {
                    const name = mLabel[1];
                    // Look ahead for data directive lines
                    let j = i + 1;
                    while (j < asmLines.length) {
                        const txt = asmLines[j].trim();
                        if (!txt || txt.startsWith(';') || txt.toUpperCase().startsWith('END')) { j++; continue; }
                        // Match data directives: db, dw, defb, defw, ds, ascii
                        const mData = txt.match(/^(db|dw|defb|defw|ds|ascii)\b\s*(.*)/i);
                        if (mData) {
                            const directive = mData[1].toLowerCase();
                            const rest = mData[2].trim();
                            let type = 'blob';
                            let size = 0;
                            if (directive === 'db' || directive === 'defb') {
                                type = 'byte';
                                // count number of comma separated values or string literal
                                // If rest contains a quoted string, count characters
                                const strMatch = rest.match(/^"([^"]*)"/);
                                if (strMatch) {
                                    size = strMatch[1].length;
                                } else {
                                    const parts = rest.split(/,/).map(s=>s.trim()).filter(s=>s.length>0);
                                    size = parts.length;
                                }
                            } else if (directive === 'dw' || directive === 'defw') {
                                type = 'word';
                                const parts = rest.split(/,/).map(s=>s.trim()).filter(s=>s.length>0);
                                size = parts.length * 2;
                            } else if (directive === 'ds') {
                                type = 'reserve';
                                const num = parseInt(rest.split(/[,\s]/)[0], 10) || 0;
                                size = num;
                            } else if (directive === 'ascii') {
                                type = 'string';
                                const strMatch = rest.match(/^"([^"]*)"/);
                                size = strMatch ? strMatch[1].length : rest.length;
                            }

                            // Determine runtime address: prefer asmSymbolAddressMap or asmLineToAddress
                            let addr = null;
                            if (this._asmSymbolAddressMap && this._asmSymbolAddressMap[name]) addr = this._asmSymbolAddressMap[name];
                            if (!addr && this._asmLineToAddress) {
                                const asmLineNum = j + 1; // 1-based
                                if (this._asmLineToAddress[asmLineNum]) addr = this._asmLineToAddress[asmLineNum];
                            }

                            this._globalVariables.push({ name, asmLine: i+1, type, size, addr: addr || null });
                        }
                        break; // whether data or not, stop scanning ahead for this label
                    }
                }
            }

            if (this._globalVariables.length > 0) {
                this.sendEvent(new OutputEvent(`[Debug] Detectadas ${this._globalVariables.length} variables globales en ASM\n`));
                for (const g of this._globalVariables) {
                    this.sendEvent(new OutputEvent(`[Debug]   ${g.name} @ asmLine ${g.asmLine} type=${g.type} size=${g.size} addr=${g.addr ? '0x'+g.addr.toString(16).toUpperCase() : 'unknown'}\n`));
                }
            }
        } catch (e) {
            throw e;
        }
    }

    initializeRequest(response, args) {
        console.log('[BorielBasicDebug] ============================================');
        console.log('[BorielBasicDebug] initializeRequest LLAMADO');
        console.log('[BorielBasicDebug] Args:', JSON.stringify(args, null, 2));
        console.log('[BorielBasicDebug] ============================================');
        this.sendEvent(new OutputEvent('=== Boriel Basic Debug Adapter iniciado ===\n'));
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsStepBack = false;
        response.body.supportsSetVariable = true;
        response.body.supportsRestartFrame = false;
        response.body.supportsGotoTargetsRequest = false;
        response.body.supportsStepInTargetsRequest = false;
        response.body.supportsCompletionsRequest = false;
        response.body.completionTriggerCharacters = [];
        response.body.supportsCancelRequest = false;
        response.body.supportsBreakpointLocationsRequest = false;
        response.body.supportsConditionalBreakpoints = false;
        response.body.supportsHitConditionalBreakpoints = false;
        response.body.supportsLogPoints = false;
        response.body.supportsReadMemoryRequest = true;
        response.body.supportsDisassembleRequest = true;
        console.log('[BorielBasicDebug] Enviando response de initialize');
        this.sendResponse(response);
        console.log('[BorielBasicDebug] Enviando InitializedEvent');
        this.sendEvent(new InitializedEvent());
        console.log('[BorielBasicDebug] initializeRequest completado');
    }

    async launchRequest(response, args) {
        console.error('[BorielBasic Debug] launchRequest llamado con args:', JSON.stringify(args, null, 2));
        try {
            // Intentar diferentes rutas de ZEsarUX
            let zesaruxPath = args.zesaruxPath;
            if (!zesaruxPath) {
                console.error('[BorielBasic Debug] No se especificó zesaruxPath, buscando...');
                const possiblePaths = [
                    process.env.HOME + '/bin/zesarux/zesarux',
                    '/usr/bin/zesarux',
                    '/usr/local/bin/zesarux',
                    'zesarux'
                ];
                
                for (const testPath of possiblePaths) {
                    if (fs.existsSync(testPath)) {
                        console.error('[BorielBasic Debug] Encontrado ZEsarUX en:', testPath);
                        zesaruxPath = testPath;
                        break;
                    }
                }
                
                if (!zesaruxPath) {
                    zesaruxPath = 'zesarux'; // fallback
                }
            }
            
            const debugPort = args.debugPort || 10000;
            const program = args.program;
            this._program = program;
            const stopOnEntry = args.stopOnEntry !== false;

            console.error('[BorielBasic Debug] Configuración final:', { zesaruxPath, debugPort, program, stopOnEntry });
            
            // Preparar carpeta .debug para archivos intermedios
            const programDir = path.dirname(program);
            const workspaceDir = path.dirname(programDir);
            const debugDir = path.join(workspaceDir, '.debug');
            // Borrar completamente la carpeta .debug si existe (incluye subcarpetas)
            try {
                if (fs.existsSync(debugDir)) {
                    fs.rmSync(debugDir, { recursive: true, force: true });
                    this.sendEvent(new OutputEvent(`[Debug] Carpeta .debug eliminada previamente: ${debugDir}\n`));
                }
            } catch (e) {
                this.sendEvent(new OutputEvent(`[Debug] No se pudo limpiar .debug: ${e.message}\n`, 'stderr'));
            }
            // Crear carpeta .debug vacía
            try {
                if (!fs.existsSync(debugDir)) {
                    fs.mkdirSync(debugDir, { recursive: true });
                }
            } catch (e) {
                this.sendEvent(new OutputEvent(`[Debug] No se pudo crear .debug: ${e.message}\n`, 'stderr'));
            }
            const baseName = path.basename(program, '.tap');
            
            // Cargar el mapeo de líneas si existe (ahora en .debug/)
            const lineMapFile = path.join(debugDir, baseName + '.linemap.json');
            if (fs.existsSync(lineMapFile)) {
                try {
                    const lineMapContent = fs.readFileSync(lineMapFile, 'utf8');
                    this._lineMap = JSON.parse(lineMapContent);
                    
                    // Detect format and create appropriate reverse mapping
                    this._reverseLineMap = {};
                    
                    // Check if this is the new extended format (address -> { borielLine, sourceFile, isEndOfSub })
                    const firstKey = Object.keys(this._lineMap)[0];
                    const firstValue = this._lineMap[firstKey];
                    
                    if (firstValue && typeof firstValue === 'object' && firstValue.borielLine !== undefined) {
                        // New extended format - use as-is
                        this._reverseLineMap = this._lineMap;
                        this.sendEvent(new OutputEvent(`✓ Linemap cargado (formato extendido): ${Object.keys(this._lineMap).length} direcciones mapeadas\n`));
                    } else {
                        // Old format or basLine -> [asmLines] format
                        for (const [key, value] of Object.entries(this._lineMap)) {
                            if (Array.isArray(value)) {
                                // basLine -> [asmLines] format
                                const basLine = key;
                                const asmLines = value;
                                for (const asmLine of asmLines) {
                                    this._reverseLineMap[asmLine] = parseInt(basLine);
                                }
                            } else {
                                // address -> basLine format
                                this._reverseLineMap[key] = { borielLine: parseInt(value, 10), sourceFile: null, isEndOfSub: false };
                            }
                        }
                        this.sendEvent(new OutputEvent(`✓ Linemap cargado (formato legacy): ${Object.keys(this._lineMap).length} entradas convertidas\n`));
                    }
                    
                    console.log('[BorielBasic Debug] Line map loaded:', this._lineMap);
                } catch (err) {
                    this.sendEvent(new OutputEvent(`⚠ Error al cargar mapeo de líneas: ${err.message}\n`));
                    console.error('[BorielBasic Debug] Error loading line map:', err);
                }
            } else {
                this.sendEvent(new OutputEvent(`⚠ No se encontró archivo de mapeo de líneas: ${lineMapFile}\n`));
            }
            
            // Guardar referencia al archivo fuente (por defecto basado en el TAP)
            this._sourceFile = program.replace(/\.tap$/i, '.bas');
            
            this.sendEvent(new OutputEvent(`Configuración de debug:\n`));
            this.sendEvent(new OutputEvent(`  ZEsarUX: ${zesaruxPath}\n`));
            this.sendEvent(new OutputEvent(`  Puerto: ${debugPort}\n`));
            this.sendEvent(new OutputEvent(`  Programa: ${program}\n`));
            this.sendEvent(new OutputEvent(`  Stop on entry: ${stopOnEntry}\n\n`));

            // Intentar compilar AUTO siempre (si existe main.bas en el workspace)
            try {
                const mainBas = path.join(workspaceDir, baseName + '.bas');
                // If we found the original main.bas, prefer it as the source file
                try {
                    if (fs.existsSync(mainBas)) {
                        this._sourceFile = mainBas;
                    }
                } catch (e) {}
                this.sendEvent(new OutputEvent(`[Debug] Intentando compilar desde: ${mainBas} (si existe)\n`));

                // Determinar binario zxbc según plataforma
                let bin = path.join(__dirname, 'bin', 'zxbasic-linux', 'zxbc');
                if (process.platform === 'win32') {
                    bin = path.join(__dirname, 'bin', 'zxbasic-windows', 'zxbc.exe');
                } else if (process.platform === 'darwin') {
                    bin = path.join(__dirname, 'bin', 'zxbasic-macos', 'zxbc');
                }

                if (!fs.existsSync(mainBas)) {
                    this.sendEvent(new OutputEvent(`[Debug] No se encontró el fuente para compilar: ${mainBas} (se omitirá compilación)\n`));
                } else if (!fs.existsSync(bin)) {
                    this.sendEvent(new OutputEvent(`[Debug] No se encontró el compilador zxbc en: ${bin} (se omitirá compilación)\n`));
                } else {
                    // PASO 1: Pre-procesar TODOS los archivos .bas del proyecto
                    this.sendEvent(new OutputEvent(`[Debug] Pre-procesando archivos .bas del proyecto...\n`));
                    
                    try {
                        // Buscar solo los archivos .bas a partir del main (siguiendo includes),
                        // en lugar de procesar todos los .bas del workspace.
                        const collectedBas = this._collectBasFilesFromMain(mainBas, workspaceDir);
                        this.sendEvent(new OutputEvent(`[Debug] Encontrados ${collectedBas.length} archivos .bas referenciados para preprocesar\n`));

                        // Preprocesar cada archivo manteniendo la estructura de carpetas
                        for (const basFile of collectedBas) {
                            this._preprocessBasFile(basFile, workspaceDir, debugDir);
                        }

                        this.sendEvent(new OutputEvent(`[Debug] ✓ Pre-procesado completado para archivos referenciados\n`));
                    } catch (preErr) {
                        this.sendEvent(new OutputEvent(`[Debug] ⚠ Error pre-procesando: ${preErr.message}\n`, 'stderr'));
                        this.sendEvent(new OutputEvent(`[Debug] Continuando con compilación...\n`));
                    }
                    
                    // PASO 2: Compilar el TAP desde el archivo original (para que funcione correctamente)
                    // Use -O2 for debug compilation per user request to match optimizations
                    const compileCmd = `${bin} -O2 -t -B -a "${mainBas}" -o "${program}"`;
                    this.sendEvent(new OutputEvent(`[Debug] Compilando TAP: ${compileCmd}\n`));
                    try {
                        const execSync = require('child_process').execSync;
                        const out = execSync(compileCmd, { cwd: workspaceDir, encoding: 'utf8' });
                        if (out && out.length) this.sendEvent(new OutputEvent(`zxbc: ${out}\n`));
                        this.sendEvent(new OutputEvent(`[Debug] ✓ Compilación TAP completada.\n`));
                    } catch (err) {
                        const stdout = err.stdout ? err.stdout.toString() : '';
                        const stderr = err.stderr ? err.stderr.toString() : err.message;
                        this.sendEvent(new OutputEvent(`Error compilando TAP: ${stderr}\n`, 'stderr'));
                    }
                    
                    // PASO 3: Compilar el ASM desde el archivo preprocesado principal (para obtener marcadores)
                    const preprocessedMainFile = path.join(debugDir, baseName + '.bas');
                    const asmFile = path.join(debugDir, baseName + '.asm');
                    // Generate ASM from the preprocessed file using same optimization level
                    const asmCmd = `${bin} -O2 -A "${preprocessedMainFile}" -o "${asmFile}"`;
                    this.sendEvent(new OutputEvent(`[Debug] Generando ASM con marcadores: ${asmCmd}\n`));
                    try {
                        const execSync = require('child_process').execSync;
                        const out = execSync(asmCmd, { cwd: workspaceDir, encoding: 'utf8' });
                        if (out && out.length) this.sendEvent(new OutputEvent(`zxbc ASM: ${out}\n`));
                        this.sendEvent(new OutputEvent(`[Debug] ✓ ASM generado: ${asmFile}\n`));
                        
                        // PASO 4: Generar el linemap desde el ASM con marcadores de las etiquetas BAS___N___filename
                        this._generateLineMapFromAsm(asmFile);
                        try {
                            await this._buildBasLineAddressMap(asmFile);
                        } catch (e) {
                            this.sendEvent(new OutputEvent(`[Debug] ⚠ Error generando basLine->addr map: ${e.message}\n`, 'stderr'));
                        }
                    } catch (err) {
                        const stderr = err.stderr ? err.stderr.toString() : err.message;
                        this.sendEvent(new OutputEvent(`⚠ Error generando ASM: ${stderr}\n`, 'stderr'));
                    }
                }
            } catch (e) {
                console.error('[BorielBasic Debug] Error intentando compilar automáticamente:', e);
            }

            // Verificar existencia del programa tras intento de compilación
            if (!fs.existsSync(program)) {
                this.sendErrorResponse(response, {
                    id: 1001,
                    format: `No se encuentra el archivo: ${program}`,
                    showUser: true
                });
                return;
            }
            
            // Verificar que ZEsarUX existe
            if (zesaruxPath !== 'zesarux' && !fs.existsSync(zesaruxPath)) {
                this.sendErrorResponse(response, {
                    id: 1005,
                    format: `No se encuentra ZEsarUX en: ${zesaruxPath}\nPor favor, configura 'zesaruxPath' en tu launch.json o instala ZEsarUX en tu PATH`,
                    showUser: true
                });
                return;
            }

            this.sendEvent(new OutputEvent(`Iniciando ZEsarUX...\n`));

            // Iniciar ZEsarUX con el protocolo de debug remoto
            // Calcular ruta del .asm generado (en .debug/)
            let asmFile = null;
            if (program && program.endsWith('.tap')) {
                asmFile = path.join(debugDir, baseName + '.asm');
                this._asmFile = asmFile;
                this.sendEvent(new OutputEvent(`[Debug] Ruta ASM calculada: ${asmFile}\n`));
                this.sendEvent(new OutputEvent(`[Debug] ¿Existe ASM?: ${fs.existsSync(asmFile)}\n`));
            }

            // Start ZEsarUX WITHOUT tape so we can set breakpoints first,
            // then use smartload command to load and run the program.
            const zesaruxArgs = [
                '--noconfigfile',
                '--enable-remoteprotocol',
                '--remoteprotocol-port', String(debugPort),
                '--machine', '128k',
                '--no-realvideo',
                '--verbose', '0'
            ];

            this.sendEvent(new OutputEvent(`Comando: ${zesaruxPath} ${zesaruxArgs.join(' ')}\n`));

            this._zesaruxProcess = child_process.spawn(zesaruxPath, zesaruxArgs, {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            this._zesaruxProcess.stdout.on('data', (data) => {
                this.sendEvent(new OutputEvent(`ZEsarUX: ${data.toString()}\n`));
            });

            this._zesaruxProcess.stderr.on('data', (data) => {
                this.sendEvent(new OutputEvent(`ZEsarUX Error: ${data.toString()}\n`, 'stderr'));
            });

            this._zesaruxProcess.on('error', (err) => {
                this.sendEvent(new OutputEvent(`Error al iniciar ZEsarUX: ${err.message}\n`, 'stderr'));
                this.sendErrorResponse(response, {
                    id: 1002,
                    format: `Error al iniciar ZEsarUX: ${err.message}`,
                    showUser: true
                });
            });

            this._zesaruxProcess.on('close', (code) => {
                this.sendEvent(new OutputEvent(`ZEsarUX cerrado con código ${code}\n`));
                this.sendEvent(new TerminatedEvent());
            });

            // Esperar a que ZEsarUX inicie
            this.sendEvent(new OutputEvent(`Esperando a que ZEsarUX inicie...\n`));
            await this._waitForZesarux(3000);

            // Conectar al protocolo de debug
            this.sendEvent(new OutputEvent(`Conectando al puerto ${debugPort}...\n`));
            try {
                await this._connectToZesarux(debugPort);
                this.sendEvent(new OutputEvent(`✓ Conectado a ZEsarUX en puerto ${debugPort}\n`));
            } catch (connectError) {
                this.sendEvent(new OutputEvent(`✗ Error al conectar: ${connectError.message}\n`, 'stderr'));
                this.sendErrorResponse(response, {
                    id: 1004,
                    format: `No se pudo conectar a ZEsarUX: ${connectError.message}. Verifica que ZEsarUX esté instalado y el puerto ${debugPort} esté disponible.`,
                    showUser: true
                });
                if (this._zesaruxProcess) {
                    this._zesaruxProcess.kill();
                }
                return;
            }

            this.sendEvent(new OutputEvent(`[Debug] Conexión exitosa, continuando con inicialización...\n`));
            this.sendEvent(new OutputEvent(`[Debug] asmFile = ${asmFile}\n`));
            this.sendEvent(new OutputEvent(`[Debug] existe? = ${asmFile ? fs.existsSync(asmFile) : 'N/A'}\n`));
            // La secuencia enter-cpu-step → enable-breakpoints → load-source-code → set-breakpoint
            // → smartload → run se ejecuta completamente dentro de _tryPlayTapeThenRun.
            // Los breakpoints pendientes también se instalan allí, una vez habilitados.

            // Pausar en la entrada si está configurado
            if (stopOnEntry) {
                this.sendEvent(new OutputEvent(`Pausando en entrada...\n`));

                // Build the Boriel line -> address map first
                let entryAddr = null;
                if (this._asmFile && fs.existsSync(this._asmFile)) {
                    await this._buildAsmAddressMap(this._asmFile);
                    await this._buildBasLineAddressMap(this._asmFile);

                    // If a linemap JSON exists and its keys look like addresses (e.g. '92BBH' -> '1'),
                    // prefer the first key as the entry breakpoint (user requested behavior).
                    try {
                        const lmPath = lineMapFile;
                        if (lmPath && fs.existsSync(lmPath)) {
                            const lmRaw = fs.readFileSync(lmPath, 'utf8');
                            const lmObj = JSON.parse(lmRaw);
                            const lmKeys = Object.keys(lmObj || {});
                            if (lmKeys && lmKeys.length > 0) {
                                const candidate = lmKeys[0];
                                // candidate like '92BBH' or '92BBh' or '92BB'
                                const m = String(candidate).match(/^([0-9A-Fa-f]+)H?$/);
                                if (m) {
                                    const hex = m[1];
                                    const addrNum = parseInt(hex, 16);
                                    if (!isNaN(addrNum)) {
                                        entryAddr = addrNum;
                                        this.sendEvent(new OutputEvent(`[Debug] Usando primera key del linemap (${candidate}) como entryAddr -> 0x${hex.toUpperCase()}\n`));
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        // ignore parse errors and continue with existing heuristics
                        this.sendEvent(new OutputEvent(`[Debug] No se pudo usar primera key de linemap: ${e.message}\n`, 'stderr'));
                    }

                    // Prefer the first user-set breakpoint in the source (main.bas) as the entry point
                    let entryBasLine = null;
                    try {
                        if (this._sourceFile && this._userBreakpointsByFile && this._userBreakpointsByFile[this._sourceFile]) {
                            const s = Array.from(this._userBreakpointsByFile[this._sourceFile]).map(n => parseInt(n,10)).filter(n=>!isNaN(n)).sort((a,b)=>a-b);
                            if (s.length > 0) entryBasLine = s[0];
                        }
                    } catch (e) {}

                    if (entryBasLine && this._basLineToAddress && this._basLineToAddress[entryBasLine]) {
                        entryAddr = this._basLineToAddress[entryBasLine];
                        this.sendEvent(new OutputEvent(`[Debug] Dirección de entrada (primer breakpoint usuario, Boriel ${entryBasLine}): 0x${entryAddr.toString(16).toUpperCase()}\n`));
                    } else {
                        // Use the address of the first Boriel line as entry point — prefer main source file
                        const mainSrc = this._sourceFile;
                        if (this._fileAddrMap && mainSrc && this._fileAddrMap[mainSrc] && this._fileAddrMap[mainSrc][1]) {
                            entryAddr = this._fileAddrMap[mainSrc][1];
                            this.sendEvent(new OutputEvent(`[Debug] Dirección de entrada (BASLINE_1 de ${path.basename(mainSrc)}): 0x${entryAddr.toString(16).toUpperCase()}\n`));
                        } else if (this._basLineToAddress && this._basLineToAddress[1]) {
                            entryAddr = this._basLineToAddress[1];
                            this.sendEvent(new OutputEvent(`[Debug] Dirección de entrada (BASLINE_1): 0x${entryAddr.toString(16).toUpperCase()}\n`));
                        } else if (this._asmLineToAddress && Object.keys(this._asmLineToAddress).length > 0) {
                            // Fallback: use minimum ASM address
                            const addrs = Object.values(this._asmLineToAddress).map(n => parseInt(n, 10));
                            entryAddr = Math.min(...addrs);
                            this.sendEvent(new OutputEvent(`[Debug] Dirección de entrada estimada (fallback): 0x${entryAddr.toString(16).toUpperCase()}\n`));
                        }
                    }
                }

                // guardar la dirección de entrada en la sesión para que otras rutinas la conozcan
                this._entryAddr = entryAddr;

                // Delegar TODA la secuencia de inicio a _tryPlayTapeThenRun:
                //   enter-cpu-step → enable-breakpoints → load-source-code
                //   → set-breakpoint → smartload → run
                // Así evitamos enviar comandos al socket antes de estar en cpu-step,
                // lo que causaba timeouts y desincronización de respuestas.
                try {
                    await this._tryPlayTapeThenRun(entryAddr);
                } catch (e) {
                    this.sendEvent(new OutputEvent(`[Debug] Error en _tryPlayTapeThenRun: ${e.message}\n`, 'stderr'));
                }

                    this._stopped = true;
                    this.sendEvent(new StoppedEvent('entry', 1));
            }

                // Si el usuario pidió la secuencia automática, iniciarla de forma asíncrona
                try {
                    if (args && args.autoSequence === true) {
                        // iniciar en background para no bloquear la respuesta de launch
                        setImmediate(() => {
                            this._startSequentialBasBreakpointSequence().catch((e) => {
                                this.sendEvent(new OutputEvent(`[Debug] Error en secuencia automática: ${e.message}\n`, 'stderr'));
                            });
                        });
                    }
                } catch (e) {
                    this.sendEvent(new OutputEvent(`[Debug] Error comprobando autoSequence: ${e.message}\n`, 'stderr'));
                }

                this.sendResponse(response);

        } catch (error) {
            this.sendEvent(new OutputEvent(`Error general: ${error.message}\n${error.stack}\n`, 'stderr'));
            this.sendErrorResponse(response, {
                id: 1003,
                format: `Error: ${error.message}`,
                showUser: true
            });
        }
    }

    async _waitForZesarux(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Construye un mapa de línea ASM -> dirección ejecutando `zxbasm -d` sobre el .asm
     * Guarda los resultados en this._asmLineToAddress (1-based asm line -> address)
     */
    async _buildAsmAddressMap(asmFile) {
        this._asmLineToAddress = {};
        this._asmLabelAddressMap = {};
    this._asmSymbolAddressMap = {}; // other symbols (labels) -> address
        if (!asmFile || !fs.existsSync(asmFile)) return;
        try {
            let zxbasmPath;
            let nullDevice;
            if (process.platform === 'win32') {
                zxbasmPath = path.join(__dirname, 'bin', 'zxbasic-windows', 'zxbasm.exe');
                nullDevice = 'nul';
            } else if (process.platform === 'linux') {
                zxbasmPath = path.join(__dirname, 'bin', 'zxbasic-linux', 'zxbasm');
                nullDevice = '/dev/null';
            } else if (process.platform === 'darwin') {
                zxbasmPath = path.join(__dirname, 'bin', 'zxbasic-macos', 'zxbasm');
                nullDevice = '/dev/null';
            }
            const zxbasmCmd = `${zxbasmPath} -d "${asmFile}" -o ${nullDevice} 2>&1`;
            this.sendEvent(new OutputEvent(`[Debug] Ejecutando zxbasm para mapear ASM (launch): ${zxbasmCmd}\n`));
            const execSync = require('child_process').execSync;
            // CRITICAL: Capture both stdout AND stderr because "Declaring" lines go to stderr
            const out = execSync(zxbasmCmd, { 
                cwd: path.dirname(asmFile), 
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']  // stdin, stdout, stderr
            });

            // Show first 100 lines of zxbasm output for debugging
            const outLines = out.split('\n');
            this.sendEvent(new OutputEvent(`[Debug] zxbasm output (first 100 of ${outLines.length} total lines):\n`));
            for (let i = 0; i < Math.min(100, outLines.length); i++) {
                this.sendEvent(new OutputEvent(`  ${outLines[i]}\n`));
            }

            const asmLines = fs.readFileSync(asmFile, 'utf8').split('\n');

            // Parse 'Declaring' lines to capture label addresses for any declared symbols
            // Format example: Declaring '.__BASLINE_1__' (value 92BBh) in 2
            const declReAny = /Declaring\s+'\.?([A-Za-z0-9_\.]+)'.*\(value\s+([0-9A-Fa-f]+)h?\)/i;
            let declCount = 0;
            for (const line of out.split('\n')) {
                const md = line.match(declReAny);
                if (md) {
                    const name = md[1];
                    const hex = md[2];
                    const addrDec = parseInt(hex, 16);
                    // If it's a BAS marker, store in asmLabelAddressMap keyed by line number
                    // Format: BAS___N___filename (e.g., BAS___5___main__bas or BAS___10___lib_functions__bas)
                    const mBas = name.match(/^BAS___(\d+)___([A-Za-z0-9_]+)$/i);
                    if (mBas) {
                        const basNum = parseInt(mBas[1], 10);
                        const filenamePart = mBas[2]; // e.g., "main__bas" or "lib_functions__bas"
                        // Decodificar: primero __ → . (puntos), luego _ → / (separadores de ruta)
                        const sourceFileName = filenamePart.replace(/__/g, '.').replace(/_/g, '/'); // Convert back: "main.bas" or "lib/functions.bas"
                        // Use compound key "lineNum:filenamePart" to avoid collisions between files with same line numbers
                        const labelKey = `${basNum}:${filenamePart}`;
                        this._asmLabelAddressMap[labelKey] = { addr: addrDec, sourceFile: sourceFileName, basNum };
                        this.sendEvent(new OutputEvent(`[Debug][zxbasm] ✓ Found BAS marker ${basNum} from ${sourceFileName} at address 0x${hex.toUpperCase()} (decimal ${addrDec})\n`));
                    } else {
                        // store other symbol labels
                        this._asmSymbolAddressMap[name] = addrDec;
                        this.sendEvent(new OutputEvent(`[Debug][zxbasm] ✓ Found symbol '${name}' at address 0x${hex.toUpperCase()} (decimal ${addrDec})\n`));
                    }
                    declCount++;
                }
            }
            this.sendEvent(new OutputEvent(`[Debug] Total parsed declarations from zxbasm: ${declCount}\n`));

            // Also parse ASM disassembly address lines and map to asm source lines
            const addrLines = out.split('\n').filter(l => /\bASM:\s*/.test(l));
            const addresses = [];
            const addrRe = /([0-9A-Fa-f]+)h\s+\[([0-9A-Fa-f]+)h\]\s+ASM:/;
            for (const l of addrLines) {
                const m = l.match(addrRe);
                if (m) addresses.push(parseInt(m[2], 16));
            }

            let addrIndex = 0;
            let currentOrg = 0x8000;
            for (let i = 0; i < asmLines.length; i++) {
                const ln = asmLines[i].trim();
                const mOrg = ln.match(/^org\s+(0x[0-9a-fA-F]+|\d+)/i);
                if (mOrg) {
                    const v = mOrg[1];
                    currentOrg = v.startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10);
                }
                if (!ln || ln.startsWith(';') || ln.startsWith('#') || ln.toUpperCase().startsWith('END') || ln.toUpperCase().startsWith('ASM')) continue;
                if (addrIndex < addresses.length) {
                    this._asmLineToAddress[i + 1] = addresses[addrIndex++];
                } else {
                    this._asmLineToAddress[i + 1] = currentOrg + (i);
                }
            }

            this.sendEvent(new OutputEvent(`[Debug] Mapa ASM->addr creado: ${Object.keys(this._asmLineToAddress).length} entradas\n`));
            if (this._asmLabelAddressMap && Object.keys(this._asmLabelAddressMap).length > 0) {
                this.sendEvent(new OutputEvent(`[Debug] Mapa etiquetas __BASLINE detectadas: ${Object.keys(this._asmLabelAddressMap).length} entradas\n`));
            }
        } catch (e) {
            this.sendEvent(new OutputEvent(`[Debug] No se pudo generar mapa ASM en launch: ${e.message}\n`));
        }
    }

    /**
     * Construye un mapa BorielLine -> dirección inicial en memoria.
     * Busca las etiquetas '__BASLINE_N__:' en el .asm y asigna la dirección de la
     * primera instrucción ASM que aparece tras la etiqueta usando this._asmLineToAddress.
     * Guarda el resultado en this._basLineToAddress (mapa numérico -> número decimal addr).
     * También persiste el map en el archivo <program>.linemap.json si es posible.
     */
    async _buildBasLineAddressMap(asmFile) {
        this._basLineToAddress = {};
        if (!asmFile || !fs.existsSync(asmFile)) return;

        // Find original .bas source file to detect END SUB/FUNCTION and function calls
        const sourceFile = this._sourceFile;
        const endOfSubLines = new Set();
        const functionCallInfo = new Map(); // Maps function name -> {callLine, callAddress}

        if (sourceFile && fs.existsSync(sourceFile)) {
            try {
                const sourceContent = fs.readFileSync(sourceFile, 'utf8').split('\n');
                
                // First pass: detect function calls
                for (let i = 0; i < sourceContent.length; i++) {
                    const line = sourceContent[i].trim();
                    // Look for function calls like: greetUser("Maria"), functionName(args), etc.
                    const functionCallMatch = line.match(/(\w+)\s*\(/);
                    if (functionCallMatch && !line.toUpperCase().includes('PRINT') && 
                        !line.toUpperCase().includes('IF') && !line.toUpperCase().includes('FOR') &&
                        !line.toUpperCase().includes('WHILE') && !line.toUpperCase().includes('DIM')) {
                        const functionName = functionCallMatch[1];
                        this.sendEvent(new OutputEvent(`[Debug] Detected function call '${functionName}' at line ${i + 1}\n`));
                        functionCallInfo.set(functionName, { callLine: i + 1, callAddress: null });
                    }
                }
                
                // Second pass: detect END SUB/FUNCTION and match with calls
                for (let i = 0; i < sourceContent.length; i++) {
                    const line = sourceContent[i].trim().toUpperCase();
                    if (line.startsWith('END SUB') || line.startsWith('END FUNCTION')) {
                        // Find the function definition line
                        let functionName = null;
                        for (let j = i - 1; j >= 0; j--) {
                            const prevLine = sourceContent[j].trim().toUpperCase();
                            const subMatch = prevLine.match(/SUB\s+(\w+)/);
                            const funcMatch = prevLine.match(/FUNCTION\s+(\w+)/);
                            if (subMatch || funcMatch) {
                                functionName = (subMatch || funcMatch)[1].toLowerCase();
                                break;
                            }
                        }
                        
                        // The actual return happens on the line *before* the END SUB/FUNCTION
                        // Let's find the last non-empty, non-comment line before the END SUB/FUNCTION
                        let targetLine = -1;
                        for (let j = i - 1; j >= 0; j--) {
                            const prevLine = sourceContent[j].trim();
                            if (prevLine && !prevLine.startsWith("'") && !prevLine.toUpperCase().startsWith("REM") &&
                                !prevLine.toUpperCase().startsWith("SUB") && !prevLine.toUpperCase().startsWith("FUNCTION")) {
                                targetLine = j + 1; // 1-based line number
                                break;
                            }
                        }
                        if (targetLine !== -1) {
                            this.sendEvent(new OutputEvent(`[Debug] Detected end of sub/function '${functionName}' at line ${i+1}. Marking line ${targetLine} as isEndOfSub.\n`));
                            endOfSubLines.add(targetLine);
                            
                            // Store function info for later stepOutAddress calculation
                            if (functionName && functionCallInfo.has(functionName)) {
                                const callInfo = functionCallInfo.get(functionName);
                                callInfo.endOfSubLine = targetLine;
                                this.sendEvent(new OutputEvent(`[Debug] Function '${functionName}': call at line ${callInfo.callLine}, end at line ${targetLine}\n`));
                            }
                        }
                    }
                }
            } catch (e) {
                this.sendEvent(new OutputEvent(`[Debug] Could not read source file to detect function info: ${e.message}\n`, 'stderr'));
            }
        }

        // Now find addresses for function calls in ASM and calculate stepOutAddress
        if (functionCallInfo.size > 0) {
            try {
                const asmLines = fs.readFileSync(asmFile, 'utf8').split('\n');
                for (const [functionName, callInfo] of functionCallInfo.entries()) {
                    // Find the address of the call line
                    if (this._basLineToAddress[callInfo.callLine]) {
                        const callAddress = this._basLineToAddress[callInfo.callLine];
                        const returnAddress = callAddress + 3; // Z80 CALL instruction is typically 3 bytes
                        callInfo.callAddress = callAddress;
                        callInfo.returnAddress = returnAddress;
                        this.sendEvent(new OutputEvent(`[Debug] Function '${functionName}': call at 0x${callAddress.toString(16).toUpperCase()}, return at 0x${returnAddress.toString(16).toUpperCase()}\n`));
                    }
                }
            } catch (e) {
                this.sendEvent(new OutputEvent(`[Debug] Could not calculate function call addresses: ${e.message}\n`, 'stderr'));
            }
        }

        // Asegurarnos de tener el mapa asmLine->address
        if (!this._asmLineToAddress) {
            await this._buildAsmAddressMap(asmFile);
        }

        // Build per-file address map: absoluteSourcePath -> { lineNum -> addr }
        // This avoids collisions when multiple source files share the same line numbers.
        this._fileAddrMap = {};

        // If zxbasm produced explicit Declaring lines for __BASLINE_N__, prefer those
        // as the authoritative addresses (they reflect the assembler/runtime mapping).
        if (this._asmLabelAddressMap && Object.keys(this._asmLabelAddressMap).length > 0) {
            this.sendEvent(new OutputEvent(`[Debug] ✓ Using ${Object.keys(this._asmLabelAddressMap).length} addresses from zxbasm Declaring lines\n`));
            for (const [k, v] of Object.entries(this._asmLabelAddressMap)) {
                // Key format is now "lineNum:filenamePart"
                const colonIdx = k.indexOf(':');
                const bas = parseInt(colonIdx >= 0 ? k.substring(0, colonIdx) : k, 10);
                // v is now { addr, sourceFile, basNum }
                const addrNum = typeof v === 'object' ? v.addr : parseInt(v, 10);
                const extractedSourceFile = typeof v === 'object' ? v.sourceFile : null;
                if (!isNaN(bas) && !isNaN(addrNum)) {
                    // Derive absolute source path for file-aware map
                    const mainSourceFile = this._sourceFile || null;
                    const absSourceFile = extractedSourceFile
                        ? path.join(path.dirname(mainSourceFile || ''), extractedSourceFile)
                        : (mainSourceFile || null);
                    // Build per-file map
                    if (absSourceFile) {
                        if (!this._fileAddrMap[absSourceFile]) this._fileAddrMap[absSourceFile] = {};
                        this._fileAddrMap[absSourceFile][bas] = addrNum;
                    }
                    // Build _basLineToAddress: MAIN source file takes priority over included files
                    const isMainFile = absSourceFile === mainSourceFile;
                    if (isMainFile || this._basLineToAddress[bas] === undefined) {
                        this._basLineToAddress[bas] = addrNum;
                        if (!this._basLineToSourceFile) this._basLineToSourceFile = {};
                        if (extractedSourceFile) this._basLineToSourceFile[bas] = extractedSourceFile;
                    }
                    this.sendEvent(new OutputEvent(`[Debug]   BASLINE_${bas} -> 0x${addrNum.toString(16).toUpperCase()}${extractedSourceFile ? ` (${extractedSourceFile})` : ''}\n`));
                }
            }
            // Don't run fallback heuristic if we have authoritative addresses from zxbasm
        } else {
            this.sendEvent(new OutputEvent(`[Debug][WARNING] ⚠ No zxbasm Declaring addresses found! Falling back to heuristic mapping.\n`, 'stderr'));
            
            // Fallback heuristic: scan for BAS___N___filename: labels in ASM and find next instruction address
            const asmLines = fs.readFileSync(asmFile, 'utf8').split('\n');

            for (let i = 0; i < asmLines.length; i++) {
                const l = asmLines[i];
                // Format: BAS___N___filename:
                const m = l.match(/BAS___(\d+)___([A-Za-z0-9_]+)\s*:/);
                if (m) {
                    const bas = parseInt(m[1], 10);
                    const filenamePart = m[2];
                    // Decodificar: primero __ → . (puntos), luego _ → / (separadores de ruta)
                    const extractedSourceFile = filenamePart.replace(/__/g, '.').replace(/_/g, '/');
                    // Buscar la primera línea ASM válida después de la etiqueta
                    let j = i + 1;
                    let foundAddr = null;
                    while (j <= asmLines.length) {
                        const txt = (asmLines[j] || '').trim();
                        if (txt && !txt.startsWith(';') && !txt.toUpperCase().startsWith('END') && !txt.toUpperCase().startsWith('ASM') && !txt.startsWith('#line')) {
                            // j is 0-based index, asmLine numbers are 1-based
                            const addr = this._asmLineToAddress[j + 1];
                            if (addr !== undefined) { foundAddr = parseInt(addr, 10); break; }
                        }
                        j++;
                    }
                    if (foundAddr !== null) {
                        this._basLineToAddress[bas] = foundAddr;
                        // Store sourceFile info
                        if (!this._basLineToSourceFile) this._basLineToSourceFile = {};
                        if (extractedSourceFile) this._basLineToSourceFile[bas] = extractedSourceFile;
                    }
                }
            }
        }

        // Build global variable map from ASM: labels followed by data directives
        try {
            await this._buildGlobalVariableMap(asmFile);
        } catch (e) {
            this.sendEvent(new OutputEvent(`[Debug] No se pudo construir mapa de variables globales: ${e.message}\n`, 'stderr'));
        }

        // Log the mapping in a human readable way
        const basKeys = Object.keys(this._basLineToAddress).map(k => parseInt(k,10)).sort((a,b)=>a-b);
        this.sendEvent(new OutputEvent(`[Debug] Baseline -> address map (${basKeys.length} entries):\n`));
        for (const k of basKeys) {
            const addr = this._basLineToAddress[k];
            this.sendEvent(new OutputEvent(`  Boriel line ${k} -> 0x${addr.toString(16).toUpperCase()}\n`));
        }

        // Persist a small linemap with addresses next to existing linemap file if possible
        try {
                if (this._program) {
                    const programDir = path.dirname(this._program);
                    const workspaceDir = path.dirname(programDir);
                    const debugDir = path.join(workspaceDir, '.debug');
                    const baseName = path.basename(this._program, '.tap');
                    const outFile = path.join(debugDir, baseName + '.linemap.json');
                    // Persist reverse mapping: { '92BBH': { borielLine: 1, sourceFile: '...', isEndOfSub: false }, ... }
                    const reverseExtended = {};
                    // Also build runtime map addrDecimal -> basLine
                    this._addrToBasLine = {};
                    for (const k of basKeys) {
                        const addr = this._basLineToAddress[k];
                        if (addr !== undefined && addr !== null) {
                            const hex = addr.toString(16).toUpperCase();
                            const borielLineNum = parseInt(k, 10);
                            
                            // Calculate stepOutAddress for endOfSub lines
                            let stepOutAddress = null;
                            if (endOfSubLines.has(borielLineNum)) {
                                // Find which function this endOfSub belongs to
                                for (const [functionName, callInfo] of functionCallInfo.entries()) {
                                    if (callInfo.endOfSubLine === borielLineNum && callInfo.returnAddress) {
                                        stepOutAddress = callInfo.returnAddress;
                                        this.sendEvent(new OutputEvent(`[Debug] Line ${borielLineNum} (end of '${functionName}') gets stepOutAddress=0x${stepOutAddress.toString(16).toUpperCase()}\n`));
                                        break;
                                    }
                                }
                            }
                            
                            // Use extracted sourceFile from label if available, otherwise use main sourceFile
                            const lineSourceFile = (this._basLineToSourceFile && this._basLineToSourceFile[borielLineNum]) 
                                ? path.join(path.dirname(sourceFile || ''), this._basLineToSourceFile[borielLineNum])
                                : (sourceFile || null);
                            
                            reverseExtended[`${hex}H`] = {
                                borielLine: borielLineNum,
                                sourceFile: lineSourceFile,
                                isEndOfSub: endOfSubLines.has(borielLineNum),
                                stepOutAddress: stepOutAddress
                            };
                            try {
                                this._addrToBasLine[parseInt(addr,10)] = borielLineNum;
                            } catch (e) {}
                        }
                    }
                    // Log del mapeo construido
                    this.sendEvent(new OutputEvent(`[Debug] ✓ Mapeo reverso construido con ${Object.keys(this._addrToBasLine).length} direcciones
`));
                    if (Object.keys(this._addrToBasLine).length > 0) {
                        const sample = Object.entries(this._addrToBasLine).slice(0, 5);
                        this.sendEvent(new OutputEvent(`[Debug] Ejemplo de mapeo: ${JSON.stringify(sample)}
`));
                    }
                    this.sendEvent(new OutputEvent(`[Debug] About to persist reverse linemap with ${Object.keys(reverseExtended).length} entries:\n`));
                    for (const [k, v] of Object.entries(reverseExtended)) {
                        this.sendEvent(new OutputEvent(`[Debug]   JSON[${k}] = ${JSON.stringify(v)}\n`));
                    }
                    fs.writeFileSync(outFile, JSON.stringify(reverseExtended, null, 2), 'utf8');
                    this.sendEvent(new OutputEvent(`[Debug] Persistido linemap reverse con direcciones en: ${outFile}\n`));

                    // IMPORTANT: Update the in-memory _reverseLineMap to use the new extended format
                    this._reverseLineMap = reverseExtended;
                }
        } catch (e) {
            this.sendEvent(new OutputEvent(`[Debug] No se pudo persistir linemap: ${e.message}\n`, 'stderr'));
        }
    }

    async _removeBreakpointByAddr(addrNum) {
        try {
            if (!addrNum) return false;
            // If we have a breakpoint id stored for this addr, try to remove it using remote command
            const bpId = this._breakpointAddrToId.get(parseInt(addrNum, 10));
            if (bpId !== undefined) {
                try {
                    await this._sendCommandAndWait(`remove-breakpoint ${bpId}`);
                } catch (e) {
                    // try alternative name
                    try { await this._sendCommandAndWait(`delete-breakpoint ${bpId}`); } catch (e2) {}
                }
                this._breakpointAddrToId.delete(parseInt(addrNum, 10));
                this._breakpoints.delete(bpId);
                return true;
            }
            // Fallback: try legacy removal by address
            const addrToken = `${parseInt(addrNum,10).toString(16).toUpperCase()}h`;
            try { await this._sendCommandAndWait(`break del ${addrToken}`); return true; } catch (e) {}
            try { await this._sendCommandAndWait(`break remove ${addrToken}`); return true; } catch (e) {}
            return false;
        } catch (e) {
            return false;
        }
    }

    /**
     * Set sequence breakpoint always at slot 1 (authoritative for the step-over sequence).
     * This will attempt to remove any existing breakpoint id 1 and set a new one.
     */
    async _setSequenceBreakpoint(addrNum) {
        try {
            if (!addrNum) return false;
            try { await this._ensureBreakpointsEnabled(); } catch (e) {}

            // Try to remove existing id 1 (best-effort)
            try { await this._sendCommandAndWait('remove-breakpoint 1'); } catch (e) { try { await this._sendCommandAndWait('delete-breakpoint 1'); } catch(e2) {} }

            const hexNoPrefix = parseInt(addrNum, 10).toString(16).toUpperCase();
            const cmd = `set-breakpoint 1 PC=${hexNoPrefix}H`;
            try {
                const resp = await this._sendCommandAndWait(cmd);
                const lower = String(resp || '').toLowerCase();
                if (lower.includes('unknown command') || lower.includes('error')) {
                    // fallback to legacy
                    await this._sendCommand(`break set ${hexNoPrefix}H`);
                }
                // remember sequence addr
                this._sequenceBreakpointAddr = addrNum;
                return true;
            } catch (e) {
                // legacy fallback
                try {
                    await this._sendCommand(`break set ${hexNoPrefix}H`);
                    this._sequenceBreakpointAddr = addrNum;
                    return true;
                } catch (e2) {
                    return false;
                }
            }
        } catch (e) {
            return false;
        }
    }

    /**
     * Busca recursivamente todos los archivos .bas en el workspace,
     * excluyendo la carpeta .debug
     */
    _findAllBasFiles(workspaceDir, debugDir) {
        const basFiles = [];
        const debugDirNormalized = path.normalize(debugDir);
        
        const searchDir = (dir) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    const normalizedPath = path.normalize(fullPath);
                    
                    // Saltar la carpeta .debug
                    if (normalizedPath.startsWith(debugDirNormalized)) {
                        continue;
                    }
                    
                    if (entry.isDirectory()) {
                        // Recursión en subcarpetas
                        searchDir(fullPath);
                    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.bas')) {
                        basFiles.push(fullPath);
                    }
                }
            } catch (err) {
                // Ignorar errores de permisos, etc.
            }
        };
        
        searchDir(workspaceDir);
        return basFiles;
    }

    /**
     * Recolecta recursivamente solo los archivos .bas empezando por el archivo principal
     * y siguiendo directivas de inclusión (#include "file" / #include <file> / INCLUDE ...).
     * Devuelve rutas absolutas a los archivos existentes.
     */
    _collectBasFilesFromMain(startFile, workspaceDir) {
        const collected = [];
        const visited = new Set();

        const resolveIncludeCandidates = (includeName, currentDir) => {
            const candidates = [];
            if (path.isAbsolute(includeName)) candidates.push(includeName);
            // try relative to current file
            candidates.push(path.join(currentDir, includeName));
            // try relative to workspace root
            candidates.push(path.join(workspaceDir, includeName));
            // also try with .bas extension if omitted
            if (!includeName.toLowerCase().endsWith('.bas')) {
                candidates.push(path.join(currentDir, includeName + '.bas'));
                candidates.push(path.join(workspaceDir, includeName + '.bas'));
            }
            return candidates;
        };

        const includeRegex1 = /#include\s+["<]([^">]+)[">]/i;
        const includeRegex2 = /\bINCLUDE\b\s+["']?([^"'\s]+)["']?/i;

        const walk = (filePath) => {
            try {
                if (!filePath) return;
                const normalized = path.normalize(filePath);
                if (visited.has(normalized)) return;
                visited.add(normalized);

                if (!fs.existsSync(normalized)) return;
                if (!normalized.toLowerCase().endsWith('.bas')) return;

                collected.push(normalized);

                const content = fs.readFileSync(normalized, 'utf8');
                const lines = content.split('\n');
                const currentDir = path.dirname(normalized);

                for (const ln of lines) {
                    let m = ln.match(includeRegex1);
                    if (!m) m = ln.match(includeRegex2);
                    if (m && m[1]) {
                        const incName = m[1].trim();
                        const candidates = resolveIncludeCandidates(incName, currentDir);
                        let found = null;
                        for (const cand of candidates) {
                            if (fs.existsSync(cand)) { found = cand; break; }
                        }
                        if (found) {
                            walk(found);
                        } else {
                            // no encontrado: intentar buscar en workspace recursivamente por nombre base
                            const basename = path.basename(incName);
                            try {
                                const matches = this._findWorkspaceFilesByName(workspaceDir, basename);
                                if (matches.length > 0) walk(matches[0]);
                                else this.sendEvent(new OutputEvent(`[Debug] ⚠ Include no encontrado: ${incName} (referenciado desde ${normalized})\n`, 'stderr'));
                            } catch (e) {
                                this.sendEvent(new OutputEvent(`[Debug] ⚠ Error buscando include ${incName}: ${e.message}\n`, 'stderr'));
                            }
                        }
                    }
                }
            } catch (e) {
                // ignore
            }
        };

        walk(startFile);
        return collected;
    }

    /**
     * Helper: busca recursivamente dentro del workspace el primer archivo que coincida
     * por nombre de fichero (basename). Devuelve array de coincidencias absolutas.
     */
    _findWorkspaceFilesByName(workspaceDir, name) {
        const results = [];
        const search = (dir) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (entry.name === '.debug') continue;
                        search(full);
                    } else if (entry.isFile() && entry.name === name) {
                        results.push(full);
                    }
                }
            } catch (e) {}
        };
        search(workspaceDir);
        return results;
    }

    /**
     * Pre-procesa un archivo .bas individual, añadiendo marcadores __BASLINE
     * y guardándolo en .debug manteniendo la estructura de carpetas
     */
    _preprocessBasFile(basFile, workspaceDir, debugDir) {
        try {
            // Calcular la ruta relativa desde workspaceDir
            const relativePath = path.relative(workspaceDir, basFile);
            
            // Construir la ruta de destino en .debug
            const targetFile = path.join(debugDir, relativePath);
            const targetDir = path.dirname(targetFile);
            
            // Crear la estructura de carpetas si no existe
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
            
            // Leer el contenido del archivo original
            const sourceContent = fs.readFileSync(basFile, 'utf8');
            const sourceLines = sourceContent.split('\n');
            const preprocessedLines = [];
            
            // Tokens que representan sentencias que no generan código ejecutable propio
            const FLOW_TOKENS = new Set(['IF','ELSE','END','FOR','WHILE','DO','LOOP','GOTO','GOSUB','RETURN','NEXT','UNTIL','SELECT','CASE','THEN','DIM','SUB','FUNCTION']);

            // Generar nombre de archivo para las etiquetas usando la ruta relativa completa
            // Formato: BAS___lineNumber___filename donde:
            // - Separadores de ruta (/ o \) → _ (1 guión bajo)
            // - Puntos (.) → __ (2 guiones bajos)
            // Ejemplo: lib/functions.bas → lib_functions__bas
            const fileLabel = relativePath.replace(/[\\\/]/g, '_').replace(/\./g, '__');

            sourceLines.forEach((line, index) => {
                const originalLineNumber = index + 1;
                const trimmedLine = line.trim();

                // Solo añadir marcadores para líneas de código real ejecutable.
                // Excluir: comentarios, directivas de preprocesador (#include, #define…),
                // sentencias de flujo/declaración y líneas vacías.
                const firstToken = (trimmedLine.split(/\s+/)[0] || '').toUpperCase();
                const isPreprocessor = trimmedLine.startsWith('#');
                const isComment = trimmedLine.startsWith("'") || trimmedLine.toUpperCase().startsWith('REM ');
                if (trimmedLine && !isComment && !isPreprocessor && !FLOW_TOKENS.has(firstToken)) {
                    
                    // Añadir marcador ANTES de la línea de código
                    // Formato: BAS___lineNumber___filename
                    preprocessedLines.push(`ASM`);
                    preprocessedLines.push(`BAS___${originalLineNumber}___${fileLabel}:`);
                    preprocessedLines.push(`END ASM`);
                }
                
                // Añadir la línea original
                preprocessedLines.push(line);
            });
            
            // Guardar el archivo preprocesado
            fs.writeFileSync(targetFile, preprocessedLines.join('\n'), 'utf8');
            this.sendEvent(new OutputEvent(`[Debug]   ✓ ${relativePath}\n`));
            
        } catch (err) {
            this.sendEvent(new OutputEvent(`[Debug]   ⚠ Error procesando ${path.basename(basFile)}: ${err.message}\n`, 'stderr'));
        }
    }

    /**
     * Genera el linemap parseando los marcadores BAS___N___filename desde el ASM generado
     * Guarda en this._lineMap = { "1": [34, 35, 36], "2": [37, 38] }
     */
    _generateLineMapFromAsm(asmFile) {
        try {
            this.sendEvent(new OutputEvent(`[Debug] Generando line map desde marcadores en: ${asmFile}\n`));
            
            if (!fs.existsSync(asmFile)) {
                this.sendEvent(new OutputEvent(`[Debug] ⚠ No se encontró ASM para generar linemap: ${asmFile}\n`, 'stderr'));
                return;
            }
            // Strategy:
            // 1) Build a map from preprocessed.bas line -> original Boriel line by scanning the preprocessed file
            //    (we inserted labels like BAS___N___filename: before each Boriel source line)
            // 2) Parse the generated ASM for '#line <n> "<preprocessedFile>"' directives that tell which
            //    preprocessed line the following ASM comes from. Use that to map ASM lines -> preprocessed lines
            // 3) Use preprocessedLine -> basLine map to produce final this._lineMap (basLine -> [asmLines])

            // Attempt to locate the preprocessed file path from asm #line directives header (heuristic)
            const asmContent = fs.readFileSync(asmFile, 'utf8');
            const asmLines = asmContent.split('\n');

            this._lineMap = {};
            this._reverseLineMap = {};

            // Primary strategy: search STRICT for the exact markers we inserted in the preprocessed BAS
            // We accept label form in the final ASM:
            //  - a label:    BAS___123___filename:
            // When we see such a marker, we set currentBasLine and map subsequent ASM instructions
            // to that Boriel line until another marker appears.
            let currentBasLine = null;
            for (let i = 0; i < asmLines.length; i++) {
                const line = asmLines[i];
                const asmLineNumber = i + 1;

                // Detect label form
                const mLabel = line.match(/BAS___(\d+)___/);
                if (mLabel) {
                    currentBasLine = parseInt(mLabel[1], 10);
                    // label line itself is not mapped to instructions; continue
                    continue;
                }

                // If this looks like an actual instruction and we have a currentBasLine, map it
                const trimmed = line.trim();
                if (currentBasLine && trimmed && !trimmed.startsWith(';') && !trimmed.toUpperCase().startsWith('END') && !trimmed.toUpperCase().startsWith('ASM')) {
                    if (!this._lineMap[currentBasLine]) this._lineMap[currentBasLine] = [];
                    this._lineMap[currentBasLine].push(asmLineNumber);
                    this._reverseLineMap[asmLineNumber] = currentBasLine;
                }
            }

            // If primary strategy produced no markers (e.g., labels/comments were stripped), fall back
            // to the previous #line-based heuristic to salvage mappings.
            const mappedCount = this._reverseLineMap ? Object.keys(this._reverseLineMap).length : 0;
            if (mappedCount === 0) {
                this.sendEvent(new OutputEvent(`[Debug] No se encontraron marcadores directos BAS en ASM; usando fallback #line heuristic\n`));

                // First, try to detect preprocessed file referenced in the ASM via #line directives
                // It should be in .debug/ folder now
                let detectedPreprocessedPath = null;
                for (let i = 0; i < Math.min(200, asmLines.length); i++) {
                    const m = asmLines[i].match(/^#line\s+(\d+)\s+"([^"]+)"/);
                    if (m) { detectedPreprocessedPath = m[2]; break; }
                }

                if (!detectedPreprocessedPath) {
                    const asmDir = path.dirname(asmFile);
                    const asmBase = path.basename(asmFile, '.asm');
                    detectedPreprocessedPath = path.join(asmDir, asmBase + '.bas');
                }

                // Build preprocessedLine -> basLine map
                const preprocessedMap = {}; // preprocessedLineNumber -> basLineNumber
                try {
                    if (fs.existsSync(detectedPreprocessedPath)) {
                        const preContent = fs.readFileSync(detectedPreprocessedPath, 'utf8').split('\n');
                        for (let i = 0; i < preContent.length; i++) {
                            const l = preContent[i];
                            const mm = l.match(/BAS___(\d+)___/);
                            if (mm) {
                                const bas = parseInt(mm[1], 10);
                                preprocessedMap[i + 1] = bas; // preprocessed line numbers are 1-based
                            }
                        }
                        this.sendEvent(new OutputEvent(`[Debug] Preprocessed map loaded (${Object.keys(preprocessedMap).length} markers) from ${detectedPreprocessedPath}\n`));
                    } else {
                        this.sendEvent(new OutputEvent(`[Debug] No se encontró preprocessed file para mapear: ${detectedPreprocessedPath}\n`, 'stderr'));
                    }
                } catch (e) {
                    this.sendEvent(new OutputEvent(`[Debug] Error leyendo preprocessed file: ${e.message}\n`, 'stderr'));
                }

                // Now parse ASM and map asm lines to preprocessed lines using #line directives
                let currentPreLine = null;
                for (let i = 0; i < asmLines.length; i++) {
                    const line = asmLines[i];
                    const asmLineNumber = i + 1;

                    const mLine = line.match(/^#line\s+(\d+)\s+"([^"']+)"/);
                    if (mLine) {
                        const pLine = parseInt(mLine[1], 10);
                        const pFile = mLine[2];
                        if (path.basename(pFile) === path.basename(detectedPreprocessedPath) || pFile === detectedPreprocessedPath) {
                            currentPreLine = pLine;
                        } else {
                            currentPreLine = null;
                        }
                        continue;
                    }

                    if (currentPreLine && line.trim() && !line.trim().startsWith(';') && !line.trim().toUpperCase().startsWith('END')) {
                        let basLine = null;
                        if (preprocessedMap[currentPreLine]) {
                            basLine = preprocessedMap[currentPreLine];
                        } else {
                            const SEARCH_BACK_MAX = 20;
                            for (let d = 0; d <= SEARCH_BACK_MAX && !basLine; d++) {
                                const cand = currentPreLine - d;
                                if (cand > 0 && preprocessedMap[cand]) basLine = preprocessedMap[cand];
                            }
                        }
                        if (basLine) {
                            if (!this._lineMap[basLine]) this._lineMap[basLine] = [];
                            this._lineMap[basLine].push(asmLineNumber);
                            this._reverseLineMap[asmLineNumber] = basLine;
                        }
                    }
                }
            }
            
            // Mostrar resumen del mapeo
            const totalBorielLines = Object.keys(this._lineMap).length;
            let totalAsmLines = 0;
            for (const basLine in this._lineMap) {
                totalAsmLines += this._lineMap[basLine].length;
            }
            
            this.sendEvent(new OutputEvent(`[Debug] ✓ Line map generado: ${totalBorielLines} líneas Boriel → ${totalAsmLines} líneas ASM\n`));
            
            // Mostrar algunas líneas como ejemplo
            const firstLines = Object.keys(this._lineMap).slice(0, 3);
            firstLines.forEach(basLine => {
                const asmLines = this._lineMap[basLine];
                this.sendEvent(new OutputEvent(`[Debug]   Línea ${basLine}: ${asmLines.length} instrucciones ASM\n`));
            });
            
        } catch (e) {
            this.sendEvent(new OutputEvent(`[Debug] ⚠ Error generando line map: ${e.message}\n`, 'stderr'));
        }
    }

    /**
     * Intentar reproducir la cinta remotamente y ejecutar. Evita repetir intentos.
     */
    /**
     * Load and run the TAP file using smartload command.
     * This is called after breakpoints are set.
     * 
     * Per ZEsarUX author recommendation:
     * 1. enter-cpu-step (enters step mode)
     * 2. smartload (loads program, stays in step mode)
     * 3. run (executes until breakpoint)
     */

    /**
     * Re-resuelve todos los breakpoints del usuario usando _fileAddrMap (que se construye
     * DESPUÉS de setBreakPointsRequest). Limpia los pendientes antiguos y los reinstala
     * con las direcciones reales del linemap.
     * Usa normalización de rutas para evitar problemas de mayúsculas/separadores en Windows.
     */
    async _reResolveUserBreakpoints() {
        if (!this._userBreakpointsByFile) {
            this.sendEvent(new OutputEvent(`[Debug] _reResolveUserBreakpoints: sin breakpoints de usuario\n`));
            return;
        }
        if (!this._fileAddrMap || Object.keys(this._fileAddrMap).length === 0) {
            this.sendEvent(new OutputEvent(`[Debug] _reResolveUserBreakpoints: _fileAddrMap vacío\n`, 'stderr'));
            return;
        }

        // Limpiar breakpoints pendientes con direcciones posiblemente erróneas
        this._pendingBreakpoints = [];

        // Normalizar claves de _fileAddrMap para comparación case-insensitive en Windows
        const normMap = {};
        for (const [k, v] of Object.entries(this._fileAddrMap)) {
            normMap[path.normalize(k).toLowerCase()] = { absPath: k, lines: v };
        }

        this.sendEvent(new OutputEvent(`[Debug] _reResolveUserBreakpoints: ${Object.keys(this._userBreakpointsByFile).length} archivos con breakpoints, ${Object.keys(normMap).length} archivos en mapa\n`));
        for (const k of Object.keys(normMap)) {
            this.sendEvent(new OutputEvent(`[Debug]   fileAddrMap key: ${k}\n`));
        }

        for (const [filePath, lineSet] of Object.entries(this._userBreakpointsByFile)) {
            const normalizedPath = path.normalize(filePath).toLowerCase();
            const entry = normMap[normalizedPath];

            this.sendEvent(new OutputEvent(`[Debug] Resolviendo breakpoints de ${path.basename(filePath)} (${Array.from(lineSet).join(',')})\n`));
            this.sendEvent(new OutputEvent(`[Debug]   lookup key: ${normalizedPath} → ${entry ? 'ENCONTRADO' : 'NO ENCONTRADO'}\n`));

            if (!entry) {
                this.sendEvent(new OutputEvent(`[Debug] ⚠ Sin mapa de direcciones para ${path.basename(filePath)}\n`, 'stderr'));
                continue;
            }

            for (const line of lineSet) {
                const addr = entry.lines[line];
                if (addr === undefined) {
                    this.sendEvent(new OutputEvent(`[Debug] ⚠ Sin dirección para ${path.basename(filePath)}:${line}\n`, 'stderr'));
                    continue;
                }
                const addrNum = parseInt(addr, 10);
                const addrToken = `${addrNum.toString(16).toUpperCase()}h`;
                this.sendEvent(new OutputEvent(`[Debug] ✓ Breakpoint ${path.basename(filePath)}:${line} → 0x${addrNum.toString(16).toUpperCase()}\n`));
                try {
                    const installed = await this._installBreakpoint(addrToken, line);
                    if (!installed) {
                        this.sendEvent(new OutputEvent(`[Debug] ⚠ No se pudo instalar breakpoint en ${addrToken}, encolando\n`, 'stderr'));
                        this._pendingBreakpoints.push({ addrToken, clientLine: line });
                    }
                } catch (e) {
                    this.sendEvent(new OutputEvent(`[Debug] ⚠ Error instalando breakpoint ${addrToken}: ${e.message}\n`, 'stderr'));
                    this._pendingBreakpoints.push({ addrToken, clientLine: line });
                }
            }
        }
    }

    async _tryPlayTapeThenRun(targetAddr) {
        if (this._tapeAutoPlayed) return;
        this._tapeAutoPlayed = true;

        try {
            this.sendEvent(new OutputEvent(`[Debug] Preparando para cargar TAP...\n`));
            
            // Use smartload command to load the TAP file
            const tapPath = this._program || '';
            if (!tapPath) {
                this.sendEvent(new OutputEvent(`[Debug] Error: No hay ruta de programa TAP\n`, 'stderr'));
                return;
            }
            
            // Secuencia recomendada por el autor de ZEsarUX:
            // 1) enter-cpu-step   → pone el emulador en modo paso a paso
            // 2) enable-breakpoints → ahora sí responde correctamente
            // 3) load-source-code  → carga los marcadores de línea del ASM
            // 4) set-breakpoint    → establece el breakpoint de entrada
            // 5) smartload         → carga el TAP (mantiene el modo step)
            // 6) run               → ejecuta hasta el breakpoint

            this.sendEvent(new OutputEvent(`[Debug] PASO 1: Entrando en modo step...\n`));
            const stepResp = await this._sendCommandAndWait('enter-cpu-step');
            this.sendEvent(new OutputEvent(`[Debug] enter-cpu-step: ${String(stepResp).replace(/\n/g,' ')}\n`));
            await this._waitForZesarux(300);

            this.sendEvent(new OutputEvent(`[Debug] PASO 2: Habilitando breakpoints...\n`));
            this._breakpointsEnabled = false;
            try {
                await this._ensureBreakpointsEnabled();
                this.sendEvent(new OutputEvent(`[Debug] Breakpoints: ${this._breakpointsEnabled ? '✓ habilitados' : '✗ no habilitados'}\n`));
            } catch (e) {
                this.sendEvent(new OutputEvent(`[Debug] ⚠ enable-breakpoints falló: ${e.message}\n`, 'stderr'));
            }

            // PASO 3: Cargar símbolos del ASM
            const asmFileForLoad = this._asmFile;
            if (asmFileForLoad && fs.existsSync(asmFileForLoad)) {
                const asmFileNormalized = asmFileForLoad.replace(/\\/g, '/');
                this.sendEvent(new OutputEvent(`[Debug] PASO 3: Cargando símbolos: ${asmFileNormalized}\n`));
                try {
                    const lscResp = await this._sendCommandAndWait(`load-source-code ${asmFileNormalized}`);
                    const lscStr = String(lscResp || '').trim();
                    if (lscStr.toLowerCase().includes('error')) {
                        this.sendEvent(new OutputEvent(`[Debug] ⚠ load-source-code respondió: ${lscStr}\n`, 'stderr'));
                    } else {
                        this.sendEvent(new OutputEvent(`[Debug] ✓ Símbolos cargados: ${lscStr}\n`));
                    }
                } catch (e) {
                    this.sendEvent(new OutputEvent(`[Debug] ⚠ load-source-code falló: ${e.message}\n`, 'stderr'));
                }
            } else {
                this.sendEvent(new OutputEvent(`[Debug] PASO 3: Sin ASM que cargar (${asmFileForLoad || 'no definido'})\n`));
            }

            // PASO 3b: Re-resolver breakpoints del usuario con las direcciones reales
            // (cuando setBreakPointsRequest llegó antes de que _fileAddrMap existiera,
            //  los breakpoints quedaron pendientes con direcciones estimadas; ahora los
            //  volvemos a calcular con el mapa correcto y los instalamos en ZEsarUX)
            try {
                await this._reResolveUserBreakpoints();
                this.sendEvent(new OutputEvent(`[Debug] Breakpoints de usuario re-resueltos e instalados\n`));
            } catch (e) {
                this.sendEvent(new OutputEvent(`[Debug] Error resolviendo breakpoints de usuario: ${e.message}\n`, 'stderr'));
            }

            // PASO 4: Establecer breakpoint de entrada
            const tapPathNormalized = tapPath.replace(/\\/g, '/');
            if (targetAddr && targetAddr !== 0) {
                const hexNoPrefix = targetAddr.toString(16).toUpperCase();
                this.sendEvent(new OutputEvent(`[Debug] PASO 4: Estableciendo breakpoint en ${hexNoPrefix}H...\n`));
                try {
                    const cmd = `set-breakpoint 2 PC=${hexNoPrefix}H`;
                    const resp = await this._sendCommandAndWait(cmd);
                    const lower = String(resp || '').toLowerCase();
                    if (lower.includes('unknown command') || lower.includes('error')) {
                        await this._sendCommand(`break set ${hexNoPrefix}H`);
                    }
                    this.sendEvent(new OutputEvent(`[Debug] ✓ Breakpoint en ${hexNoPrefix}H\n`));
                } catch (e) {
                    this.sendEvent(new OutputEvent(`[Debug] ⚠ Breakpoint falló: ${e.message}\n`));
                }
            }

            this.sendEvent(new OutputEvent(`[Debug] PASO 5: Ejecutando smartload...\n`));
            const smartloadResp = await this._sendCommandAndWait(`smartload ${tapPathNormalized}`);
            const smartloadRespStr = String(smartloadResp).replace(/\n/g,' ');
            this.sendEvent(new OutputEvent(`[Debug] smartload: ${smartloadRespStr}\n`));
            if (smartloadRespStr.toLowerCase().includes('error')) {
                throw new Error('smartload failed: ' + smartloadRespStr);
            }
            await this._waitForZesarux(300);
            
            // PASO 6: run — espera hasta que ZEsarUX pare en un breakpoint (hasta 30s)
            this.sendEvent(new OutputEvent(`[Debug] Ejecutando run (esperando breakpoint)...\n`));
            const runResp = await this._sendCommandAndWait('run', 30000);
            this.sendEvent(new OutputEvent(`[Debug] run detenido: ${String(runResp).replace(/\n/g,' ').slice(0, 120)}\n`));

            // Mapear PC de la respuesta a archivo/línea Boriel
            const runPcMatch = String(runResp).match(/PC=([0-9A-Fa-f]{1,4})/i);
            if (runPcMatch) {
                const stoppedPc = parseInt(runPcMatch[1], 16);
                this._lastPC = stoppedPc;
                const mapped = this._pcToFileAndLine(stoppedPc);
                if (mapped) {
                    this._lastBasLine = mapped.line;
                    this._lastSourceFile = mapped.file;
                    this.sendEvent(new OutputEvent(`[Debug] Parado en ${path.basename(mapped.file)}:${mapped.line} (PC=0x${stoppedPc.toString(16).toUpperCase()})\n`));
                } else {
                    this.sendEvent(new OutputEvent(`[Debug] PC=0x${stoppedPc.toString(16).toUpperCase()} no mapeado a línea Boriel\n`));
                }
            }
            
            // The emulator has stopped at a breakpoint
            this.sendEvent(new OutputEvent(`[Debug] Programa cargado y detenido en breakpoint\n`));
            
        } catch (e) {
            this.sendEvent(new OutputEvent(`[Debug] Error durante smartload: ${e.message}\n`, 'stderr'));
            // Fallback: try manual sequence
            try {
                this.sendEvent(new OutputEvent(`[Debug] Intentando secuencia alternativa...\n`));
                await this._sendCommandAndWait('enter-cpu-step');
                await this._waitForZesarux(200);
                await this._sendCommandAndWait('cpu-step');
                await this._waitForZesarux(100);
                await this._sendCommand('run');
            } catch (seqErr) {
                this.sendEvent(new OutputEvent(`[Debug] Error al ejecutar secuencia alternativa: ${seqErr.message}\n`, 'stderr'));
            }
        }
    }

    /**
     * Envía un comando y espera una respuesta de ZEsarUX antes de continuar.
     * Útil para comandos como enter-cpu-step donde queremos sincronización real.
     */
    async _sendCommandAndWait(command, timeoutMs = 5000) {
        // ZEsarUX ZRCP ends every response with a "command>" or "command@cpu-step>" prompt.
        // We accumulate data until we see that prompt, then resolve with the accumulated text.
        return new Promise((resolve, reject) => {
            if (!this._debugSocket || this._debugSocket.destroyed) {
                reject(new Error('No hay conexión con ZEsarUX'));
                return;
            }
            this.sendEvent(new OutputEvent(`> ${command}\n`, 'console'));
            let resolved = false;
            let accumulated = '';
            // Regex that matches the ZRCP command prompt at end of response
            const promptRe = /command(?:@[^\n>]*)?>[ \t]*$/m;

            const finish = (txt) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                try { this._debugSocket.removeListener('data', dataListener); } catch (e) {}
                // Extract meaningful content: everything before the final prompt line
                const clean = txt.replace(/command(?:@[^\n>]*)?>[ \t]*$/m, '').trim();
                if (clean) this.sendEvent(new OutputEvent(`< ${clean}\n`, 'console'));
                // Actualizar PC si la respuesta contiene información de registros
                const pcMatch = txt.match(/PC=([0-9A-Fa-f]{1,4})/);
                if (pcMatch) {
                    const pc = parseInt(pcMatch[1], 16);
                    if (pc !== this._lastPC) {
                        this._previousPC = this._lastPC;
                        this._lastPC = pc;
                    }
                }
                resolve(clean || txt);
            };

            const dataListener = (data) => {
                try {
                    accumulated += data.toString();
                    // Resolve as soon as we see the end-of-response prompt
                    if (promptRe.test(accumulated)) {
                        finish(accumulated);
                    }
                } catch (e) {
                    if (!resolved) finish('');
                }
            };

            // Timeout fallback – resolve with whatever we have accumulated
            const timer = setTimeout(() => {
                if (!resolved) {
                    this.sendEvent(new OutputEvent(`< (timeout: ${JSON.stringify(accumulated.slice(0,80))})\n`, 'console'));
                    finish(accumulated);
                }
            }, timeoutMs);

            this._debugSocket.on('data', dataListener);
            this._debugSocket.write(command + '\n');
        });
    }

    /**
     * Read memory from ZEsarUX at addrNum (decimal) for length bytes.
     * Tries the 'read-memory' command and parses returned hex bytes.
     * Returns an array of byte values (numbers) or null on failure.
     */
    async _readMemoryZesarux(addrNum, length = 1) {
        if (!this._debugSocket || this._debugSocket.destroyed) return null;
        try {
            const hex = parseInt(addrNum, 10).toString(16).toUpperCase().padStart(4, '0');
            const cmd = `read-memory ${hex}H ${length}`;
            this.sendEvent(new OutputEvent(`> ${cmd}\n`, 'console'));
            const resp = await this._sendCommandAndWait(cmd);
            const txt = String(resp || '').trim();

            // Common response formats vary. Extract hex byte pairs from the response.
            // Example responses we try to handle: "00 1A 2B", "0x00 0x1A", "001A2B", etc.
            const bytes = [];
            // First, try to find sequences of 2-hex-digit tokens
            const mPairs = txt.match(/\b[0-9A-Fa-f]{2}\b/g);
            if (mPairs && mPairs.length > 0) {
                for (let i = 0; i < Math.min(mPairs.length, length); i++) {
                    bytes.push(parseInt(mPairs[i], 16));
                }
                return bytes;
            }

            // Next, try to find longer hex and split
            const mLong = txt.match(/\b[0-9A-Fa-f]+\b/);
            if (mLong && mLong[0].length >= 2) {
                const s = mLong[0];
                // If the string length is even, split into bytes
                if (s.length % 2 === 0) {
                    for (let i = 0; i < Math.min(s.length / 2, length); i++) {
                        const hexPart = s.substr(i * 2, 2);
                        bytes.push(parseInt(hexPart, 16));
                    }
                    return bytes;
                }
            }

            // If nothing parsed, return null
            return null;
        } catch (e) {
            this.sendEvent(new OutputEvent(`[Debug] readMemory error: ${e.message}\n`, 'stderr'));
            return null;
        }
    }

    // Dump a compact diagnostics summary about line maps to the debug output
    async _dumpLineMapDiagnostics(sampleAsmLine) {
        try {
            this.sendEvent(new OutputEvent(`[Debug][DIAG] --- LineMap diagnostics ---\n`));
            this.sendEvent(new OutputEvent(`[Debug][DIAG] lastPC=${this._lastPC || 'n/a'} lastAsmLine=${this._lastAsmLine || 'n/a'} sampleAsmLine=${sampleAsmLine || 'n/a'}\n`));

            const asmFile = this._asmFile || 'n/a';
            this.sendEvent(new OutputEvent(`[Debug][DIAG] asmFile=${asmFile}\n`));

            const lmCount = this._lineMap ? Object.keys(this._lineMap).length : 0;
            const revCount = this._reverseLineMap ? Object.keys(this._reverseLineMap).length : 0;
            const addrCount = this._asmLineToAddress ? Object.keys(this._asmLineToAddress).length : 0;
            this.sendEvent(new OutputEvent(`[Debug][DIAG] _lineMap entries=${lmCount} _reverseLineMap entries=${revCount} _asmLineToAddress entries=${addrCount}\n`));

            // Show first few mappings from lineMap
            if (this._lineMap) {
                const keys = Object.keys(this._lineMap).slice(0, 8);
                for (const k of keys) {
                    const v = this._lineMap[k];
                    this.sendEvent(new OutputEvent(`[Debug][DIAG] bas ${k} -> asmCount=${v.length} sampleAsm=${v.slice(0,4).join(',')}\n`));
                }
            } else {
                this.sendEvent(new OutputEvent(`[Debug][DIAG] _lineMap is empty\n`));
            }

            // Show reverse map sample
            if (this._reverseLineMap) {
                const revKeys = Object.keys(this._reverseLineMap).slice(0, 8);
                for (const rk of revKeys) {
                    this.sendEvent(new OutputEvent(`[Debug][DIAG] asm ${rk} -> bas ${this._reverseLineMap[rk]}\n`));
                }
            } else {
                this.sendEvent(new OutputEvent(`[Debug][DIAG] _reverseLineMap is empty\n`));
            }

            // If asmLineToAddress exists, show mapping for the nearby asm lines
            if (this._asmLineToAddress) {
                const sample = sampleAsmLine || this._lastAsmLine || Object.keys(this._asmLineToAddress)[0];
                if (sample) {
                    const s = parseInt(sample, 10);
                    const entries = [];
                    for (let d = -3; d <= 3; d++) {
                        const ln = s + d;
                        if (ln > 0 && this._asmLineToAddress[ln]) entries.push(`${ln}->0x${parseInt(this._asmLineToAddress[ln],10).toString(16)}`);
                    }
                    this.sendEvent(new OutputEvent(`[Debug][DIAG] _asmLineToAddress nearby: ${entries.join(',') || 'n/a'}\n`));
                }
            } else {
                this.sendEvent(new OutputEvent(`[Debug][DIAG] _asmLineToAddress missing\n`));
            }

            this.sendEvent(new OutputEvent(`[Debug][DIAG] --- end diagnostics ---\n`));
        } catch (e) {
            // Do not let diagnostics crash the adapter
            try { this.sendEvent(new OutputEvent(`[Debug][DIAG] Error dumping diagnostics: ${e.message}\n`, 'stderr')); } catch (e2) {}
        }
    }

    /**
     * Ejecuta automáticamente una secuencia de breakpoints basada en
     * this._basLineToAddress. Para cada línea Boriel en orden ascendente:
     *  - establece un breakpoint temporal en la dirección guardada
     *  - ejecuta 'run' (asegurando previamente smartload/enter-cpu-step si es necesario)
     *  - espera hasta que el emulador alcance la dirección o timeout
     *  - elimina el breakpoint y continúa con la siguiente línea
     *
     * Esta rutina no bloquea el hilo principal del adaptador y tiene limpieza
     * en caso de errores.
     */
    async _startSequentialBasBreakpointSequence() {
        try {
            if (!this._basLineToAddress || Object.keys(this._basLineToAddress).length === 0) {
                // intentar construir el mapa si faltara
                if (this._asmFile && fs.existsSync(this._asmFile)) {
                    try { await this._buildBasLineAddressMap(this._asmFile); } catch (e) { this.sendEvent(new OutputEvent(`[Debug] No se pudo construir basLine->addr map: ${e.message}\n`, 'stderr')); }
                }
            }

            if (!this._basLineToAddress || Object.keys(this._basLineToAddress).length === 0) {
                this.sendEvent(new OutputEvent(`[Debug] Secuencia automática abortada: no hay mapa basLine->address disponible\n`, 'stderr'));
                return;
            }

            // ordenar las líneas Boriel en orden ascendente
            const basKeys = Object.keys(this._basLineToAddress).map(k => parseInt(k,10)).sort((a,b)=>a-b);
            if (basKeys.length === 0) return;

            this.sendEvent(new OutputEvent(`[Debug] Iniciando secuencia automática de ${basKeys.length} breakpoints (basLine -> address)\n`));

            // Intentar smartload/sync sólo una vez antes del primer run
            let played = this._tapeAutoPlayed || false;

            for (const basLine of basKeys) {
                try {
                    const addr = this._basLineToAddress[basLine];
                    if (!addr) { this.sendEvent(new OutputEvent(`[Debug] Saltando Boriel ${basLine}: sin dirección\n`)); continue; }

                    const addrNum = parseInt(addr, 10);
                    const addrToken = `${addrNum.toString(16).toUpperCase()}h`;

                    // instalar breakpoint temporal
                    try { await this._ensureBreakpointsEnabled(); } catch (e) {}
                    // Use sequence breakpoint slot 1 as the authoritative slot
                    const installed = await this._setSequenceBreakpoint(addrNum);
                    if (!installed) {
                        this.sendEvent(new OutputEvent(`[Debug] No se pudo instalar breakpoint de secuencia en ${addrToken} para Boriel ${basLine}; saltando\n`, 'stderr'));
                        continue;
                    }

                    this.sendEvent(new OutputEvent(`[Debug] Breakpoint instalado en ${addrToken} para Boriel ${basLine} -> ejecutando run\n`));

                    // Si aún no hemos hecho smartload/play, intentarlo antes del primer run
                    if (!played) {
                        try {
                            await this._tryPlayTapeThenRun(addrNum);
                            // _tryPlayTapeThenRun lanzará run por sí mismo, así que esperar a que el breakpoint sea alcanzado
                            played = true;
                        } catch (e) {
                            // Si falla, caeremos a la ruta manual: enviar run
                            this.sendEvent(new OutputEvent(`[Debug] smartload/run inicial falló: ${e.message}\n`, 'stderr'));
                            await this._sendCommand('run');
                        }
                    } else {
                        // Ya se ejecutó smartload/play anteriormente, mandar run normalmente
                        await this._sendCommand('run');
                    }

                    // Esperar explícitamente hasta que el PC alcance la dirección objetivo o hasta timeout
                    const timeoutMs = 10000;
                    const deadline = Date.now() + timeoutMs;
                    let reached = false;
                    while (Date.now() < deadline) {
                        if (this._lastPC && parseInt(this._lastPC,10) === addrNum) { reached = true; break; }
                        if (this._stopped && this._lastPC) { reached = (parseInt(this._lastPC,10) === addrNum) || true; break; }
                        await this._waitForZesarux(50);
                    }

                    if (!reached) {
                        this.sendEvent(new OutputEvent(`[Debug] Timeout esperando breakpoint en 0x${addrNum.toString(16).toUpperCase()} para Boriel ${basLine} (último PC: ${this._lastPC || 'n/a'})\n`, 'stderr'));
                    } else {
                        this.sendEvent(new OutputEvent(`[Debug] Breakpoint alcanzado en 0x${addrNum.toString(16).toUpperCase()} para Boriel ${basLine}\n`));
                    }

                    // limpiar breakpoint temporal
                    try { await this._removeBreakpointByAddr(addrNum); } catch (e) { this.sendEvent(new OutputEvent(`[Debug] No se pudo eliminar breakpoint temporal ${addrToken}: ${e.message}\n`, 'stderr')); }

                    // Pequeña pausa antes de continuar con el siguiente
                    await this._waitForZesarux(50);
                } catch (inner) {
                    this.sendEvent(new OutputEvent(`[Debug] Error en secuencia para Boriel ${basLine}: ${inner.message}\n`, 'stderr'));
                }
            }

            this.sendEvent(new OutputEvent(`[Debug] Secuencia automática completada\n`));
        } catch (e) {
            this.sendEvent(new OutputEvent(`[Debug] Error iniciando secuencia automática: ${e.message}\n`, 'stderr'));
        }
    }

    /**
     * Convierte una línea de código Boriel a la primera línea ASM correspondiente
     */
    _basLineToAsmLine(basLine) {
        if (!this._lineMap || !this._lineMap[basLine]) {
            return null;
        }
        return this._lineMap[basLine][0]; // Retorna la primera línea ASM
    }

    /**
     * Helper function to extract Boriel line number from reverse line map entry
     * Handles both old format (number) and new format ({ borielLine, sourceFile, isEndOfSub })
     */
    _getBorielLineFromMapEntry(mapEntry) {
        if (typeof mapEntry === 'object' && mapEntry !== null) {
            return mapEntry.borielLine || null;
        }
        return mapEntry || null;
    }

    /**
     * Convierte una línea ASM a la línea de código Boriel correspondiente
     */
    _asmLineToBAsLine(asmLine) {
        if (!this._reverseLineMap) {
            return null;
        }
        const entry = this._reverseLineMap[asmLine];
        return this._getBorielLineFromMapEntry(entry);
    }

    /**
     * Obtiene todas las líneas ASM correspondientes a una línea Boriel
     */
    _getAllAsmLinesForBas(basLine) {
        if (!this._lineMap || !this._lineMap[basLine]) {
            return [];
        }
        return this._lineMap[basLine];
    }

    async _connectToZesarux(port, maxRetries = 5) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await this._attemptConnection(port);
                // Al conectar, habilitar breakpoints y aplicar breakpoints pendientes (si los hay)
                try {
                    await this._ensureBreakpointsEnabled();
                } catch (e) {
                    // No fatal
                }
                try {
                    await this._flushPendingBreakpoints();
                } catch (e) {
                    this.sendEvent(new OutputEvent(`⚠ Error aplicando breakpoints pendientes: ${e.message}\n`, 'stderr'));
                }
                return;
            } catch (err) {
                if (i < maxRetries - 1) {
                    this.sendEvent(new OutputEvent(`Reintento ${i + 1}/${maxRetries}...\n`));
                    await this._waitForZesarux(1000);
                } else {
                    throw err;
                }
            }
        }
    }

    /**
     * Busca la línea ASM correspondiente a una dirección física (addr).
     * Devuelve el número de línea ASM (1-based) o null si no se encuentra.
     */
    _addrToAsmLine(addr) {
        if (!this._asmLineToAddress) return null;
        // buscar coincidencia exacta
        for (const [lnStr, a] of Object.entries(this._asmLineToAddress)) {
            if (parseInt(a, 10) === addr) return parseInt(lnStr, 10);
        }
        // buscar la entrada más cercana por debajo
        let bestLine = null;
        let bestAddr = -1;
        for (const [lnStr, a] of Object.entries(this._asmLineToAddress)) {
            const aa = parseInt(a, 10);
            const ln = parseInt(lnStr, 10);
            if (aa <= addr && aa > bestAddr) { bestAddr = aa; bestLine = ln; }
        }
        return bestLine;
    }

    /**
     * Return the next user-set Boriel line > currentBasLine for the active source (this._sourceFile).
     */
    _getNextUserBreakpointAfter(currentBasLine) {
        try {
            if (!this._sourceFile) return null;
            const s = this._userBreakpointsByFile && this._userBreakpointsByFile[this._sourceFile];
            if (!s || s.size === 0) return null;
            const arr = Array.from(s).map(n => parseInt(n,10)).filter(n=>!isNaN(n)).sort((a,b)=>a-b);
            for (const n of arr) {
                if (n > currentBasLine) return n;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    async _attemptConnection(port) {
        return new Promise((resolve, reject) => {
            this._debugSocket = new net.Socket();
            
            let connected = false;
            const timeout = setTimeout(() => {
                if (!connected) {
                    this._debugSocket.destroy();
                    reject(new Error('Timeout al conectar'));
                }
            }, 3000);

            // Listener permanente para parsear PC de todas las respuestas
            this._debugSocket.on('data', (data) => {
                const txt = data.toString();
                // Extraer PC si está presente en la respuesta
                const pcMatch = txt.match(/PC=([0-9A-Fa-f]{1,4})/);
                if (pcMatch) {
                    const pc = parseInt(pcMatch[1], 16);
                    if (pc !== this._lastPC) {
                        this._previousPC = this._lastPC;
                        this._lastPC = pc;
                    }
                }
            });

            this._debugSocket.on('error', (err) => {
                clearTimeout(timeout);
                if (!connected) {
                    reject(err);
                }
            });

            this._debugSocket.on('close', () => {
                if (connected) {
                    this.sendEvent(new OutputEvent('Conexión con ZEsarUX cerrada\n'));
                    this.sendEvent(new TerminatedEvent());
                }
            });

            this._debugSocket.connect(port, 'localhost', async () => {
                clearTimeout(timeout);
                connected = true;
                this.sendEvent(new OutputEvent('[Debug] Socket conectado\n'));
                
                // Leer y descartar mensaje de bienvenida
                const welcomePromise = new Promise((res) => {
                    const welcomeListener = (data) => {
                        this.sendEvent(new OutputEvent(`< ${data.toString()}`, 'console'));
                        this._debugSocket.removeListener('data', welcomeListener);
                        res();
                    };
                    this._debugSocket.on('data', welcomeListener);
                });
                
                await Promise.race([
                    welcomePromise,
                    new Promise(r => setTimeout(r, 1000)) // timeout si no llega bienvenida
                ]);
                
                this.sendEvent(new OutputEvent('[Debug] Listo para enviar comandos\n'));
                resolve();
            });
        });
    }

    /**
     * Aplica breakpoints que se solicitaron antes de que hubiera conexión con ZEsarUX.
     */
    async _flushPendingBreakpoints() {
        if (!this._pendingBreakpoints || this._pendingBreakpoints.length === 0) return;
        if (!this._debugSocket || this._debugSocket.destroyed) {
            throw new Error('No hay conexión para aplicar breakpoints pendientes');
        }
        this.sendEvent(new OutputEvent(`Aplicando ${this._pendingBreakpoints.length} breakpoints pendientes...\n`));
                while (this._pendingBreakpoints.length > 0) {
            const pb = this._pendingBreakpoints.shift();
            try {
                const installed = await this._installBreakpoint(pb.addrToken, pb.clientLine);
                if (installed) {
                    this.sendEvent(new OutputEvent(`✓ Breakpoint aplicado en ${pb.addrToken} (línea Boriel: ${pb.clientLine})\n`));
                } else {
                    this.sendEvent(new OutputEvent(`✗ No se pudo aplicar breakpoint en ${pb.addrToken}\n`, 'stderr'));
                }
            } catch (err) {
                this.sendEvent(new OutputEvent(`✗ Falló al aplicar breakpoint ${pb.addrToken}: ${err.message}\n`, 'stderr'));
            }
        }
    }

    /**
     * Asegura que el emulador tenga habilitado el modo de breakpoints modernos (enable-breakpoints)
     * Si el comando no existe o falla, marca _breakpointsEnabled = false y se usará el método legacy.
     */
    async _ensureBreakpointsEnabled() {
        if (this._breakpointsEnabled) return;
        if (!this._debugSocket || this._debugSocket.destroyed) return;
        try {
            this.sendEvent(new OutputEvent(`> enable-breakpoints\n`, 'console'));
            const resp = await this._sendCommandAndWait('enable-breakpoints');
            const txt = String(resp || '').toLowerCase();
            if (txt.includes('already enabled')) {
                // ZEsarUX ya los tenía habilitados: éxito
                this._breakpointsEnabled = true;
                this.sendEvent(new OutputEvent(`✓ Breakpoints ya estaban habilitados\n`));
            } else if (txt.includes('unknown command') || txt.includes('not found') || (txt.includes('error') && !txt.includes('already'))) {
                this._breakpointsEnabled = false;
                this.sendEvent(new OutputEvent(`✗ enable-breakpoints no soportado o falló: ${String(resp).replace(/\n/g,' ')}\n`, 'stderr'));
            } else {
                this._breakpointsEnabled = true;
                this.sendEvent(new OutputEvent(`✓ Breakpoints habilitados: ${String(resp).replace(/\n/g,' ')}\n`));
            }
        } catch (e) {
            this._breakpointsEnabled = false;
            this.sendEvent(new OutputEvent(`✗ No se pudo confirmar enable-breakpoints: ${e.message}\n`, 'stderr'));
        }
    }

    /**
     * Instala un breakpoint en la dirección indicada. Si el emulador soporta
     * set-breakpoint, lo usará y almacenará el id; si no, usará el comando legacy 'break set'.
     * Devuelve truthy si se instaló (id o true), o false si falló.
     */
    async _installBreakpoint(addrToken, clientLine) {
        // addrToken expected like '8000h' or '1F3Ah'
        const hexPart = String(addrToken).replace(/h$/i, '');
        const addrNum = parseInt(hexPart, 16);
        if (isNaN(addrNum)) throw new Error('Dirección de breakpoint inválida: ' + addrToken);

        // Si el emulador soporta set-breakpoint, usarlo
        if (this._breakpointsEnabled && this._debugSocket && !this._debugSocket.destroyed) {
            const bpId = this._breakpointIdCounter++;
            // Intentar varios formatos: preferimos 0xHEX, luego HEX sin prefijo, luego decimal
            const hexNoPrefix = addrNum.toString(16).toUpperCase();
            // Usar el formato recomendado por el autor: PC=8000H
            const cmd = `set-breakpoint ${bpId} PC=${hexNoPrefix}H`;
            try {
                const resp = await this._sendCommandAndWait(cmd);
                const lower = String(resp || '').toLowerCase();
                if (lower.includes('unknown command') || lower.includes('error setting breakpoint') || lower.includes('error adding breakpoint') || lower.includes('error')) {
                    this.sendEvent(new OutputEvent(`⚠ set-breakpoint respondió con: ${resp.replace(/\n/g,' ')}; usando fallback legacy\n`, 'stderr'));
                    try {
                        await this._sendCommand(`break set ${addrToken}`);
                        return true;
                    } catch (e2) {
                        return false;
                    }
                }
                // éxito
                this._breakpointAddrToId.set(addrNum, bpId);
                this._breakpoints.set(bpId, { addr: addrNum, clientLine, remoteCmd: cmd });
                return bpId;
            } catch (e) {
                // fallback legacy
                try {
                    await this._sendCommand(`break set ${addrToken}`);
                    return true;
                } catch (e2) {
                    return false;
                }
            }
        }

        // Legacy path
        try {
            await this._sendCommand(`break set ${addrToken}`);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Dado un PC (número decimal), busca en _fileAddrMap el archivo fuente y la
     * línea Boriel que corresponden a esa dirección.
     * Devuelve { file: absPath, line: number } o null si no hay mapeo.
     */
    _pcToFileAndLine(pc) {
        if (!this._fileAddrMap) return null;
        for (const [absFile, lineMap] of Object.entries(this._fileAddrMap)) {
            for (const [lineStr, addr] of Object.entries(lineMap)) {
                if (parseInt(addr, 10) === pc) {
                    return { file: absFile, line: parseInt(lineStr, 10) };
                }
            }
        }
        // Fallback: buscar en _basLineToAddress (solo main file)
        if (this._basLineToAddress) {
            for (const [lineStr, addr] of Object.entries(this._basLineToAddress)) {
                if (parseInt(addr, 10) === pc) {
                    return { file: this._sourceFile, line: parseInt(lineStr, 10) };
                }
            }
        }
        return null;
    }

    _handleSocketData(data) {
        this._socketBuffer += data.toString();
        
        // Procesar líneas completas
        let lines = this._socketBuffer.split('\n');
        this._socketBuffer = lines.pop() || ''; // Guardar la última línea incompleta
        
        for (let line of lines) {
            this.sendEvent(new OutputEvent(`< ${line}\n`, 'console'));

            // Detectar hit en breakpoint (heurística) — ZEsarUX puede reportar distintos mensajes, intentamos cubrir varios formatos
            try {
                // Extraer PC de respuestas tipo: "< command@cpu-step> PC=05f5 SP=..."
                const pcMatch = line.match(/PC=([0-9A-Fa-f]{1,4})/);
                if (pcMatch) {
                    const pc = parseInt(pcMatch[1], 16);
                    // Solo actualizar si el PC realmente cambió
                    if (pc !== this._lastPC) {
                        this._previousPC = this._lastPC; // Guardar PC anterior
                        this._lastPC = pc;
                    }
                    // Parse other registers reported in the same line, e.g. SP=ff44 AF=5f89
                    const regs = {};
                    const regRe = /\b([A-Za-z]{1,3})=([0-9A-Fa-f]{1,4})\b/g;
                    let rm;
                    while ((rm = regRe.exec(line)) !== null) {
                        regs[rm[1].toUpperCase()] = parseInt(rm[2], 16);
                    }
                    // Always include PC
                    regs['PC'] = pc;
                    this._lastRegisters = regs;
                    
                    // Try to map PC to Boriel line using _basLineToAddress (authoritative)
                    let mappedBasLine = null;
                    if (this._basLineToAddress && Object.keys(this._basLineToAddress).length > 0) {
                        for (const [basLine, addr] of Object.entries(this._basLineToAddress)) {
                            if (parseInt(addr, 10) === pc) {
                                mappedBasLine = parseInt(basLine, 10);
                                this.sendEvent(new OutputEvent(`[Debug] Mapeo directo: PC=0x${pc.toString(16).toUpperCase()} -> línea Boriel ${mappedBasLine}\n`));
                                break;
                            }
                        }
                    }
                    
                    // Fallback: intentar mapear addr -> asm line -> bas line
                    if (!mappedBasLine) {
                        this.sendEvent(new OutputEvent(`[Debug] No hay mapeo directo para PC=0x${pc.toString(16).toUpperCase()}, usando fallback ASM...\n`));
                        const asmLine = this._addrToAsmLine(pc);
                        this._lastAsmLine = asmLine || null;
                        mappedBasLine = asmLine ? this._getBorielLineFromMapEntry(this._reverseLineMap[asmLine]) : null;
                        if (mappedBasLine) {
                            this.sendEvent(new OutputEvent(`[Debug] Fallback: ASM line ${asmLine} -> Boriel line ${mappedBasLine}\n`));
                        }
                    }
                    
                    // Only update the last mapped Boriel line when we're not currently stopped.
                    if (!this._stopped) {
                        this._lastBasLine = mappedBasLine;
                        if (this._lastBasLine) {
                            this.sendEvent(new OutputEvent(`[Debug] PC=0x${pc.toString(16).toUpperCase()} mapeado a Boriel line: ${this._lastBasLine}\n`));
                        } else {
                            this.sendEvent(new OutputEvent(`[Debug] PC=0x${pc.toString(16).toUpperCase()} (sin mapeo Boriel)\n`));
                        }
                    } else {
                        // We're stopped; avoid overwriting the mapped Boriel line to prevent races
                        this.sendEvent(new OutputEvent(`[Debug] PC update ignored while stopped: 0x${pc.toString(16).toUpperCase()}\n`));
                    }

                    // Si no hemos podido mapear la PC a una línea Boriel, establecer un breakpoint
                    // temporal en la PC actual y ejecutar. Esto ayuda cuando el mapeo falla o el ORG
                    // difiere de lo esperado.
                    // IMPORTANTE: NO hacer esto si ya estamos detenidos (this._stopped === true)
                    if (pc && !this._lastBasLine && !this._stopped) {
                        if (this._autoBpForPc !== pc) {
                            this._autoBpForPc = pc;
                            (async () => {
                                try {
                                    if (!this._debugSocket || this._debugSocket.destroyed) return;
                                    const addrToken = `${pc.toString(16).toUpperCase()}h`;
                                            try { await this._ensureBreakpointsEnabled(); } catch (e) {}
                                            const installed = await this._installBreakpoint(addrToken, null);
                                            if (installed) {
                                                this.sendEvent(new OutputEvent(`[Debug] Breakpoint automático establecido en ${addrToken} para PC no mapeado; ejecutando run...\n`));
                                                await this._sendCommand('run');
                                            } else {
                                                this.sendEvent(new OutputEvent(`[Debug] No se pudo establecer breakpoint automático en ${addrToken}\n`, 'stderr'));
                                            }
                                } catch (err) {
                                    this.sendEvent(new OutputEvent(`⚠ Error estableciendo breakpoint automático en PC 0x${pc.toString(16).toUpperCase()}: ${err.message}\n`, 'stderr'));
                                }
                            })();
                        }
                    }
                } else {
                    // También soportar líneas de disas como: "<   05F5 XOR C"
                    const disMatch = line.match(/^\s*<?\s*([0-9A-Fa-f]{3,4})\s+/);
                    if (disMatch) {
                        const pc = parseInt(disMatch[1], 16);
                        // Solo actualizar si el PC realmente cambió
                        if (pc !== this._lastPC) {
                            this._previousPC = this._lastPC; // Guardar PC anterior
                            this._lastPC = pc;
                        }
                        // clear/refresh registers map when seeing disassembly line (we don't have full regs here)
                        this._lastRegisters = Object.assign({}, this._lastRegisters || {}, { PC: pc });
                        
                        // Try to map PC to Boriel line using _basLineToAddress (authoritative)
                        let mappedBasLine = null;
                        if (this._basLineToAddress && Object.keys(this._basLineToAddress).length > 0) {
                            for (const [basLine, addr] of Object.entries(this._basLineToAddress)) {
                                if (parseInt(addr, 10) === pc) {
                                    mappedBasLine = parseInt(basLine, 10);
                                    break;
                                }
                            }
                        }
                        
                        // Fallback: usar ASM line mapping solo si no hay mapeo directo
                        if (!mappedBasLine) {
                            const asmLine = this._addrToAsmLine(pc);
                            this._lastAsmLine = asmLine || null;
                            mappedBasLine = asmLine ? this._getBorielLineFromMapEntry(this._reverseLineMap[asmLine]) : null;
                        }
                        
                        if (!this._stopped) this._lastBasLine = mappedBasLine;
                        // No mostrar mensaje aquí para evitar duplicados (ya se mostró arriba)
                    }
                }
                // Detectar respuestas de 'Unknown command' para comandos tape
                if (/Unknown command/i.test(line)) {
                    if (this._lastCommandSent && this._lastCommandSent.startsWith('tape')) {
                        this._tapePlayUnsupported = true;
                        this.sendEvent(new OutputEvent(`[Debug] El emulador respondió 'Unknown command' para '${this._lastCommandSent}'. Se omitirá 'tape play' en futuros intentos.\n`));
                    }
                }
                const low = line.toLowerCase();
                // Detectar si ZEsarUX requiere entrar en modo step antes de run
                if (/must first enter cpu-step/i.test(line) || low.includes('you must first enter cpu-step')) {
                    // Intentar una secuencia segura: enter-cpu-step -> cpu-step -> run
                    if (!this._cpuStepTried) {
                        this._cpuStepTried = true;
                        this.sendEvent(new OutputEvent(`[Debug] ZEsarUX requiere cpu-step antes de run; intentando enter-cpu-step + cpu-step + run...\n`));
                        (async () => {
                            try {
                                // send enter-cpu-step, give emulator a short time to switch mode
                                await this._sendCommand('enter-cpu-step');
                                await this._waitForZesarux(200);
                                // then step once
                                await this._sendCommand('cpu-step');
                                await this._waitForZesarux(100);
                                // finally, run
                                await this._sendCommand('run');
                            } catch (err) {
                                this.sendEvent(new OutputEvent(`[Debug] Error al intentar secuencia cpu-step+run: ${err.message}\n`, 'stderr'));
                            }
                        })();
                    }
                }
                // Detectar mensajes de carga de cinta y lanzar reproducción automática
                if ((low.includes('press break') || low.includes('loading') || low.includes('loading tape')) && !this._tapeAutoPlayed) {
                    // intentar reproducir la cinta y continuar la ejecución
                    this._tryPlayTapeThenRun().catch(() => {});
                }
                // Detectar breakpoint hit - formatos: "break 92C8h" o "Breakpoint fired: PC=92C8H"
                if ((low.includes('break') || low.includes('breakpoint')) && /[0-9a-fA-F]+h/i.test(line)) {
                    // extraer primera dirección hex encontrada
                    const m = line.match(/([0-9A-Fa-f]+)h/i);
                    if (m) {
                        const addr = parseInt(m[1], 16);
                        this.sendEvent(new OutputEvent(`[Debug] Detectado breakpoint hit en 0x${addr.toString(16).toUpperCase()}\n`));
                        
                        // Try to map using _basLineToAddress first (authoritative)
                        let basLine = null;
                        if (this._basLineToAddress && Object.keys(this._basLineToAddress).length > 0) {
                            for (const [bl, a] of Object.entries(this._basLineToAddress)) {
                                if (parseInt(a, 10) === addr) {
                                    basLine = parseInt(bl, 10);
                                    break;
                                }
                            }
                        }
                        
                        // Fallback: mapear addr -> asm line -> bas line
                        if (!basLine && this._asmLineToAddress) {
                            // buscar la línea ASM exacta o la más cercana
                            let asmLine = null;
                            for (const [lnStr, a] of Object.entries(this._asmLineToAddress)) {
                                if (parseInt(a, 10) === addr) { asmLine = parseInt(lnStr, 10); break; }
                            }
                            if (!asmLine) {
                                // buscar la entrada con dirección más cercana por debajo
                                let bestLine = null;
                                let bestAddr = -1;
                                for (const [lnStr, a] of Object.entries(this._asmLineToAddress)) {
                                    const aa = parseInt(a, 10);
                                    const ln = parseInt(lnStr, 10);
                                    if (aa <= addr && aa > bestAddr) { bestAddr = aa; bestLine = ln; }
                                }
                                asmLine = bestLine;
                            }

                            if (asmLine && this._reverseLineMap) {
                                basLine = this._getBorielLineFromMapEntry(this._reverseLineMap[asmLine]);
                            }
                        }

                        if (basLine) {
                            this._lastBasLine = basLine;
                            this.sendEvent(new OutputEvent(`[Debug] Breakpoint en línea Boriel: ${basLine}\n`));
                        }
                        
                        this._stopped = true;
                        this.sendEvent(new StoppedEvent('breakpoint', 1));
                    }
                }
            } catch (e) {
                // no bloquear por errores en la heurística
            }
        }
    }

    async _sendCommand(command) {
        return new Promise((resolve, reject) => {
            if (!this._debugSocket || this._debugSocket.destroyed) {
                reject(new Error('No hay conexión con ZEsarUX'));
                return;
            }

            this._lastCommandSent = command;
            this.sendEvent(new OutputEvent(`> ${command}\n`, 'console'));
            this._debugSocket.write(command + '\n');

            // Esperar un poco para la respuesta
            setTimeout(() => resolve(), 100);
        });
    }

    configurationDoneRequest(response, args) {
        this._configurationDone = true;
        this.sendResponse(response);
    }

    async disconnectRequest(response, args) {
        if (this._debugSocket) {
            await this._sendCommand('quit');
            this._debugSocket.destroy();
            this._debugSocket = null;
        }

        if (this._zesaruxProcess) {
            this._zesaruxProcess.kill();
            this._zesaruxProcess = null;
        }

        this.sendResponse(response);
    }

    async setBreakPointsRequest(response, args) {
    const sourcePath = args.source.path;
        const clientLines = args.lines || [];
        // Implementación: traducir líneas Boriel -> primeras líneas ASM -> dirección física
        const breakpoints = [];

        // Necesitamos tener cargado el mapeo de líneas
        if (!this._lineMap) {
            // No tenemos mapeo: no podemos verificar
            for (const line of clientLines) {
                breakpoints.push({ verified: false, line, message: 'No hay mapeo de líneas disponible' });
            }
            response.body = { breakpoints };
            this.sendResponse(response);
            return;
        }

        // Necesitamos el archivo .asm para calcular direcciones
        const asmFile = this._asmFile;
        let asmLines = null;
        if (asmFile && fs.existsSync(asmFile)) {
            asmLines = fs.readFileSync(asmFile, 'utf8').split('\n');
        }

        // Intentar generar un mapeo exacto ASM-line -> address usando zxbasm -d
        let asmLineToAddress = {};
        if (asmFile && fs.existsSync(asmFile)) {
            try {
                let zxbasmPath;
                let nullDevice;
                if (process.platform === 'win32') {
                    zxbasmPath = path.join(__dirname, 'bin', 'zxbasic-windows', 'zxbasm.exe');
                    nullDevice = 'nul';
                } else if (process.platform === 'linux') {
                    zxbasmPath = path.join(__dirname, 'bin', 'zxbasic-linux', 'zxbasm');
                    nullDevice = '/dev/null';
                } else if (process.platform === 'darwin') {
                    zxbasmPath = path.join(__dirname, 'bin', 'zxbasic-macos', 'zxbasm');
                    nullDevice = '/dev/null';
                }
                const zxbasmCmd = `${zxbasmPath} -d "${asmFile}" -o ${nullDevice}`;
                this.sendEvent(new OutputEvent(`[Debug] Ejecutando zxbasm para mapear ASM: ${zxbasmCmd}\n`));
                const execSync = require('child_process').execSync;
                const out = execSync(zxbasmCmd, { cwd: path.dirname(asmFile), encoding: 'utf8' });

                // Parsear líneas de debug que contienen direcciones: "<hex>h [<hex>h] ASM: ..."
                const addrLines = out.split('\n').filter(l => /\bASM:\s*/.test(l));
                const addresses = [];
                const addrRe = /([0-9A-Fa-f]+)h\s+\[([0-9A-Fa-f]+)h\]\s+ASM:/;
                for (const l of addrLines) {
                    const m = l.match(addrRe);
                    if (m) {
                        // use the bracketed value (m[2]) as the reliable assembled address
                        const hex = m[2];
                        addresses.push(parseInt(hex, 16));
                    }
                }

                // Mapear líneas ASM no vacías a direcciones en orden
                let addrIndex = 0;
                let currentOrg = 32768;
                for (let i = 0; i < asmLines.length; i++) {
                    const l = asmLines[i].trim();
                    // Detectar ORG
                    const mOrg = l.match(/^org\s+(0x[0-9a-fA-F]+|\d+)/);
                    if (mOrg) {
                        const v = mOrg[1];
                        currentOrg = v.startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10);
                    }
                    if (!l || l.startsWith(';') || l.startsWith('#') || l.toUpperCase().startsWith('END') || l.toUpperCase().startsWith('ASM')) continue;
                    if (addrIndex < addresses.length) {
                        asmLineToAddress[i + 1] = addresses[addrIndex++];
                    } else {
                        // si no hay más direcciones, estimar
                        asmLineToAddress[i + 1] = currentOrg + (i);
                    }
                }

                this.sendEvent(new OutputEvent(`[Debug] Mapas de direcciones ASM generados: ${Object.keys(asmLineToAddress).length} entradas\n`));
            } catch (e) {
                this.sendEvent(new OutputEvent(`[Debug] No se pudo generar mapa exacto con zxbasm: ${e.message}\n`));
            }
        }

        // Check if we have a connection before setting breakpoints
        let haveConnection = this._debugSocket && !this._debugSocket.destroyed;
        if (!haveConnection) {
            this.sendEvent(new OutputEvent(`[Debug] No hay conexión con ZEsarUX: posponiendo establecimiento de breakpoints hasta la conexión\n`));
        }

        for (const clientLine of clientLines) {
            // clientLine is the line in the Boriel source (1-based)

            // File-aware lookup: if we have per-file address map, use it directly
            if (this._fileAddrMap && sourcePath && this._fileAddrMap[sourcePath] && this._fileAddrMap[sourcePath][clientLine] !== undefined) {
                const addr = this._fileAddrMap[sourcePath][clientLine];
                const addrToken = `${addr.toString(16).toUpperCase()}h`;
                this.sendEvent(new OutputEvent(`[Debug] Breakpoint line ${clientLine} (${path.basename(sourcePath)}) -> 0x${addr.toString(16).toUpperCase()} (file-aware map)\n`));
                try {
                    if (haveConnection) {
                        try { await this._ensureBreakpointsEnabled(); } catch (e) {}
                        const installed = await this._installBreakpoint(addrToken, clientLine);
                        if (installed) {
                            breakpoints.push({ verified: true, line: clientLine });
                        } else {
                            this._pendingBreakpoints.push({ addrToken, clientLine });
                            breakpoints.push({ verified: false, line: clientLine, message: 'Breakpoint pendiente' });
                        }
                    } else {
                        this._pendingBreakpoints.push({ addrToken, clientLine });
                        breakpoints.push({ verified: false, line: clientLine, message: 'Breakpoint pendiente hasta conexión' });
                    }
                } catch (err) {
                    breakpoints.push({ verified: false, line: clientLine, message: `Error: ${err.message}` });
                }
                continue;
            }

            const basLine = String(clientLine);
            const asmLinesForBas = this._lineMap[basLine];
            if (!asmLinesForBas || asmLinesForBas.length === 0) {
                breakpoints.push({ verified: false, line: clientLine, message: 'No hay mapeo ASM para esta línea' });
                continue;
            }

            // Tomar la primera línea ASM correspondiente (números de línea ASM son 1-based)
            const asmLineNumber = asmLinesForBas[0];
            let addr = null;

            // Si zxbasm nos dio una dirección exacta para la línea ASM, úsala
            if (asmLineToAddress && asmLineToAddress[asmLineNumber] !== undefined) {
                addr = asmLineToAddress[asmLineNumber];
            } else if (asmLineToAddress && Object.keys(asmLineToAddress).length > 0) {
                // Fallback inteligente: buscar la línea ASM conocida más cercana por debajo
                let found = false;
                for (let k = asmLineNumber - 1; k >= 1; k--) {
                    if (asmLineToAddress[k] !== undefined) {
                        addr = asmLineToAddress[k] + (asmLineNumber - k);
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    // Si no encontramos ninguna línea conocida, usar la primera conocida y ajustar
                    const firstKey = Math.min(...Object.keys(asmLineToAddress).map(k => parseInt(k, 10)));
                    addr = asmLineToAddress[firstKey] + (asmLineNumber - firstKey);
                }
            } else {
                // Último recurso: estimar desde 0x8000 (32768) como base
                addr = 0x8000 + (asmLineNumber - 1);
            }

            try {
                const addrToken = `${addr.toString(16).toUpperCase()}h`;
                if (haveConnection) {
                    try { await this._ensureBreakpointsEnabled(); } catch (e) {}
                    const installed = await this._installBreakpoint(addrToken, clientLine);
                    if (installed) {
                        breakpoints.push({ verified: true, line: clientLine });
                    } else {
                        // if installation failed, enqueue for later
                        this._pendingBreakpoints.push({ addrToken, clientLine });
                        breakpoints.push({ verified: false, line: clientLine, message: 'Breakpoint pendiente hasta conexión con ZEsarUX' });
                    }
                } else {
                    // Guardar para aplicar más tarde cuando haya conexión
                    this._pendingBreakpoints.push({ addrToken, clientLine });
                    breakpoints.push({ verified: false, line: clientLine, message: 'Breakpoint pendiente hasta conexión con ZEsarUX' });
                }
            } catch (err) {
                breakpoints.push({ verified: false, line: clientLine, message: `Error estableciendo break: ${err.message}` });
            }
        }

        response.body = { breakpoints };
        // Store the user requested breakpoints for this source file so we can
        // use them later (e.g. entry breakpoint preference and run->next-breakpoint behavior)
        try {
            if (sourcePath) {
                this._userBreakpointsByFile[sourcePath] = new Set((clientLines || []).map(n => parseInt(n, 10)).filter(n => !isNaN(n)));
                this.sendEvent(new OutputEvent(`[Debug] User breakpoints for ${sourcePath}: ${Array.from(this._userBreakpointsByFile[sourcePath]).sort((a,b)=>a-b).join(',')}\n`));
            }
        } catch (e) {}

        this.sendResponse(response);
    }

    async continueRequest(response, args) {
        this._stopped = false;
        this.sendResponse(response);
        try {
            // If there is a user-set breakpoint after current Boriel line, set it as the next run target
            const current = this._lastBasLine || 0;
            const nextUser = this._getNextUserBreakpointAfter(current);
            if (nextUser && this._basLineToAddress && this._basLineToAddress[nextUser]) {
                const addrNum = this._basLineToAddress[nextUser];
                const hexNoPrefix = parseInt(addrNum,10).toString(16).toUpperCase();
                try { await this._ensureBreakpointsEnabled(); } catch (e) {}
                const cmd = `set-breakpoint 2 PC=${hexNoPrefix}H`;
                this.sendEvent(new OutputEvent(`[Debug] continue: instalando breakpoint temporal en siguiente breakpoint usuario Boriel ${nextUser} (addr ${hexNoPrefix}H)\n`));
                this.sendEvent(new OutputEvent(`> ${cmd}\n`, 'console'));
                try {
                    const resp = await this._sendCommandAndWait(cmd);
                    const lower = String(resp || '').toLowerCase();
                    if (lower.includes('unknown command') || lower.includes('error')) {
                        this.sendEvent(new OutputEvent(`[Debug] set-breakpoint no soportado, usando fallback\n`));
                        await this._sendCommand(`break set ${hexNoPrefix}H`);
                    }
                } catch (e) {
                    this.sendEvent(new OutputEvent(`[Debug] Error estableciendo breakpoint de continue: ${e.message}\n`, 'stderr'));
                }
            }

            // Ejecutar hasta el siguiente breakpoint y esperar respuesta (hasta 30s)
            const runResp = await this._sendCommandAndWait('run', 30000);
            this.sendEvent(new OutputEvent(`[Debug] continue detenido: ${String(runResp).replace(/\n/g,' ').slice(0, 120)}\n`));

            // Mapear PC de la respuesta
            const pcMatch = String(runResp).match(/PC=([0-9A-Fa-f]{1,4})/i);
            if (pcMatch) {
                const stoppedPc = parseInt(pcMatch[1], 16);
                this._lastPC = stoppedPc;
                const mapped = this._pcToFileAndLine(stoppedPc);
                if (mapped) {
                    this._lastBasLine = mapped.line;
                    this._lastSourceFile = mapped.file;
                    this.sendEvent(new OutputEvent(`[Debug] Parado en ${path.basename(mapped.file)}:${mapped.line} (PC=0x${stoppedPc.toString(16).toUpperCase()})\n`));
                }
            }

            this._stopped = true;
            this.sendEvent(new StoppedEvent('breakpoint', 1));
        } catch (e) {
            this.sendEvent(new OutputEvent(`[Debug] continueRequest error: ${e.message}\n`, 'stderr'));
        }
    }

    async pauseRequest(response, args) {
        await this._sendCommand('enter-cpu-step');
        this._stopped = true;
        this.sendResponse(response);
        this.sendEvent(new StoppedEvent('pause', 1));
    }

    /**
     * Helper function to check if either current PC or previous PC has isEndOfSub flag
     * This handles both scenarios: breakpoint directly on isEndOfSub line, and stepping into it
     */
    _checkIsEndOfSubAtCurrentOrPreviousPC() {
        if (!this._reverseLineMap) {
            this.sendEvent(new OutputEvent(`[Debug][_checkIsEndOfSubAtCurrentOrPreviousPC] No reverseLineMap available.\n`));
            return null;
        }

        this.sendEvent(new OutputEvent(`[Debug][_checkIsEndOfSubAtCurrentOrPreviousPC] Current PC: 0x${this._lastPC?.toString(16).toUpperCase()}, Previous PC: 0x${this._previousPC?.toString(16).toUpperCase()}\n`));

        // Check current PC first
        if (this._lastPC) {
            const currentAddrHex = `${this._lastPC.toString(16).toUpperCase()}H`;
            const currentMapEntry = this._reverseLineMap[currentAddrHex];
            this.sendEvent(new OutputEvent(`[Debug][_checkIsEndOfSubAtCurrentOrPreviousPC] Checking current ${currentAddrHex}: ${JSON.stringify(currentMapEntry)}\n`));
            if (currentMapEntry && currentMapEntry.isEndOfSub) {
                this.sendEvent(new OutputEvent(`[Debug][_checkIsEndOfSubAtCurrentOrPreviousPC] Found isEndOfSub=true at CURRENT PC 0x${this._lastPC.toString(16).toUpperCase()}\n`));
                return {
                    pc: this._lastPC,
                    mapEntry: currentMapEntry,
                    location: 'current'
                };
            }
        }

        // Check previous PC
        if (this._previousPC) {
            const previousAddrHex = `${this._previousPC.toString(16).toUpperCase()}H`;
            const previousMapEntry = this._reverseLineMap[previousAddrHex];
            this.sendEvent(new OutputEvent(`[Debug][_checkIsEndOfSubAtCurrentOrPreviousPC] Checking previous ${previousAddrHex}: ${JSON.stringify(previousMapEntry)}\n`));
            if (previousMapEntry && previousMapEntry.isEndOfSub) {
                this.sendEvent(new OutputEvent(`[Debug][_checkIsEndOfSubAtCurrentOrPreviousPC] Found isEndOfSub=true at PREVIOUS PC 0x${this._previousPC.toString(16).toUpperCase()}\n`));
                return {
                    pc: this._previousPC,
                    mapEntry: previousMapEntry,
                    location: 'previous'
                };
            }
        }

        this.sendEvent(new OutputEvent(`[Debug][_checkIsEndOfSubAtCurrentOrPreviousPC] No isEndOfSub found at current or previous PC.\n`));
        return null;
    }

    async nextRequest(response, args) {
        this.sendEvent(new OutputEvent(`[Debug][nextRequest] ===== STEP OVER REQUEST INITIATED =====\n`));
        // Step Over: ir a la siguiente línea Boriel
        try {
            // FAST EXIT OPTIMIZATION: Check if we're on the last line of a function (current OR previous PC)
            let usedFastExit = false;
            const endOfSubInfo = this._checkIsEndOfSubAtCurrentOrPreviousPC();
            
            if (endOfSubInfo) {
                this.sendEvent(new OutputEvent(`[Debug][nextRequest] isEndOfSub=true detected at ${endOfSubInfo.location} PC 0x${endOfSubInfo.pc.toString(16).toUpperCase()}. Using fast exit strategy.\n`));
                this.sendEvent(new OutputEvent(`[Debug][nextRequest] MapEntry: ${JSON.stringify(endOfSubInfo.mapEntry)}\n`));
                
                // IMPROVED STRATEGY: Use stepOutAddress if available for precise breakpoint + run
                if (endOfSubInfo.mapEntry.stepOutAddress) {
                    this.sendEvent(new OutputEvent(`[Debug][nextRequest] Using precise breakpoint + run strategy with stepOutAddress=0x${endOfSubInfo.mapEntry.stepOutAddress.toString(16).toUpperCase()}.\n`));
                    
                    try {
                        const returnAddrHex = endOfSubInfo.mapEntry.stepOutAddress.toString(16).toUpperCase();
                        
                        this.sendEvent(new OutputEvent(`[Debug][nextRequest] Setting breakpoint at stepOutAddress 0x${returnAddrHex}\n`));
                        
                        // Set breakpoint at return address
                        await this._sendCommandAndWait(`set-breakpoint 0x${returnAddrHex}`);
                        
                        // Run to the breakpoint
                        this.sendEvent(new OutputEvent(`[Debug][nextRequest] Running to return address...\n`));
                        await this._sendCommandAndWait('run');
                        
                        // Remove the temporary breakpoint
                        await this._sendCommandAndWait(`remove-breakpoint 0x${returnAddrHex}`);
                        
                        this.sendEvent(new OutputEvent(`[Debug][nextRequest] Function exit completed using precise breakpoint strategy.\n`));
                        usedFastExit = true;
                        
                        // Respond immediately since we've completed the step
                        this._stopped = true;
                        this.sendResponse(response);
                        this.sendEvent(new StoppedEvent('step', 1));
                        return;
                        
                    } catch (e) {
                        this.sendEvent(new OutputEvent(`[Debug][nextRequest] Precise breakpoint strategy failed: ${e.message}. Falling back to step-over.\n`, 'stderr'));
                    }
                }
                // FALLBACK: Try to estimate return address from previous PC
                else if (endOfSubInfo.location === 'previous' && this._previousPC) {
                    this.sendEvent(new OutputEvent(`[Debug][nextRequest] No stepOutAddress available, using estimated return address strategy.\n`));
                    
                    try {
                        // Calculate return address: instruction after the CALL that brought us here
                        // For Z80, CALL instructions are typically 3 bytes, but let's use a safer approach
                        // We'll estimate the return address as previousPC + 3 (most CALL instructions)
                        const returnAddress = this._previousPC + 3;
                        const returnAddrHex = returnAddress.toString(16).toUpperCase();
                        
                        this.sendEvent(new OutputEvent(`[Debug][nextRequest] Setting breakpoint at estimated return address 0x${returnAddrHex}\n`));
                        
                        // Set breakpoint at return address
                        await this._sendCommandAndWait(`set-breakpoint 0x${returnAddrHex}`);
                        
                        // Run to the breakpoint
                        this.sendEvent(new OutputEvent(`[Debug][nextRequest] Running to return address...\n`));
                        await this._sendCommandAndWait('run');
                        
                        // Remove the temporary breakpoint
                        await this._sendCommandAndWait(`remove-breakpoint 0x${returnAddrHex}`);
                        
                        this.sendEvent(new OutputEvent(`[Debug][nextRequest] Function exit completed using estimated breakpoint strategy.\n`));
                        usedFastExit = true;
                        
                        // Respond immediately since we've completed the step
                        this._stopped = true;
                        this.sendResponse(response);
                        this.sendEvent(new StoppedEvent('step', 1));
                        return;
                        
                    } catch (e) {
                        this.sendEvent(new OutputEvent(`[Debug][nextRequest] Estimated breakpoint strategy failed: ${e.message}. Falling back to step-over.\n`, 'stderr'));
                    }
                }
                
                // FINAL FALLBACK STRATEGY: Single step-over and continue normal stepping
                this.sendEvent(new OutputEvent(`[Debug][nextRequest] Using step-over fallback strategy for function exit.\n`));
                try {
                    // Step once to execute the return/exit instruction
                    await this._sendCommandAndWait('cpu-step-over');
                    usedFastExit = true;
                    
                    // Now continue with normal stepping logic to find the next Boriel line
                    this.sendEvent(new OutputEvent(`[Debug][nextRequest] Function exit step completed. Continuing with normal step logic.\n`));
                    // Don't return here - let it fall through to normal stepping logic
                    
                } catch (e) {
                    this.sendEvent(new OutputEvent(`[Debug][nextRequest] Fast exit step failed: ${e.message}. Falling back to normal step.\n`, 'stderr'));
                    // Fall through to normal logic
                }
            } else {
                this.sendEvent(new OutputEvent(`[Debug][nextRequest] No isEndOfSub flag found at current or previous PC. Using normal step.\n`));
            }

            this.sendEvent(new OutputEvent(`[Debug][nextRequest] Proceeding with normal step over logic.\n`));

            // NORMAL STEP OVER LOGIC: Continue with existing implementation
            // New strategy: perform CPU steps until the current PC matches one of the mapped addresses
            // We require the reverse mapping this._addrToBasLine to be present
            if (!this._addrToBasLine || Object.keys(this._addrToBasLine).length === 0) {
                this.sendEvent(new OutputEvent(`[Debug] No reverse addr->Bas map available; falling back to previous strategy\n`, 'stderr'));
                this.sendResponse(response);
                return;
            }

            // Ensure we are in step/cpu-step mode; try to enter if not
            // If we're already at the last mapped Boriel line, 'step over' should run
            // UNLESS we just used the fast exit strategy - in that case continue stepping normally
            try {
                const basKeys = this._basLineToAddress ? Object.keys(this._basLineToAddress).map(k => parseInt(k,10)).filter(n=>!isNaN(n)) : [];
                const maxBas = basKeys.length ? Math.max(...basKeys) : null;
                if (!usedFastExit && maxBas !== null && this._lastBasLine && parseInt(this._lastBasLine,10) === maxBas) {
                    this.sendEvent(new OutputEvent(`[Debug] Step Over requested but current Boriel line ${this._lastBasLine} is last mapped line -> issuing run\n`));
                    setImmediate(async () => {
                        try { await this._sendCommand('run'); } catch (e) { this.sendEvent(new OutputEvent(`[Debug] Error issuing run: ${e.message}\n`, 'stderr')); }
                    });
                    this.sendResponse(response);
                    return;
                } else if (usedFastExit) {
                    this.sendEvent(new OutputEvent(`[Debug] Fast exit used - skipping auto-run and continuing with normal stepping.\n`));
                }
            } catch (e) { /* ignore */ }

            try { await this._sendCommandAndWait('enter-cpu-step'); } catch (e) { /* ignore */ }

            // Repeatedly perform cpu-step and watch PC until we hit an address that maps to a Boriel line
            const maxSteps = 50; // Límite de seguridad reducido para evitar ejecución completa accidental
            let steps = 0;
            let foundBasLine = null;
            
            this.sendEvent(new OutputEvent(`[Debug] Iniciando step-over, mapeadas ${Object.keys(this._addrToBasLine).length} direcciones
`));

            while (steps < maxSteps) {
                // Perform cpu-step-over and watch PC until we hit a mapped address
                try {
                    await this._sendCommandAndWait('cpu-step-over');
                } catch (e) {
                    this.sendEvent(new OutputEvent(`[Debug] cpu-step-over failed: ${e.message}\n`, 'stderr'));
                    break;
                }

                // Give a tiny delay to let socket handler update _lastPC
                await this._waitForZesarux(20);

                const pc = this._lastPC;
                // Mostrar información detallada de los primeros pasos
                if (steps < 10 || steps % 10 === 0) {
                    const mapped = pc && this._addrToBasLine[pc];
                    this.sendEvent(new OutputEvent(`[Debug] Step ${steps}: PC=0x${pc ? pc.toString(16).toUpperCase() : 'null'} (decimal ${pc}), mapeado=${mapped ? `SÍ->línea ${this._addrToBasLine[pc]}` : 'NO'}\n`));
                }
                if (pc && this._addrToBasLine[pc]) {
                    foundBasLine = this._addrToBasLine[pc];
                    this.sendEvent(new OutputEvent(`[Debug] ✓ Step Over: reached PC=0x${pc.toString(16).toUpperCase()} which maps to Boriel line ${foundBasLine}\n`));
                    break;
                }

                steps++;
            }

            if (foundBasLine) {
                this._lastBasLine = foundBasLine;

                // (Do not auto-run when we reach the last Boriel line here; leave it stopped.)

                this._stopped = true;
                this.sendResponse(response);
                this.sendEvent(new StoppedEvent('step', 1));
                return;
            } else {
                this.sendEvent(new OutputEvent(`[Debug] Step Over: did not find mapped Boriel line after ${steps} asm steps\n`, 'stderr'));
                this.sendResponse(response);
                return;
            }
        } catch (err) {
            this.sendEvent(new OutputEvent(`[Debug] Error en nextRequest: ${err.message}\n`, 'stderr'));
            this.sendResponse(response);
        }
    }

    async stepInRequest(response, args) {
        // Step Into: perform CPU single-instruction steps until we reach an address
        // that maps to a Boriel source line (this._addrToBasLine).
        try {
            if (!this._addrToBasLine || Object.keys(this._addrToBasLine).length === 0) {
                this.sendEvent(new OutputEvent(`[Debug] No reverse addr->Bas map available for stepIn; falling back to single cpu-step\n`, 'stderr'));
                try { await this._sendCommand('cpu-step'); } catch (e) { this.sendEvent(new OutputEvent(`[Debug] cpu-step failed: ${e.message}\n`, 'stderr')); }
                this.sendResponse(response);
                this.sendEvent(new StoppedEvent('step', 1));
                return;
            }

            // FAST EXIT OPTIMIZATION FOR STEP INTO: Check if current or previous line has isEndOfSub
            let usedFastExit = false;
            const endOfSubInfo = this._checkIsEndOfSubAtCurrentOrPreviousPC();
            
            if (endOfSubInfo) {
                this.sendEvent(new OutputEvent(`[Debug][stepInRequest] isEndOfSub=true detected at ${endOfSubInfo.location} PC 0x${endOfSubInfo.pc.toString(16).toUpperCase()}. Using fast exit strategy.\n`));
                
                try {
                    // Use step-over to exit the function quickly
                    await this._sendCommandAndWait('cpu-step-over');
                    usedFastExit = true;
                    
                    this.sendEvent(new OutputEvent(`[Debug][stepInRequest] Function exit step completed. Continuing with normal step logic.\n`));
                    
                } catch (e) {
                    this.sendEvent(new OutputEvent(`[Debug][stepInRequest] Fast exit step failed: ${e.message}. Falling back to normal step.\n`, 'stderr'));
                }
            }

            // Ensure step mode
            try { await this._sendCommandAndWait('enter-cpu-step'); } catch (e) { /* ignore */ }

            const maxSteps = 4000;
            let steps = 0;
            let foundBasLine = null;

            while (steps < maxSteps) {
                try {
                    await this._sendCommandAndWait('cpu-step');
                } catch (e) {
                    this.sendEvent(new OutputEvent(`[Debug] cpu-step failed: ${e.message}\n`, 'stderr'));
                    break;
                }

                await this._waitForZesarux(20);

                const pc = this._lastPC;
                if (pc && this._addrToBasLine[pc]) {
                    foundBasLine = this._addrToBasLine[pc];
                    this.sendEvent(new OutputEvent(`[Debug] Step Into: reached PC=0x${pc.toString(16).toUpperCase()} which maps to Boriel line ${foundBasLine}\n`));
                    break;
                }

                steps++;
            }

            if (foundBasLine) {
                this._lastBasLine = foundBasLine;
                this._stopped = true;
                this.sendResponse(response);
                this.sendEvent(new StoppedEvent('step', 1));
                return;
            } else {
                this.sendEvent(new OutputEvent(`[Debug] Step Into: did not find mapped Boriel line after ${steps} asm steps\n`, 'stderr'));
                this.sendResponse(response);
                return;
            }
        } catch (err) {
            this.sendEvent(new OutputEvent(`[Debug] Error en stepInRequest: ${err.message}\n`, 'stderr'));
            this.sendResponse(response);
        }
    }

    async stepOutRequest(response, args) {
        await this._sendCommand('cpu-step-over');
        this.sendResponse(response);
        this.sendEvent(new StoppedEvent('step', 1));
    }

    threadsRequest(response) {
        response.body = {
            threads: [
                new Thread(1, "Z80 CPU")
            ]
        };
        this.sendResponse(response);
    }

    async stackTraceRequest(response, args) {
        // Intentar retornar un stack frame con fuente y línea mapeada desde el último PC conocido
        let source = undefined;
        let line = 1;
        // Prefer _lastSourceFile (file where the breakpoint actually stopped) over the main source file
        const stoppedFile = this._lastSourceFile || this._sourceFile;
        if (this._lastBasLine && stoppedFile && fs.existsSync(stoppedFile)) {
            source = new Source(path.basename(stoppedFile), stoppedFile);
            line = this._lastBasLine;
        } else {
            // Try to locate a sensible .bas source file if the stored path is missing
            const candidates = [];
            try {
                    if (this._program) {
                        // Prefer the original main.bas corresponding to the TAP (not the preprocessed file)
                        const preferMain = this._program.replace(/\.tap$/i, '.bas');
                        candidates.push(preferMain);
                    }
                    if (this._asmFile) candidates.push(this._asmFile.replace(/\.asm$/i, '.bas'));
                // same folder as program
                if (this._program) {
                    const progDir = path.dirname(this._program);
                    const progBase = path.basename(this._program, '.tap');
                    candidates.push(path.join(progDir, progBase + '.bas'));
                }
                // fallback to workspace cwd
                if (process.cwd()) {
                    const cwdBase = path.basename(process.cwd());
                    candidates.push(path.join(process.cwd(), cwdBase + '.bas'));
                }
            } catch (e) {}

            let found = null;
            // Prefer exact main.bas (avoid selecting files from .debug folder)
            for (const c of candidates) {
                if (!c) continue;
                if (c.includes(path.sep + '.debug' + path.sep)) continue;
                if (fs.existsSync(c)) { found = c; break; }
            }

            if (!found) {
                // Last resort: search nearby for any .bas file in program directory
                try {
                    if (this._program) {
                        const pdir = path.dirname(this._program);
                        const files = fs.readdirSync(pdir);
                        // Prefer a file that matches the TAP basename (main.bas)
                        const tapBase = path.basename(this._program, '.tap').toLowerCase();
                        for (const f of files) {
                            if (!f.toLowerCase().endsWith('.bas')) continue;
                            const full = path.join(pdir, f);
                            if (f.toLowerCase() === `${tapBase}.bas`) { found = full; break; }
                            if (full.includes(path.sep + '.debug' + path.sep)) continue;
                            if (!found) found = full; // keep first non-.debug file as fallback
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            if (found) {
                source = new Source(path.basename(found), found);
                line = this._lastBasLine || 1;
                this._sourceFile = found; // cache for later
            } else if (this._sourceFile && fs.existsSync(this._sourceFile)) {
                source = new Source(path.basename(this._sourceFile), this._sourceFile);
                line = this._lastBasLine || 1;
            }
        }

        const stackFrames = [
            new StackFrame(1, "Main", source, line, 1)
        ];

        // Inform the debug console and help VS Code to show the file/line
        if (source && line) {
            this.sendEvent(new OutputEvent(`[Debug] Mapeo de stack: archivo=${source.path} linea=${line}\n`));
        }

        response.body = {
            stackFrames: stackFrames,
            totalFrames: 1
        };
        this.sendResponse(response);
    }

    scopesRequest(response, args) {
        const scopes = [
            new Scope("Registros", this._variableHandles.create("registers"), false),
            new Scope("Memoria", this._variableHandles.create("memory"), false)
        ];

        // Add Globals scope if we have detected global variables
        try {
            if (this._globalVariables && this._globalVariables.length > 0) {
                scopes.push(new Scope("Globals", this._variableHandles.create("globals"), false));
            }
        } catch (e) {}

        response.body = {
            scopes: scopes
        };
        this.sendResponse(response);
    }

    async variablesRequest(response, args) {
        const variables = [];
        const id = this._variableHandles.get(args.variablesReference);

        if (id === "registers") {
            // Mostrar registros conocidos (cached) y mapear PC a línea Boriel si está disponible
            const regs = this._lastRegisters || {};
            const regNames = Object.keys(regs).length ? Object.keys(regs) : ['PC','SP','AF','A','B','C','D','E','I','R'];
            for (const r of regNames) {
                const v = regs[r] !== undefined ? `0x${regs[r].toString(16).toUpperCase().padStart(4, '0')}` : 'n/a';
                variables.push({ name: r, value: v, variablesReference: 0 });
            }
            // Añadir un elemento informativo con la línea Boriel mapeada (si existe)
            if (this._lastBasLine) {
                variables.unshift({ name: 'MappedBorielLine', value: String(this._lastBasLine), variablesReference: 0 });
            } else if (this._lastAsmLine) {
                variables.unshift({ name: 'MappedAsmLine', value: String(this._lastAsmLine), variablesReference: 0 });
            }
        }

        // Globals scope: return parsed global variable descriptors (name, type, address)
        if (id === "globals") {
            try {
                if (this._globalVariables && this._globalVariables.length > 0) {
                    for (const g of this._globalVariables) {
                        try {
                            let display = `${g.type}`;
                            if (g.addr) {
                                const addrNum = parseInt(g.addr, 10);
                                const hexAddr = addrNum.toString(16).toUpperCase().padStart(4, '0');
                                // Attempt to read memory from emulator
                                const bytes = await this._readMemoryZesarux(addrNum, Math.max(1, Math.min(g.size || 1, 256)));
                                if (bytes && bytes.length > 0) {
                                    if (g.type === 'byte' || (g.size === 1)) {
                                        display = `byte ${bytes[0]} (0x${bytes[0].toString(16).toUpperCase()})`;
                                    } else if (g.type === 'word' || (g.size === 2)) {
                                        const lo = bytes[0] || 0;
                                        const hi = bytes[1] || 0;
                                        const val = lo + (hi << 8);
                                        display = `word ${val} (0x${val.toString(16).toUpperCase()})`;
                                    } else if (g.type === 'string') {
                                        const chars = bytes.map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
                                        display = `string "${chars}"`;
                                    } else if (g.type === 'reserve') {
                                        display = `reserve ${g.size} bytes @ 0x${hexAddr}`;
                                    } else {
                                        display = `${g.type} ${bytes.map(b => b.toString(16).padStart(2,'0')).join(' ')} (len=${bytes.length})`;
                                    }
                                } else {
                                    display = `${g.type} addr=0x${hexAddr}`;
                                }
                            } else {
                                display = `${g.type} (addr unknown)`;
                            }

                            variables.push({ name: g.name, value: display, variablesReference: 0 });
                        } catch (inner) {
                            variables.push({ name: g.name, value: `error: ${inner.message}`, variablesReference: 0 });
                        }
                    }
                }
            } catch (e) {
                variables.push({ name: 'error', value: e.message, variablesReference: 0 });
            }

            response.body = { variables };
            this.sendResponse(response);
            return;
        }

        response.body = {
            variables: variables
        };
        this.sendResponse(response);
    }

    async evaluateRequest(response, args) {
        response.body = {
            result: "No implementado",
            variablesReference: 0
        };
        this.sendResponse(response);
    }
}

// Exportar la clase para uso inline
console.log('[BorielBasicDebug] debugAdapter.js cargado como módulo');
module.exports = { BorielBasicDebugSession };
