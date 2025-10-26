    // Generar archivo .map para Dezog tras compilar ASM
    function generateDezogMap(linemapPath, asmPath, mapPath, orgAddr = 32768) {
        if (!fs.existsSync(linemapPath) || !fs.existsSync(asmPath)) return;
        const linemap = JSON.parse(fs.readFileSync(linemapPath, 'utf8'));
        const asmLines = fs.readFileSync(asmPath, 'utf8').split('\n');
        // Calcular offset por línea ASM (asume 1 byte por instrucción)
        let offset = 0;
        const asmLineToOffset = {};
        asmLines.forEach((line, idx) => {
            const l = line.trim();
            if (l && !l.startsWith(';') && !l.startsWith('#') && !l.startsWith('END') && !l.startsWith('ASM')) {
                asmLineToOffset[idx + 1] = offset;
                offset += 1;
            }
        });
        let mapText = '; Dezog MAP: Boriel line -> address\n';
        for (const borielLine in linemap) {
            const asmLinesArr = linemap[borielLine];
            for (const asmLine of asmLinesArr) {
                const addr = orgAddr + (asmLineToOffset[asmLine] || 0);
                mapText += `LINE ${borielLine} $${addr.toString(16).padStart(4, '0').toUpperCase()}\n`;
            }
        }
        fs.writeFileSync(mapPath, mapText, 'utf8');
    }
const path = require('path');
const vscode = require('vscode');
const {
    LanguageClient,
    TransportKind
} = require('vscode-languageclient/node');
const child_process = require('child_process');
const fs = require('fs');
const net = require('net');

let client;

