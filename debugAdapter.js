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
    this._asmLabelAddressMap = {}; // mapa de etiqueta __BASLINE_N__ -> dirección (desde zxbasm Declaring)
        this._lastPC = null; // último PC leído del emulador
        this._lastAsmLine = null; // última línea ASM conocida para PC
        this._lastBasLine = null; // última línea Boriel conocida para PC
        this._sourceFile = null; // Archivo fuente .bas
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);
        console.log('[BorielBasicDebug] Inicializado');
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
            
            // Cargar el mapeo de líneas si existe
            const lineMapFile = program.replace(/\.tap$/i, '.linemap.json');
            if (fs.existsSync(lineMapFile)) {
                try {
                    const lineMapContent = fs.readFileSync(lineMapFile, 'utf8');
                    this._lineMap = JSON.parse(lineMapContent);
                    
                    // Crear mapeo inverso (línea ASM -> línea Boriel)
                    this._reverseLineMap = {};
                    for (const [basLine, asmLines] of Object.entries(this._lineMap)) {
                        for (const asmLine of asmLines) {
                            this._reverseLineMap[asmLine] = parseInt(basLine);
                        }
                    }
                    
                    this.sendEvent(new OutputEvent(`✓ Mapeo de líneas cargado: ${Object.keys(this._lineMap).length} líneas mapeadas\n`));
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
                const programDir = path.dirname(program); // .../test/dist
                const workspaceDir = path.dirname(programDir); // .../test
                const baseName = path.basename(program, '.tap');
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
                    // PASO 1: Pre-procesar el archivo para añadir marcadores __BASLINE
                    this.sendEvent(new OutputEvent(`[Debug] Pre-procesando archivo Boriel para debug...\n`));
                    const preprocessedFile = program.replace('.tap', '.preprocessed.bas');
                    
                    try {
                        const sourceContent = fs.readFileSync(mainBas, 'utf8');
                        const sourceLines = sourceContent.split('\n');
                        const preprocessedLines = [];
                        // Tokens that represent control-flow / structural statements in Boriel
                        // for which we should NOT insert a __BASLINE label above.
                        const FLOW_TOKENS = new Set(['IF','ELSE','END','FOR','WHILE','DO','LOOP','GOTO','GOSUB','RETURN','NEXT','UNTIL','SELECT','CASE','THEN']);

                        sourceLines.forEach((line, index) => {
                            const originalLineNumber = index + 1;
                            const trimmedLine = line.trim();

                            // Solo añadir marcadores para líneas de código real (no vacías, no comentarios,
                            // ni directivas de preprocesado como #include). Además, no insertar
                            // antes de líneas que comienzan con If/Else/End (case-insensitive)
                            const firstToken = (trimmedLine.split(/\s+/)[0] || '').toUpperCase();
                            if (trimmedLine && !trimmedLine.startsWith("'") && !trimmedLine.toUpperCase().startsWith('REM') && !trimmedLine.startsWith('#') && !FLOW_TOKENS.has(firstToken)) {
                                // Añadir marcador ANTES de la línea de código.
                                // Insertamos una etiqueta ASM __BASLINE_n__: que será visible
                                // en el ASM generado. No añadimos instrucciones extra (nop) aquí.
                                preprocessedLines.push(`ASM`);
                                preprocessedLines.push(`__BASLINE_${originalLineNumber}__:`);
                                preprocessedLines.push(`END ASM`);
                            }

                            // Añadir la línea original
                            preprocessedLines.push(line);
                        });
                        
                        fs.writeFileSync(preprocessedFile, preprocessedLines.join('\n'), 'utf8');
                        this.sendEvent(new OutputEvent(`[Debug] ✓ Pre-procesado completado: ${preprocessedFile}\n`));
                    } catch (preErr) {
                        this.sendEvent(new OutputEvent(`[Debug] ⚠ Error pre-procesando: ${preErr.message}\n`, 'stderr'));
                        this.sendEvent(new OutputEvent(`[Debug] Continuando con archivo original...\n`));
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
                    
                    // PASO 3: Compilar el ASM desde el archivo preprocesado (para obtener marcadores)
                    const asmFile = program.replace('.tap', '.asm');
                    // Generate ASM from the preprocessed file using same optimization level
                    const asmCmd = `${bin} -O2 -A "${preprocessedFile}" -o "${asmFile}"`;
                    this.sendEvent(new OutputEvent(`[Debug] Generando ASM con marcadores: ${asmCmd}\n`));
                    try {
                        const execSync = require('child_process').execSync;
                        const out = execSync(asmCmd, { cwd: workspaceDir, encoding: 'utf8' });
                        if (out && out.length) this.sendEvent(new OutputEvent(`zxbc ASM: ${out}\n`));
                        this.sendEvent(new OutputEvent(`[Debug] ✓ ASM generado: ${asmFile}\n`));
                        
                        // PASO 4: Asegurar que el ASM contiene marcadores visibles insertando
                        // comentarios '; __BASLINE:N__' junto a las directivas #line (post-procesado).
                        try {
                            await this._injectAsmMarkers(asmFile, preprocessedFile);
                        } catch (injErr) {
                            this.sendEvent(new OutputEvent(`[Debug] ⚠ Error inyectando marcadores en ASM: ${injErr.message}\n`, 'stderr'));
                        }

                        // PASO 5: Generar el linemap desde el ASM con marcadores (ahora inyectados)
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
            // Calcular ruta del .asm generado
            let asmFile = null;
            if (program && program.endsWith('.tap')) {
                asmFile = program.replace(/\.tap$/i, '.asm');
                this._asmFile = asmFile;
                this.sendEvent(new OutputEvent(`[Debug] Ruta ASM calculada: ${asmFile}\n`));
                this.sendEvent(new OutputEvent(`[Debug] ¿Existe ASM?: ${fs.existsSync(asmFile)}\n`));
            }

            // Start ZEsarUX WITHOUT tape so we can set breakpoints first,
            // then use smartload command to load and run the program.
            const zesaruxArgs = [
                '--enable-remoteprotocol',
                '--remoteprotocol-port', String(debugPort),
                '--noconfigfile',
                '--machine', '128k',
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

            this.sendEvent(new OutputEvent(`[Debug] Conexión exitosa, continuando con carga de símbolos...\n`));

            // Cargar el archivo .asm si existe
            this.sendEvent(new OutputEvent(`[Debug] Intentando cargar símbolos...\n`));
            this.sendEvent(new OutputEvent(`[Debug] asmFile = ${asmFile}\n`));
            this.sendEvent(new OutputEvent(`[Debug] existe? = ${asmFile ? fs.existsSync(asmFile) : 'N/A'}\n`));
            
            if (asmFile && fs.existsSync(asmFile)) {
                this.sendEvent(new OutputEvent(`\n=== Cargando símbolos desde: ${asmFile} ===\n`));
                try {
                    await this._sendCommand(`load-source-code ${asmFile}`);
                    this.sendEvent(new OutputEvent(`✓ Símbolos cargados correctamente\n\n`));
                } catch (err) {
                    this.sendEvent(new OutputEvent(`⚠ No se pudieron cargar los símbolos: ${err.message}\n\n`));
                }
            } else {
                this.sendEvent(new OutputEvent(`⚠ No se encontró archivo .asm para depuración simbólica\n\n`));
            }

            // Habilitar breakpoints e instalar pendientes INMEDIATAMENTE
            // (antes de que el TAP empiece a ejecutarse automáticamente)
            try { 
                await this._ensureBreakpointsEnabled(); 
                this.sendEvent(new OutputEvent(`[Debug] Breakpoints habilitados\n`));
            } catch (e) {
                this.sendEvent(new OutputEvent(`[Debug] No se pudieron habilitar breakpoints: ${e.message}\n`));
            }
            try { 
                await this._flushPendingBreakpoints(); 
                this.sendEvent(new OutputEvent(`[Debug] Breakpoints pendientes instalados\n`));
            } catch (e) {
                this.sendEvent(new OutputEvent(`[Debug] No se pudieron instalar breakpoints pendientes: ${e.message}\n`));
            }

            // Pausar en la entrada si está configurado
            if (stopOnEntry) {
                this.sendEvent(new OutputEvent(`Pausando en entrada...\n`));

                // Build the Boriel line -> address map first
                let entryAddr = null;
                if (this._asmFile && fs.existsSync(this._asmFile)) {
                    await this._buildAsmAddressMap(this._asmFile);
                    await this._buildBasLineAddressMap(this._asmFile);

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
                        // Use the address of the first Boriel line as entry point
                        if (this._basLineToAddress && this._basLineToAddress[1]) {
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

                if (entryAddr !== null && entryAddr !== 0) {
                    // Intentar establecer breakpoint y ejecutar.
                    try {
                        const hexNoPrefix = entryAddr.toString(16).toUpperCase();
                        const addrToken = `${hexNoPrefix}H`;
                        try { await this._ensureBreakpointsEnabled(); } catch (e) {}
                        
                        // Use set-breakpoint 2 for entry point (slot 1 is reserved for step-over sequence)
                        const cmd = `set-breakpoint 2 PC=${hexNoPrefix}H`;
                        this.sendEvent(new OutputEvent(`> ${cmd}\n`, 'console'));
                        const resp = await this._sendCommandAndWait(cmd);
                        const lower = String(resp || '').toLowerCase();
                        
                        if (lower.includes('unknown command') || lower.includes('error')) {
                            this.sendEvent(new OutputEvent(`[Debug] set-breakpoint no soportado, usando fallback\n`));
                            // fallback to legacy
                            await this._sendCommand(`break set ${hexNoPrefix}H`);
                        }
                        
                        this.sendEvent(new OutputEvent(`[Debug] Breakpoint establecido en ${addrToken}, cargando y ejecutando hasta entrada...\n`));
                        
                        // Reproducir la cinta y ejecutar hasta que PC alcance entryAddr
                        await this._tryPlayTapeThenRun(entryAddr);
                        // El adaptador seguirá escuchando la salida y debe detectar el hit del breakpoint
                    } catch (e) {
                        this.sendEvent(new OutputEvent(`[Debug] Falló la estrategia de breakpoint en entrada: ${e.message}\n`, 'stderr'));
                        // Fallback a la estrategia previa (enter-cpu-step + auto-step)
                        try {
                            await this._sendCommandAndWait('enter-cpu-step');
                            try {
                                this.sendEvent(new OutputEvent(`[Debug] Ejecutando un paso automático (cpu-step) para posicionar el PC...\n`));
                                await this._sendCommandAndWait('cpu-step');
                            } catch (inner) {
                                this.sendEvent(new OutputEvent(`[Debug] Falló el step automático: ${inner.message}\n`, 'stderr'));
                            }
                        } catch (enterErr) {
                            this.sendEvent(new OutputEvent(`[Debug] No se pudo entrar en modo step: ${enterErr.message}\n`, 'stderr'));
                        }
                    }
                } else {
                    // No tenemos dirección de entrada: fallback a enter-cpu-step
                    try {
                        await this._sendCommandAndWait('enter-cpu-step');
                        try {
                            this.sendEvent(new OutputEvent(`[Debug] Ejecutando un paso automático (cpu-step) para posicionar el PC...\n`));
                            await this._sendCommandAndWait('cpu-step');
                        } catch (e) {
                            this.sendEvent(new OutputEvent(`[Debug] Falló el step automático: ${e.message}\n`, 'stderr'));
                        }
                    } catch (enterErr) {
                        this.sendEvent(new OutputEvent(`[Debug] No se pudo entrar en modo step: ${enterErr.message}\n`, 'stderr'));
                    }
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
        if (!asmFile || !fs.existsSync(asmFile)) return;
        try {
            const zxbasmPath = path.join(__dirname, 'bin', 'zxbasic-linux', 'zxbasm');
            const zxbasmCmd = `${zxbasmPath} -d "${asmFile}" -o /dev/null 2>&1`;
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

            // Parse 'Declaring' lines to capture label addresses for __BASLINE_N__
            // Format: debug: memory.py:219 Declaring '.__BASLINE_1__' (value 92BBh) in 2
            const declRe = /Declaring\s+'\.?__BASLINE_(\d+)__'.*\(value\s+([0-9A-Fa-f]+)h?\)/i;
            let declCount = 0;
            for (const line of out.split('\n')) {
                const md = line.match(declRe);
                if (md) {
                    const basNum = parseInt(md[1], 10);
                    const hex = md[2];
                    const addrDec = parseInt(hex, 16);
                    this._asmLabelAddressMap[basNum] = addrDec;
                    declCount++;
                    this.sendEvent(new OutputEvent(`[Debug][zxbasm] ✓ Found BASLINE_${basNum} at address 0x${hex.toUpperCase()} (decimal ${addrDec})\n`));
                }
            }
            this.sendEvent(new OutputEvent(`[Debug] Total parsed: ${declCount} __BASLINE address declarations\n`));

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

        // Asegurarnos de tener el mapa asmLine->address
        if (!this._asmLineToAddress) {
            await this._buildAsmAddressMap(asmFile);
        }

        // If zxbasm produced explicit Declaring lines for __BASLINE_N__, prefer those
        // as the authoritative addresses (they reflect the assembler/runtime mapping).
        if (this._asmLabelAddressMap && Object.keys(this._asmLabelAddressMap).length > 0) {
            this.sendEvent(new OutputEvent(`[Debug] ✓ Using ${Object.keys(this._asmLabelAddressMap).length} addresses from zxbasm Declaring lines\n`));
            for (const [k, v] of Object.entries(this._asmLabelAddressMap)) {
                const bas = parseInt(k, 10);
                const addrNum = parseInt(v, 10);
                if (!isNaN(bas) && !isNaN(addrNum)) {
                    this._basLineToAddress[bas] = addrNum;
                    this.sendEvent(new OutputEvent(`[Debug]   BASLINE_${bas} -> 0x${addrNum.toString(16).toUpperCase()}\n`));
                }
            }
            // Don't run fallback heuristic if we have authoritative addresses from zxbasm
        } else {
            this.sendEvent(new OutputEvent(`[Debug][WARNING] ⚠ No zxbasm Declaring addresses found! Falling back to heuristic mapping.\n`, 'stderr'));
            
            // Fallback heuristic: scan for __BASLINE_N__: labels in ASM and find next instruction address
            const asmLines = fs.readFileSync(asmFile, 'utf8').split('\n');

            for (let i = 0; i < asmLines.length; i++) {
                const l = asmLines[i];
                const m = l.match(/__BASLINE_(\d+)__\s*:/);
                if (m) {
                    const bas = parseInt(m[1], 10);
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
                    }
                }
            }
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
                const outFile = this._program.replace(/\.tap$/i, '.linemap.json');
                // Persist as simple mapping: { '1': '92BBH', '2': '92C8H', ... }
                const simple = {};
                for (const k of basKeys) {
                    const addr = this._basLineToAddress[k];
                    if (addr !== undefined && addr !== null) {
                        simple[String(k)] = `${addr.toString(16).toUpperCase()}H`;
                    }
                }
                this.sendEvent(new OutputEvent(`[Debug] About to persist linemap with ${Object.keys(simple).length} entries:\n`));
                for (const [k, v] of Object.entries(simple)) {
                    this.sendEvent(new OutputEvent(`[Debug]   JSON[${k}] = ${v}\n`));
                }
                fs.writeFileSync(outFile, JSON.stringify(simple, null, 2), 'utf8');
                this.sendEvent(new OutputEvent(`[Debug] Persistido linemap simple con direcciones en: ${outFile}\n`));
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
     * Post-process ASM file to inject explicit comment markers '; __BASLINE:N__' after
     * #line directives that reference the preprocessed file. This makes markers visible
     * in the final ASM even if labels/nops were moved/optimized.
     */
    async _injectAsmMarkers(asmFile, preprocessedFile) {
        try {
            if (!fs.existsSync(asmFile)) return;
            if (!fs.existsSync(preprocessedFile)) return;

            const asmContent = fs.readFileSync(asmFile, 'utf8').split('\n');
            const preContent = fs.readFileSync(preprocessedFile, 'utf8').split('\n');

            // Build preprocessedMap: preLine -> basLine from labels __BASLINE_N__:
            const preprocessedMap = {};
            for (let i = 0; i < preContent.length; i++) {
                const l = preContent[i];
                const mm = l.match(/__BASLINE_(\d+)__:/);
                if (mm) preprocessedMap[i + 1] = parseInt(mm[1], 10);
            }

            const preBase = path.basename(preprocessedFile);
            const outLines = [];
            for (let i = 0; i < asmContent.length; i++) {
                const line = asmContent[i];
                outLines.push(line);
                const m = line.match(/^#line\s+(\d+)\s+"([^"]+)"/);
                if (m) {
                    const pLine = parseInt(m[1], 10);
                    const pFile = m[2];
                    if (path.basename(pFile) === preBase || pFile === preprocessedFile) {
                        // Find nearest basLine at or before pLine
                        let basLine = preprocessedMap[pLine] || null;
                        if (!basLine) {
                            for (let d = 0; d <= 20 && !basLine; d++) {
                                const cand = pLine - d;
                                if (cand > 0 && preprocessedMap[cand]) { basLine = preprocessedMap[cand]; break; }
                            }
                        }
                        if (basLine) {
                            outLines.push(`; __BASLINE:${basLine}__`);
                        }
                    }
                }
            }

            fs.writeFileSync(asmFile, outLines.join('\n'), 'utf8');
            this.sendEvent(new OutputEvent(`[Debug] Inyectados marcadores en ASM desde ${preprocessedFile}\n`));
        } catch (e) {
            throw e;
        }
    }

    /**
     * Genera el linemap parseando los marcadores __BASLINE:N__ desde el ASM generado
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
            //    (we inserted labels like __BASLINE_N__: before each Boriel source line)
            // 2) Parse the generated ASM for '#line <n> "<preprocessedFile>"' directives that tell which
            //    preprocessed line the following ASM comes from. Use that to map ASM lines -> preprocessed lines
            // 3) Use preprocessedLine -> basLine map to produce final this._lineMap (basLine -> [asmLines])

            // Attempt to locate the preprocessed file path from asm #line directives header (heuristic)
            const asmContent = fs.readFileSync(asmFile, 'utf8');
            const asmLines = asmContent.split('\n');

            this._lineMap = {};
            this._reverseLineMap = {};

            // Primary strategy: search STRICT for the exact markers we inserted in the preprocessed BAS
            // We accept two forms in the final ASM:
            //  - a label:    __BASLINE_123__:
            //  - a comment:  ; __BASLINE:123__
            // When we see such a marker, we set currentBasLine and map subsequent ASM instructions
            // to that Boriel line until another marker appears.
            let currentBasLine = null;
            for (let i = 0; i < asmLines.length; i++) {
                const line = asmLines[i];
                const asmLineNumber = i + 1;

                // Detect label form
                const mLabel = line.match(/__BASLINE_(\d+)__\s*:/);
                if (mLabel) {
                    currentBasLine = parseInt(mLabel[1], 10);
                    // label line itself is not mapped to instructions; continue
                    continue;
                }

                // Detect comment marker form
                const mComment = line.match(/;\s*__BASLINE:(\d+)__/);
                if (mComment) {
                    currentBasLine = parseInt(mComment[1], 10);
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
                this.sendEvent(new OutputEvent(`[Debug] No se encontraron marcadores directos __BASLINE en ASM; usando fallback #line heuristic\n`));

                // First, try to detect preprocessed file referenced in the ASM via #line directives
                let detectedPreprocessedPath = null;
                for (let i = 0; i < Math.min(200, asmLines.length); i++) {
                    const m = asmLines[i].match(/^#line\s+(\d+)\s+"([^"]+)"/);
                    if (m) { detectedPreprocessedPath = m[2]; break; }
                }

                if (!detectedPreprocessedPath) {
                    detectedPreprocessedPath = asmFile.replace(/\.asm$/i, '.preprocessed.bas');
                }

                // Build preprocessedLine -> basLine map
                const preprocessedMap = {}; // preprocessedLineNumber -> basLineNumber
                try {
                    if (fs.existsSync(detectedPreprocessedPath)) {
                        const preContent = fs.readFileSync(detectedPreprocessedPath, 'utf8').split('\n');
                        for (let i = 0; i < preContent.length; i++) {
                            const l = preContent[i];
                            const mm = l.match(/__BASLINE_(\d+)__:/);
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
            
            // IMPORTANT: Enter step mode BEFORE smartload
            // This prevents ZEsarUX from opening its debugger UI
            this.sendEvent(new OutputEvent(`[Debug] Entrando en modo step...\n`));
            const stepResp = await this._sendCommandAndWait('enter-cpu-step');
            this.sendEvent(new OutputEvent(`[Debug] enter-cpu-step response: ${String(stepResp).replace(/\n/g,' ')}\n`));
            
            // Wait a bit for step mode to be established
            await this._waitForZesarux(300);
            
            // Now execute smartload - it will stay in step mode
            this.sendEvent(new OutputEvent(`[Debug] Ejecutando smartload (permanecerá en step mode)...\n`));
            const smartloadResp = await this._sendCommandAndWait(`smartload ${tapPath}`);
            const smartloadRespStr = String(smartloadResp).replace(/\n/g,' ');
            this.sendEvent(new OutputEvent(`[Debug] smartload response: ${smartloadRespStr}\n`));
            
            // Check if smartload succeeded
            if (smartloadRespStr.toLowerCase().includes('error')) {
                this.sendEvent(new OutputEvent(`[Debug] smartload reportó error\n`, 'stderr'));
                throw new Error('smartload failed: ' + smartloadRespStr);
            }
            
            // Wait for smartload to complete
            await this._waitForZesarux(500);
            
            // Now run - this will execute until it hits our breakpoint
            this.sendEvent(new OutputEvent(`[Debug] Ejecutando run (se detendrá en breakpoint)...\n`));
            await this._sendCommand('run');
            
            // The emulator will send async notification when breakpoint is hit
            this.sendEvent(new OutputEvent(`[Debug] Programa cargado y ejecutándose hasta breakpoint\n`));
            
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
    async _sendCommandAndWait(command) {
        return new Promise((resolve, reject) => {
            if (!this._debugSocket || this._debugSocket.destroyed) {
                reject(new Error('No hay conexión con ZEsarUX'));
                return;
            }
            this.sendEvent(new OutputEvent(`> ${command}\n`, 'console'));
            let resolved = false;
            const dataListener = (data) => {
                try {
                    const txt = data.toString();
                    if (!resolved) {
                        resolved = true;
                        this._debugSocket.removeListener('data', dataListener);
                        resolve(txt);
                    }
                } catch (e) {
                    if (!resolved) {
                        resolved = true;
                        this._debugSocket.removeListener('data', dataListener);
                        resolve('');
                    }
                }
            };
            this._debugSocket.on('data', dataListener);
            this._debugSocket.write(command + '\n');
        });
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
     * Convierte una línea ASM a la línea de código Boriel correspondiente
     */
    _asmLineToBAsLine(asmLine) {
        if (!this._reverseLineMap) {
            return null;
        }
        return this._reverseLineMap[asmLine] || null;
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
            }, 2000);

            this._debugSocket.on('data', (data) => {
                this._handleSocketData(data);
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

            this._debugSocket.connect(port, 'localhost', () => {
                clearTimeout(timeout);
                connected = true;
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
            const resp = await this._sendCommandAndWait('enable-breakpoints');
            const lower = String(resp || '').toLowerCase();
            // Algunas versiones devuelven 'Error. Already enabled' cuando ya estaban activados: considerarlo éxito
            if (lower.includes('unknown command')) {
                this._breakpointsEnabled = false;
                this.sendEvent(new OutputEvent(`⚠ enable-breakpoints no soportado por el emulador: respuesta='${resp.replace(/\n/g,' ')}'\\n`));
            } else {
                this._breakpointsEnabled = true;
                this.sendEvent(new OutputEvent(`✓ enable-breakpoints soportado y activado en el emulador (resp: ${resp.replace(/\n/g,' ')})\\n`));
            }
        } catch (e) {
            this._breakpointsEnabled = false;
            this.sendEvent(new OutputEvent(`⚠ enable-breakpoints no soportado por el emulador: ${e.message}\n`));
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
                    this._lastPC = pc;
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
                        mappedBasLine = (asmLine && this._reverseLineMap) ? (this._reverseLineMap[asmLine] || null) : null;
                        if (mappedBasLine) {
                            this.sendEvent(new OutputEvent(`[Debug] Fallback: ASM line ${asmLine} -> Boriel line ${mappedBasLine}\n`));
                        }
                    }
                    
                    this._lastBasLine = mappedBasLine;
                    
                    if (this._lastBasLine) {
                        this.sendEvent(new OutputEvent(`[Debug] PC=0x${pc.toString(16).toUpperCase()} mapeado a Boriel line: ${this._lastBasLine}\n`));
                    } else {
                        this.sendEvent(new OutputEvent(`[Debug] PC=0x${pc.toString(16).toUpperCase()} (sin mapeo Boriel)\n`));
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
                        this._lastPC = pc;
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
                            mappedBasLine = (asmLine && this._reverseLineMap) ? (this._reverseLineMap[asmLine] || null) : null;
                        }
                        
                        this._lastBasLine = mappedBasLine;
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
                                basLine = this._reverseLineMap[asmLine] || null;
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
                const zxbasmPath = path.join(__dirname, 'bin', 'zxbasic-linux', 'zxbasm');
                const zxbasmCmd = `${zxbasmPath} -d "${asmFile}" -o /dev/null`;
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

            await this._sendCommand('run');
        } catch (e) {
            this.sendEvent(new OutputEvent(`[Debug] continueRequest error: ${e.message}\n`, 'stderr'));
        }
        this.sendResponse(response);
    }

    async pauseRequest(response, args) {
        await this._sendCommand('enter-cpu-step');
        this._stopped = true;
        this.sendResponse(response);
        this.sendEvent(new StoppedEvent('pause', 1));
    }

    async nextRequest(response, args) {
        // Step Over: ir a la siguiente línea Boriel
        try {
            // Get current Boriel line
            let currentBasLine = this._lastBasLine;
            
            if (!currentBasLine) {
                this.sendEvent(new OutputEvent(`[Debug] No se conoce la línea Boriel actual\n`, 'stderr'));
                this.sendResponse(response);
                return;
            }

            // Ensure we have the address map
            if (!this._basLineToAddress || Object.keys(this._basLineToAddress).length === 0) {
                this.sendEvent(new OutputEvent(`[Debug] No hay mapa de direcciones Boriel->addr disponible\n`, 'stderr'));
                this.sendResponse(response);
                return;
            }

            // Find next Boriel line
            const basLines = Object.keys(this._basLineToAddress).map(k => parseInt(k, 10)).sort((a, b) => a - b);
            const currentIndex = basLines.indexOf(currentBasLine);
            
            if (currentIndex === -1) {
                this.sendEvent(new OutputEvent(`[Debug] Línea Boriel actual ${currentBasLine} no está en el mapa\n`, 'stderr'));
                this.sendResponse(response);
                return;
            }

            // Check if there's a next line
            if (currentIndex >= basLines.length - 1) {
                // No more lines, just run without breakpoint
                this.sendEvent(new OutputEvent(`[Debug] Step Over: no hay más líneas, ejecutando run sin breakpoint...\n`));
                this.sendEvent(new OutputEvent(`> run\n`, 'console'));
                await this._sendCommand('run');
                this.sendResponse(response);
                return;
            }

            // Get next line address
            const nextBasLine = basLines[currentIndex + 1];
            const nextAddr = this._basLineToAddress[nextBasLine];
            
            if (!nextAddr) {
                this.sendEvent(new OutputEvent(`[Debug] No hay dirección para la siguiente línea Boriel ${nextBasLine}\n`, 'stderr'));
                this.sendResponse(response);
                return;
            }

            const hexNoPrefix = nextAddr.toString(16).toUpperCase();
            const addrToken = `${hexNoPrefix}H`;
            
            this.sendEvent(new OutputEvent(`[Debug] Step Over: línea ${currentBasLine} -> ${nextBasLine} (addr ${addrToken})\n`));

            // Set breakpoint at next line (always use slot 2)
            try {
                await this._ensureBreakpointsEnabled();
            } catch (e) {
                // non-fatal
            }

            // Set new breakpoint (will overwrite slot 2 if it exists)
            const cmd = `set-breakpoint 2 PC=${hexNoPrefix}H`;
            this.sendEvent(new OutputEvent(`> ${cmd}\n`, 'console'));
            
            try {
                const resp = await this._sendCommandAndWait(cmd);
                const lower = String(resp || '').toLowerCase();
                
                if (lower.includes('unknown command') || lower.includes('error')) {
                    this.sendEvent(new OutputEvent(`[Debug] set-breakpoint no soportado, usando fallback\n`));
                    await this._sendCommand(`break set ${hexNoPrefix}H`);
                }
            } catch (e) {
                this.sendEvent(new OutputEvent(`[Debug] Error estableciendo breakpoint: ${e.message}\n`, 'stderr'));
                this.sendResponse(response);
                return;
            }

            // Execute run - will stop at the breakpoint
            this.sendEvent(new OutputEvent(`> run\n`, 'console'));
            await this._sendCommand('run');

            // Update current line
            this._lastBasLine = nextBasLine;

            this.sendResponse(response);
        } catch (err) {
            this.sendEvent(new OutputEvent(`[Debug] Error en nextRequest: ${err.message}\n`, 'stderr'));
            this.sendResponse(response);
        }
    }

    async stepInRequest(response, args) {
        await this._sendCommand('cpu-step');
        this.sendResponse(response);
        this.sendEvent(new StoppedEvent('step', 1));
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
        // Prefer the known source file if available
        if (this._lastBasLine && this._sourceFile && fs.existsSync(this._sourceFile)) {
            source = new Source(path.basename(this._sourceFile), this._sourceFile);
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
            // Prefer exact main.bas (avoid selecting preprocessed files)
            for (const c of candidates) {
                if (!c) continue;
                if (c.toLowerCase().endsWith('.preprocessed.bas')) continue;
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
                            if (f.toLowerCase().endsWith('.preprocessed.bas')) continue;
                            if (!found) found = full; // keep first non-preprocessed as fallback
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