function compileBorielBasic(options = {}) {
    return new Promise((resolve, reject) => {
        console.log('==========================================');
        console.log('[COMPILACIÓN] FUNCIÓN compileBorielBasic INICIADA');
        console.log('==========================================');

        vscode.window.showInformationMessage('🔧 COMPILACIÓN INICIADA - compileBorielBasic ejecutándose');

        // Obtener configuraciones del usuario
        const config = vscode.workspace.getConfiguration('borielBasic');
        const mainFile = config.get('mainFile');
        const optimizeLevel = config.get('optimizeLevel');
        const outputFormat = config.get('outputFormat');
        const autorun = config.get('autorun');
        const org = config.get('org');
        const includeBasicLoader = config.get('includeBasicLoader');
        const heapSize = config.get('heapSize');

        console.log('[Compilación] Configuración:', { mainFile, optimizeLevel, outputFormat });

        // Obtener la carpeta del workspace lo antes posible (se usa más abajo)
    const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : process.cwd();

    // Determinar el archivo fuente a usar: preferir la configuración 'mainFile' si existe,
    // en caso contrario usar el archivo activo en el editor si hay uno abierto.
    const editor = vscode.window.activeTextEditor;
    let sourceFilePath = null;
    if (mainFile) {
        sourceFilePath = path.isAbsolute(mainFile) ? mainFile : path.join(workspaceFolder, mainFile);
        if (!fs.existsSync(sourceFilePath)) {
            // si la ruta de configuración no existe, no fallar inmediatamente: intentar usar el editor activo
            sourceFilePath = null;
        }
    }
    if (!sourceFilePath && editor && editor.document && editor.document.uri) {
        sourceFilePath = editor.document.uri.fsPath;
    }
    if (!sourceFilePath) {
        // Intentar heurística: preferir main.bas en la raíz del workspace (útil cuando el usuario abre 'test' como workspace),
        // y como alternativa mantener compatibilidad con el repo que guarda el ejemplo en test/main.bas
        const workspaceMain = path.join(workspaceFolder, 'main.bas');
        if (fs.existsSync(workspaceMain)) {
            sourceFilePath = workspaceMain;
        } else {
            const testMain = path.join(workspaceFolder, 'test', 'main.bas');
            if (fs.existsSync(testMain)) {
                sourceFilePath = testMain;
            }
        }
    }

    if (!sourceFilePath) {
        const msg = 'No se pudo determinar el archivo fuente a compilar. Configura "borielBasic.mainFile" o abre el archivo a compilar.';
        vscode.window.showErrorMessage(msg);
        reject(new Error(msg));
        return;
    }

    // Comprobar el sistema operativo para ejecutar bin/zxbc.exe .linix o .macos

    if (process.platform === 'win32') {
        // Windows
        console.log('Compilando en Windows');
        bin = path.join(__dirname, 'bin', 'zxbasic-windows', 'zxbc.exe');
    }
    else if (process.platform === 'linux') {
        // Linux
        console.log('Compilando en Linux');
        bin = path.join(__dirname, 'bin', 'zxbasic-linux', 'zxbc');
    }
    else if (process.platform === 'darwin') {
        // MacOS
        console.log('Compilando en MacOS');
        bin = path.join(__dirname, 'bin', 'zxbasic-macos', 'zxbc');
    }

    // Usar dist/ en la raíz del workspace como carpeta de salida
    const distFolder = path.join(workspaceFolder, 'dist');
    if (!fs.existsSync(distFolder)) {
        fs.mkdirSync(distFolder, { recursive: true });
    }

    // Construir la ruta absoluta del archivo fuente (usamos sourceFilePath resuelto arriba)
    const mainFilePath = sourceFilePath;

    const baseName = path.basename(mainFilePath, '.bas');
    // Decide output format: respect user setting, but allow caller to force TAP (for debugger runs)
    const forceTap = options.forceTap === true;
    const effectiveOutputFormat = forceTap || outputFormat === 'tap' ? 'tap' : 'bin';
    // Determine effective flags. Caller can request forceAutorun (manual compile).
    // Always respect the user's configured includeBasicLoader, but if forceTap is requested
    // ensure the loader is included as well.
    const effectiveIncludeBasicLoader = includeBasicLoader || forceTap;
    // Respect explicit forceAutorun; otherwise use the user's setting. Do NOT silently disable
    // autorun when forceTap is used — the caller should opt-out explicitly by passing options.noAutorun.
    const effectiveAutorun = (options.forceAutorun === true) ? true : (options.noAutorun === true ? false : autorun);
    const outputExt = effectiveOutputFormat === 'tap' ? '.tap' : '.bin';
    const outputFile = path.join(distFolder, baseName + outputExt);
    const asmFile = path.join(distFolder, baseName + '.asm');
    const asmFilePath = path.join(distFolder, baseName + '.asm');
    const preprocessedFile = path.join(distFolder, baseName + '.preprocessed.bas');
    const lineMapFile = path.join(distFolder, baseName + '.linemap.json');

    // Pre-procesar el archivo .bas para añadir marcadores de línea
    console.log('[Compilación] Pre-procesando archivo para debug...');
    console.log('[Compilación] mainFilePath:', mainFilePath);
    console.log('[Compilación] preprocessedFile:', preprocessedFile);
    
    try {
        const sourceContent = fs.readFileSync(mainFilePath, 'utf8');
        const sourceLines = sourceContent.split('\n');
        const preprocessedLines = [];
        
        sourceLines.forEach((line, index) => {
            const originalLineNumber = index + 1;
            const trimmedLine = line.trim();

            // Solo añadir marcadores para líneas de código real (no vacías, no comentarios)
            if (trimmedLine && !trimmedLine.startsWith("'") && !trimmedLine.startsWith('REM')) {
                // Añadir marcador ANTES de la línea de código
                preprocessedLines.push(`ASM`);
                preprocessedLines.push(`; __BASLINE:${originalLineNumber}__`);
                preprocessedLines.push(`END ASM`);
            }

            // Añadir la línea original
            preprocessedLines.push(line);
        });
        
        fs.writeFileSync(preprocessedFile, preprocessedLines.join('\n'), 'utf8');
        
        console.log(`[Compilación] ✓ Archivo pre-procesado guardado en: ${preprocessedFile}`);
        console.log(`[Compilación] ✓ Total de líneas originales: ${sourceLines.length}`);
        console.log(`[Compilación] ✓ Preview de preprocessed:`);
        console.log(preprocessedLines.slice(0, 20).join('\n'));
    } catch (preError) {
        console.error('[Compilación] ✗ Error en pre-procesamiento:', preError);
        const message = preError && preError.message ? preError.message : String(preError);
        vscode.window.showErrorMessage(`Error al pre-procesar: ${message}`);
        reject(new Error(message));
        return;
    }

    // Construir el comando de compilación para .tap usando el archivo fuente original
    // (evita usar un .preprocessed viejo por error). Generaremos el .tap a partir
    // del `mainFilePath`, y generaremos el .asm a partir del archivo preprocesado
    // (que sí contiene los marcadores para mapear líneas).
    const args = [
        `-O=${optimizeLevel}`,
        `-S=${org}`,
        `-H=${heapSize}`,
    effectiveIncludeBasicLoader ? '-B' : '',
    effectiveAutorun ? '-a' : '',
        // Use -t or -T depending on effectiveOutputFormat
        effectiveOutputFormat === 'tap' ? '-t' : '-T',
    ].filter(arg => arg !== ''); // Eliminar argumentos vacíos
    // Para evitar usar un preprocessed viejo que pudiera existir en dist/, compilamos
    // el TAP directamente desde el archivo fuente original (`mainFilePath`).
    const command = `${bin} ${args.join(' ')} "${mainFilePath}" -o "${outputFile}"`;
    
    // Comando adicional para generar el .asm usando el archivo pre-procesado
    const asmArgs = [
        `-O=${optimizeLevel}`,
        `-S=${org}`,
        `-H=${heapSize}`,
        '-A', // Genera .asm
    ].filter(arg => arg !== '');
    // Generar ASM usando el archivo preprocesado (contiene marcadores __BASLINE)
    const asmCommand = `${bin} ${asmArgs.join(' ')} "${preprocessedFile}" -o "${asmFile}"`;
    
    console.log(`[Compilación] Ejecutando comando TAP: ${command}`);
    console.log(`[Compilación] Ejecutando comando ASM: ${asmCommand}`);
    console.log(`[Compilación] ASM File path: ${asmFile}`);

    let outputChannel = vscode.window.createOutputChannel('Boriel Basic');
    outputChannel.clear();
    outputChannel.show(true);
    outputChannel.appendLine('=== Iniciando compilación ===');
    outputChannel.appendLine(`Archivo fuente: ${mainFilePath}`);
    outputChannel.appendLine(`Archivo pre-procesado: ${preprocessedFile}`);
    outputChannel.appendLine(`Archivo TAP: ${outputFile}`);
    outputChannel.appendLine(`Archivo ASM: ${asmFile}`);
    outputChannel.appendLine(`Mapeo de líneas: ${lineMapFile}\n`);
    
    // Ejecutar el comando para .tap
    child_process.exec(command, { cwd: workspaceFolder }, (error, stdout, stderr) => {
        if (error) {
            outputChannel.appendLine(`✗ Error al compilar TAP:\n${stderr}`);
            vscode.window.showErrorMessage(`Error al compilar: ${stderr}`);
            console.error(`[Compilación] Error: ${stderr}`);
            reject(new Error(stderr || 'Error al compilar TAP'));
            return;
        }

        outputChannel.appendLine(`✓ Compilación TAP completada: ${outputFile}\n`);
        outputChannel.appendLine(stdout || '');

        // Ahora compilar el .asm
        outputChannel.appendLine(`\n=== Generando archivo ASM ===`);
        outputChannel.appendLine(`Comando: ${asmCommand}\n`);
        child_process.exec(asmCommand, { cwd: workspaceFolder }, (asmError, asmStdout, asmStderr) => {
            if (asmError) {
                outputChannel.appendLine(`\n✗ Error al generar ASM:\n${asmStderr}`);
                console.error(`[Compilación] Error ASM: ${asmStderr}`);
                vscode.window.showWarningMessage(`TAP compilado, pero ASM falló: ${asmStderr}`);
                // Even if ASM fails, resolve with TAP path so debugger can run
                resolve({ outputFile, asmFile: null, binFile: null });
                return;
            }
            outputChannel.appendLine(`\n✓ Compilación ASM completada: ${asmFile}\n`);
            outputChannel.appendLine(asmStdout || '');
            console.log(`[Compilación] Salida ASM: ${asmStdout}`);

            // Generar el mapeo línea a línea
            try {
                const lineMap = generateLineMap(asmFilePath);
                fs.writeFileSync(lineMapFile, JSON.stringify(lineMap, null, 2), 'utf8');
                outputChannel.appendLine(`\n✓ Mapeo de líneas generado: ${lineMapFile}\n`);
                outputChannel.appendLine(`   Total de líneas Boriel mapeadas: ${Object.keys(lineMap).length}\n`);
                console.log(`[Compilación] Mapeo generado: ${Object.keys(lineMap).length} entradas`);
            } catch (mapError) {
                outputChannel.appendLine(`\n⚠ No se pudo generar el mapeo de líneas: ${mapError.message}\n`);
                console.error(`[Compilación] Error generando mapeo: ${mapError}`);
            }

            // Ensamblar ASM con zxbasm para generar binario y listado
            const zxbasmPath = path.join(__dirname, 'bin', 'zxbasic-linux', 'zxbasm'); // Ajusta para tu SO si es necesario
            const binFile = path.join(distFolder, baseName + '.bin');
            const lstFile = path.join(distFolder, baseName + '.lst');
            const zxbasmCmd = `${zxbasmPath} ${asmFilePath} -o ${binFile}`;
            outputChannel.appendLine(`\n=== Ensamblando ASM con zxbasm ===`);
            outputChannel.appendLine(`Comando: ${zxbasmCmd}\n`);
            child_process.exec(zxbasmCmd, { cwd: workspaceFolder }, (zxError, zxStdout, zxStderr) => {
                if (zxError) {
                    outputChannel.appendLine(`\n✗ Error al ensamblar ASM con zxbasm:\n${zxStderr}`);
                    vscode.window.showWarningMessage(`ASM generado, pero zxbasm falló: ${zxStderr}`);
                    // Resolve with asmFile present but no bin
                    resolve({ outputFile, asmFile: asmFilePath, binFile: null });
                } else {
                    outputChannel.appendLine(`\n✓ Ensamblado ASM completado: ${binFile}`);
                    outputChannel.appendLine(zxStdout || '');
                    vscode.window.showInformationMessage(`Compilación completada: ${outputFile} + ${asmFile} + ${binFile}`);
                    // Generar el archivo .map para Dezog
                    const dezogMapPath = path.join(distFolder, baseName + '.dezog.map');
                    generateDezogMap(lineMapFile, asmFilePath, dezogMapPath, org);
                    outputChannel.appendLine(`\n✓ Mapeo Dezog generado: ${dezogMapPath}`);
                    resolve({ outputFile, asmFile: asmFilePath, binFile });
                }
            });
        });
    });
    });
}

function generateLineMap(asmFilePath) {
    const asmContent = fs.readFileSync(asmFilePath, 'utf8');
    const asmLines = asmContent.split('\n');
    const lineMap = {};
    
    let currentBorielLine = null;
    
    asmLines.forEach((line, asmIndex) => {
        // Buscar nuestros marcadores personalizados: ; __BASLINE:N__
        const basLineMatch = line.match(/;\s*__BASLINE:(\d+)__/);
        if (basLineMatch) {
            currentBorielLine = parseInt(basLineMatch[1]);
            console.log(`[LineMap] Encontrado marcador BASLINE:${currentBorielLine} en ASM línea ${asmIndex + 1}`);
            return; // El marcador mismo no cuenta como línea de código
        }
        
        // Si NO estamos dentro de un bloque marcado, ignorar esta línea
        if (currentBorielLine === null) {
            return;
        }
        
        // Si esta línea tiene código real (no comentario, no directiva, no vacía)
        const trimmed = line.trim();
        if (trimmed && 
            !trimmed.startsWith(';') && 
            !trimmed.startsWith('#') &&
            !trimmed.startsWith('.') &&  // Ignorar etiquetas de biblioteca
            trimmed !== 'END ASM' &&
            trimmed !== 'ASM') {
            
            if (!lineMap[currentBorielLine]) {
                lineMap[currentBorielLine] = [];
            }
            lineMap[currentBorielLine].push(asmIndex + 1);
            console.log(`[LineMap] Línea Boriel ${currentBorielLine} -> ASM línea ${asmIndex + 1}: ${trimmed.substring(0, 40)}`);
        }
    });
    
    console.log(`[LineMap] Total líneas Boriel mapeadas: ${Object.keys(lineMap).length}`);
    Object.keys(lineMap).forEach(borielLine => {
        console.log(`[LineMap] Boriel ${borielLine}: ${lineMap[borielLine].length} líneas ASM`);
    });
    
    return lineMap;
}

function updateLSP(context) {
    vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "Comprobando actualizaciones para Boriel Basic LSP...",
            cancellable: false
        },
        async (progress) => {
            try {
                const extensionPath = context.extensionPath;
                const localNodeModules = path.join(extensionPath, 'node_modules');
                const localBorielLSP = path.join(localNodeModules, 'boriel-basic-lsp');
                const packageJsonPath = path.join(localBorielLSP, 'package.json');

                // Verificar la versión instalada localmente leyendo el package.json
                let currentVersion = null;
                if (fs.existsSync(packageJsonPath)) {
                    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
                    currentVersion = packageJson.version;
                } else {
                    console.log("No se encontró una instalación local de boriel-basic-lsp.");
                }

                // Obtener la última versión publicada
                const latestVersion = child_process.execSync('npm show boriel-basic-lsp version', { encoding: 'utf-8' }).trim();

                if (currentVersion === latestVersion) {
                    vscode.window.showInformationMessage(`Ya tienes la última versión de Boriel Basic LSP (${currentVersion}).`);
                    return;
                }

                progress.report({ message: `Eliminando la versión actual de Boriel Basic LSP (${currentVersion || 'ninguna'})...` });

                // Eliminar la carpeta boriel-basic-lsp si existe
                if (fs.existsSync(localBorielLSP)) {
                    fs.rmSync(localBorielLSP, { recursive: true, force: true });
                    console.log("Carpeta boriel-basic-lsp eliminada.");
                }

                progress.report({ message: `Instalando Boriel Basic LSP versión ${latestVersion}...` });

                // Instalar la última versión
                child_process.execSync(`npm install boriel-basic-lsp@${latestVersion}`, {
                    cwd: extensionPath,
                    stdio: 'inherit'
                });

                vscode.window.showInformationMessage(`Boriel Basic LSP actualizado correctamente a la versión ${latestVersion}.`);
            } catch (error) {
                console.error("Error al actualizar Boriel Basic LSP:", error);
                vscode.window.showErrorMessage(`Error al actualizar Boriel Basic LSP: ${error.message}`);
            }
        }
    );
}

function activate(context) {
    let serverModule;

    // Intentar resolver el módulo boriel-basic-lsp localmente
    try {
        serverModule = require.resolve('boriel-basic-lsp');
        console.log('Ruta del servidor LSP (local):', serverModule);
    } catch (error) {
        console.error('Error al resolver boriel-basic-lsp localmente:', error);

        // Si no se encuentra localmente, buscar en las dependencias globales
        try {
            const globalNodeModules = child_process.execSync('npm root -g').toString().trim();
            serverModule = path.join(globalNodeModules, 'boriel-basic-lsp');
            console.log('Ruta del servidor LSP (global):', serverModule);

            // Verificar si el módulo existe en la ruta global
            require.resolve(serverModule);
        } catch (globalError) {
            console.error('Error al resolver boriel-basic-lsp globalmente:', globalError);
        }
    }

    console.log('[Extension] activate INICIO');
    console.log('Ruta del servidor LSP:', serverModule);

    if (!serverModule) {
        throw new Error('No se pudo resolver el módulo boriel-basic-lsp. Asegúrate de que esté instalado.');
    }

    // Obtener la carpeta del espacio de trabajo activo
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspacePath = workspaceFolders ? workspaceFolders[0].uri.fsPath : null;

    // Opciones del servidor
    const serverOptions = {
        run: {
            module: serverModule,
            transport: TransportKind.ipc,
            args: workspacePath ? [workspacePath] : [] // Pasar la ruta del proyecto al servidor
        },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            args: workspacePath ? [workspacePath] : [] // Pasar la ruta del proyecto al servidor
        }
    };

    const config = vscode.workspace.getConfiguration('borielBasic');
    const formatKeywords = config.get('formatKeywords');

    // Opciones del cliente
    const clientOptions = {
        documentSelector: [{ scheme: 'file', language: 'borielbasic' }],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.bas')
        },
        initializationOptions: {
            formatOptions: {
                formatKeywords: formatKeywords
            }
        }
    };

    // Crear el cliente LSP
    client = new LanguageClient(
        'borielBasicLanguageServer',
        'Boriel Basic Language Client',
        serverOptions,
        clientOptions
    );

    // Iniciar el cliente
    client.start();

    // Registrar el comando "borielBasic.compile"
    console.log('[Extension] Registrando comando borielBasic.compile');
    const compileCommand = vscode.commands.registerCommand('borielBasic.compile', () => {
        console.log('[Extension] Comando borielBasic.compile ejecutado (forzando autorun)');
        // Cuando el usuario ejecuta el comando manual de compilación desde la extensión
        // preferimos generar un .tap listo para ejecutar en un emulador (con autorun).
        compileBorielBasic({ forceAutorun: true });
    });

    // Registrar el comando "borielBasic.updateLSP"
    const updateLSPCommand = vscode.commands.registerCommand('borielBasic.updateLSP', () => {
        updateLSP(context);
    });

    // Registrar comando para lanzar ZEsarUX
    const launchZesaruxCommand = vscode.commands.registerCommand('borielBasic.launchZesarux', (config) => {
        // Leer configuración desde argumentos o usar valores por defecto
        const zesaruxPath = config?.zesaruxPath || '/home/raul/bin/zesarux/zesarux';
        const debugPort = config?.debugPort || 10000;
        const program = config?.program;
        if (!zesaruxPath || !program) {
            vscode.window.showErrorMessage('No se ha especificado la ruta de ZEsarUX o el archivo .tap.');
            return;
        }
        const zesaruxCmd = `${zesaruxPath} --enable-remoteprotocol --remoteprotocol-port=${debugPort} --noconfigfile --machine 128k --tape ${program}`;
        try {
            if (!fs.existsSync(zesaruxPath)) {
                vscode.window.showErrorMessage(`No se encuentra el ejecutable ZEsarUX en: ${zesaruxPath}`);
                return;
            }
            fs.accessSync(zesaruxPath, fs.constants.X_OK);
            const terminal = vscode.window.createTerminal({
                name: 'ZEsarUX',
                cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || undefined
            });
            terminal.sendText(zesaruxCmd);
            terminal.show();
            vscode.window.showInformationMessage(`ZEsarUX lanzado en terminal: ${zesaruxCmd}`);
        } catch (err) {
            vscode.window.showErrorMessage(`Error al lanzar ZEsarUX: ${err.message}`);
        }
    });

    // Registrar el DebugAdapterDescriptorFactory para 'borielbasic'
    const debugAdapterFactory = new InlineDebugAdapterFactory();
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('borielbasic', debugAdapterFactory),
        compileCommand,
        updateLSPCommand,
        launchZesaruxCommand
    );
    console.log('[Extension] DebugAdapterDescriptorFactory registrado para borielbasic');
    console.log('[Extension] activate FIN');
// Eliminada la factory Dezog, ahora el arranque es por comando
}

class InlineDebugAdapterFactory {
    createDebugAdapterDescriptor(_session) {
        console.log('[Extension] createDebugAdapterDescriptor llamado');
        try {
            const { BorielBasicDebugSession } = require('./debugAdapter');
            console.log('[Extension] BorielBasicDebugSession importado:', typeof BorielBasicDebugSession);
            const session = new BorielBasicDebugSession();
            console.log('[Extension] Instancia de BorielBasicDebugSession creada');
            return new vscode.DebugAdapterInlineImplementation(session);
        } catch (err) {
            console.log('[Extension] ERROR al crear BorielBasicDebugSession:', err);
            throw err;
        }
    }
}

function deactivate() {
    if (!client) {
        return undefined;
    }
    return client.stop();
}

module.exports = {
    activate,
    deactivate
};

// Factory para el debug adapter
class BorielBasicDebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(session, executable) {
        // Usar un servidor inline simple
        return new vscode.DebugAdapterServer(0);
    }
}

// Clase simple para manejar la sesión de debug
class BorielBasicDebugSession {
    constructor() {
        this._zesaruxProcess = null;
        this._debugSocket = null;
        this._sequenceNumber = 1;
    }

    async start(config) {
        // Usar ruta absoluta por defecto si no se especifica
        const defaultZesaruxPath = '/home/raul/bin/zesarux/zesarux';
        const zesaruxPath = config.zesaruxPath || defaultZesaruxPath;
        const debugPort = config.debugPort || 10000;
        let program = config.program;

        // Compilar el main.bas del workspace actual y dejar el .tap en dist/
        const workspaceFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const mainBas = path.join(workspaceFolder, 'main.bas');
        const distFolder = path.join(workspaceFolder, 'dist');
        if (!fs.existsSync(distFolder)) {
            fs.mkdirSync(distFolder, { recursive: true });
        }
        const outputTap = path.join(distFolder, 'main.tap');
        let bin;
        if (process.platform === 'win32') {
            bin = path.join(__dirname, 'bin', 'zxbasic-windows', 'zxbc.exe');
        } else if (process.platform === 'linux') {
            bin = path.join(__dirname, 'bin', 'zxbasic-linux', 'zxbc');
        } else if (process.platform === 'darwin') {
            bin = path.join(__dirname, 'bin', 'zxbasic-macos', 'zxbc');
        }
        // Comprobaciones previas
        if (!fs.existsSync(mainBas)) {
            const msg = `No se encuentra el archivo fuente: ${mainBas}`;
            vscode.window.showErrorMessage(msg);
            throw new Error(msg);
        }

        if (!fs.existsSync(bin)) {
            const msg = `No se encuentra el compilador zxbc en: ${bin}`;
            vscode.window.showErrorMessage(msg);
            throw new Error(msg);
        }

        // Crear canal de salida para debug
        let dbgOut = null;
        try {
            dbgOut = vscode.window.createOutputChannel('Boriel Debug');
            dbgOut.show(true);
            dbgOut.appendLine(`=== Compilación para debug iniciada (unificada) ===`);
        } catch (e) {
            console.log('[DebugStart] No se pudo crear OutputChannel:', e);
        }

        // Usar la función compileBorielBasic para unificar compilación y respetar settings
        // Para depuración con ZEsarUX mantener el autorun (-a) según indicación del autor de ZEsarUX,
        // de lo contrario el control vuelve a la ROM y no se puede depurar el programa.
        try {
            const res = await compileBorielBasic({ forceTap: true, forceAutorun: true });
            if (dbgOut) dbgOut.appendLine(`Compilación unificada completada: ${res.outputFile}`);
            program = res && res.outputFile ? res.outputFile : outputTap;
        } catch (err) {
            const message = err && err.message ? err.message : String(err);
            if (dbgOut) dbgOut.appendLine(`Error al compilar para debug: ${message}`);
            console.error('[DebugStart] Error compilando:', message);
            vscode.window.showErrorMessage(`Error al compilar para debug: ${message}`);
            throw err;
        }

        if (!fs.existsSync(program)) {
            const msg = `La compilación finalizó pero no se encontró ${program}`;
            if (dbgOut) dbgOut.appendLine(msg);
            throw new Error(msg);
        }

        // Comprobar existencia y permisos de ZEsarUX
        if (!fs.existsSync(zesaruxPath)) {
            vscode.window.showErrorMessage(`No se encuentra el ejecutable ZEsarUX en: ${zesaruxPath}`);
            throw new Error(`No se encuentra el ejecutable ZEsarUX en: ${zesaruxPath}`);
        }
        try {
            fs.accessSync(zesaruxPath, fs.constants.X_OK);
        } catch (permErr) {
            vscode.window.showErrorMessage(`El ejecutable ZEsarUX no tiene permisos de ejecución: ${zesaruxPath}`);
            throw new Error(`El ejecutable ZEsarUX no tiene permisos de ejecución: ${zesaruxPath}`);
        }

        // Iniciar ZEsarUX con el protocolo de debug remoto habilitado
        const zesaruxArgs = [
            '--enable-remoteprotocol',
            `--remoteprotocol-port=${debugPort}`,
            '--noconfigfile',
            '--machine', '128k',
            '--tape', program
        ];

        this._zesaruxProcess = child_process.spawn(zesaruxPath, zesaruxArgs);

        this._zesaruxProcess.on('error', (err) => {
            vscode.window.showErrorMessage(`Error al iniciar ZEsarUX: ${err.message}`);
        });

        // Esperar un momento para que ZEsarUX inicie
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Conectar al protocolo de debug remoto
        this._debugSocket = new net.Socket();

        // Leer la dirección ORG del proyecto para el primer breakpoint
        const org = config.org || 32768;
        // Enviar el comando de breakpoint en la primera dirección de código
        // El comando para ZEsarUX es: "break set <address>"
        // Parar en la primera instrucción del programa

        return new Promise((resolve, reject) => {
            this._debugSocket.connect(debugPort, 'localhost', () => {
                console.log('Conectado al protocolo de debug de ZEsarUX');
                // Pausar la CPU antes de establecer el breakpoint
                // Pausar la CPU antes de establecer el breakpoint
                this.sendCommand('cpu pause');
                // Intentar usar el nuevo protocolo de breakpoints, con formato sin prefijo (ZEsarUX espera '8000' en lugar de '0x8000')
                this.sendCommand('enable-breakpoints');
                this.sendCommand(`set-breakpoint 1 PC=${org.toString(16).toUpperCase()}H`);
                // Continuar la CPU (se detendrá en el breakpoint)
                this.sendCommand('cpu continue');
                resolve();
            });

            this._debugSocket.on('error', (err) => {
                reject(new Error(`Error de conexión: ${err.message}`));
            });
        });
    }

    stop() {
        if (this._debugSocket) {
            this._debugSocket.destroy();
            this._debugSocket = null;
        }

        if (this._zesaruxProcess) {
            this._zesaruxProcess.kill();
            this._zesaruxProcess = null;
        }
    }

    sendCommand(command) {
        if (this._debugSocket && !this._debugSocket.destroyed) {
            this._debugSocket.write(command + '\n');
        }
    }
}