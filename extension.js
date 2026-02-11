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

        vscode.window.showInformationMessage('🔧 Compilando Boriel Basic...');

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

        // Obtener la carpeta del workspace
        const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : process.cwd();

        // Determinar el archivo fuente a usar
        const editor = vscode.window.activeTextEditor;
        let sourceFilePath = null;
        
        if (mainFile) {
            sourceFilePath = path.isAbsolute(mainFile) ? mainFile : path.join(workspaceFolder, mainFile);
            if (!fs.existsSync(sourceFilePath)) {
                sourceFilePath = null;
            }
        }
        
        if (!sourceFilePath && editor && editor.document && editor.document.uri) {
            sourceFilePath = editor.document.uri.fsPath;
        }
        
        if (!sourceFilePath) {
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

        // Determinar binario del compilador según plataforma
        let bin;
        if (process.platform === 'win32') {
            console.log('Compilando en Windows');
            bin = path.join(__dirname, 'bin', 'zxbasic-windows', 'zxbc.exe');
        } else if (process.platform === 'linux') {
            console.log('Compilando en Linux');
            bin = path.join(__dirname, 'bin', 'zxbasic-linux', 'zxbc');
        } else if (process.platform === 'darwin') {
            console.log('Compilando en MacOS');
            bin = path.join(__dirname, 'bin', 'zxbasic-macos', 'zxbc');
        }

        // Crear carpeta de salida dist/
        const distFolder = path.join(workspaceFolder, 'dist');
        if (!fs.existsSync(distFolder)) {
            fs.mkdirSync(distFolder, { recursive: true });
        }

        const baseName = path.basename(sourceFilePath, '.bas');
        const effectiveOutputFormat = options.forceTap || outputFormat === 'tap' ? 'tap' : 'bin';
        const effectiveIncludeBasicLoader = includeBasicLoader || options.forceTap;
        const effectiveAutorun = options.forceAutorun === true ? true : (options.noAutorun === true ? false : autorun);
        const outputExt = effectiveOutputFormat === 'tap' ? '.tap' : '.bin';
        const outputFile = path.join(distFolder, baseName + outputExt);

        // Construir comando de compilación
        const args = [
            `-O=${optimizeLevel}`,
            `-S=${org}`,
            `-H=${heapSize}`,
            effectiveIncludeBasicLoader ? '-B' : '',
            effectiveAutorun ? '-a' : '',
            effectiveOutputFormat === 'tap' ? '-t' : '-T',
        ].filter(arg => arg !== '');

        const command = `${bin} ${args.join(' ')} "${sourceFilePath}" -o "${outputFile}"`;
        
        console.log(`[Compilación] Ejecutando comando: ${command}`);

        let outputChannel = vscode.window.createOutputChannel('Boriel Basic');
        outputChannel.clear();
        outputChannel.show(true);
        outputChannel.appendLine('=== Iniciando compilación ===');
        outputChannel.appendLine(`Archivo fuente: ${sourceFilePath}`);
        outputChannel.appendLine(`Archivo salida: ${outputFile}\n`);
        
        // Ejecutar compilación
        child_process.exec(command, { cwd: workspaceFolder }, (error, stdout, stderr) => {
            if (error) {
                outputChannel.appendLine(`✗ Error al compilar:\n${stderr}`);
                vscode.window.showErrorMessage(`Error al compilar: ${stderr}`);
                console.error(`[Compilación] Error: ${stderr}`);
                reject(new Error(stderr || 'Error al compilar'));
                return;
            }

            outputChannel.appendLine(`✓ Compilación completada: ${outputFile}\n`);
            outputChannel.appendLine(stdout || '');
            vscode.window.showInformationMessage(`✓ Compilación completada: ${path.basename(outputFile)}`);
            console.log(`[Compilación] Completada exitosamente`);
            resolve({ outputFile });
        });
    });
}

async function ensureZXP2BorielInstalled(context) {
    const venvPath = path.join(context.extensionPath, 'venv');
    const pythonPath = process.platform === 'win32'
        ? path.join(venvPath, 'Scripts', 'python.exe')
        : path.join(venvPath, 'bin', 'python3');
    const pipPath = process.platform === 'win32'
        ? path.join(venvPath, 'Scripts', 'pip.exe')
        : path.join(venvPath, 'bin', 'pip');

    return new Promise(async (resolve, reject) => {
        // Check if venv exists
        if (!fs.existsSync(venvPath)) {
            const createVenv = await vscode.window.showWarningMessage(
                'No se ha encontrado un entorno virtual para zxp2boriel. ¿Deseas crearlo ahora?',
                'Sí, crear',
                'No'
            );

            if (createVenv !== 'Sí, crear') {
                vscode.window.showInformationMessage('Operación cancelada.');
                reject(false);
                return;
            }

            // Create venv
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: "Creando entorno virtual...",
                    cancellable: false
                },
                async (progress) => {
                    return new Promise((venvResolve, venvReject) => {
                        child_process.exec(`python3 -m venv "${venvPath}"`, (error, stdout, stderr) => {
                            if (error) {
                                vscode.window.showErrorMessage(`Error al crear entorno virtual: ${stderr || error.message}`);
                                console.error('Venv creation error:', stderr);
                                venvReject(false);
                                reject(false);
                                return;
                            }
                            console.log('Venv created successfully');
                            venvResolve(true);
                        });
                    });
                }
            );
        }

        // Check if zxp2boriel is installed in the venv
        child_process.exec(`"${pythonPath}" -m zxp2boriel --help`, (error, stdout, stderr) => {
            if (!error) {
                // Already installed
                resolve(pythonPath);
                return;
            }

            // Not installed, ask user if they want to install it
            vscode.window.showWarningMessage(
                'La librería zxp2boriel no está instalada en el entorno virtual. ¿Deseas instalarla ahora?',
                'Sí, instalar',
                'No'
            ).then(async (choice) => {
                if (choice === 'Sí, instalar') {
                    // Install zxp2boriel in venv
                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: "Instalando zxp2boriel...",
                            cancellable: false
                        },
                        async (progress) => {
                            return new Promise((installResolve, installReject) => {
                                child_process.exec(`"${pipPath}" install zxp2boriel`, (installError, installStdout, installStderr) => {
                                    if (installError) {
                                        vscode.window.showErrorMessage(`Error al instalar zxp2boriel: ${installStderr || installError.message}`);
                                        console.error('Installation error:', installStderr);
                                        installReject(false);
                                        reject(false);
                                        return;
                                    }

                                    vscode.window.showInformationMessage('zxp2boriel instalado correctamente.');
                                    console.log('Installation output:', installStdout);
                                    installResolve(true);
                                    resolve(pythonPath);
                                });
                            });
                        }
                    );
                } else {
                    vscode.window.showInformationMessage('Instalación cancelada. No se puede exportar sin zxp2boriel.');
                    reject(false);
                }
            });
        });
    });
}

function getExportFormHTML(context) {
    const htmlPath = path.join(context.extensionPath, 'resources', 'export_form.html');
    return fs.readFileSync(htmlPath, 'utf-8');
}

async function exportZXPToBoriel(uri, context) {
    try {
        // Check if zxp2boriel is installed, and install if needed
        const pythonPath = await ensureZXP2BorielInstalled(context);
        if (!pythonPath) {
            return; // User cancelled or installation failed
        }

        const inputFile = uri.fsPath;
        const inputFileName = path.basename(inputFile, '.zxp');

        // Create a webview panel
        const panel = vscode.window.createWebviewPanel(
            'zxpExport',
            'Export ZXP to Boriel Basic',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // Set the webview's HTML content
        panel.webview.html = getExportFormHTML(context);

        // Handle messages from the webview
        panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'cancel':
                        panel.dispose();
                        return;

                    case 'export':
                        const { width, rows, cols, name, skipAttributes } = message;

                        // Ask where to save the output file
                        const outputUri = await vscode.window.showSaveDialog({
                            defaultUri: vscode.Uri.file(path.join(path.dirname(inputFile), `${name}.bas`)),
                            filters: {
                                'Boriel Basic Files': ['bas'],
                                'All Files': ['*']
                            }
                        });

                        if (!outputUri) {
                            return; // User cancelled save dialog
                        }

                        const outputFile = outputUri.fsPath;

                        // Close the panel
                        panel.dispose();

                        // Build the command
                        const args = [
                            '-i', `"${inputFile}"`,
                            '-w', width,
                            '-r', rows,
                            '-c', cols,
                            '-o', `"${outputFile}"`,
                            '-n', name
                        ];

                        if (skipAttributes) {
                            args.push('--no-attributes');
                        }

                        const command = `"${pythonPath}" -m zxp2boriel ${args.join(' ')}`;
                        console.log(`Executing command: ${command}`);

                        // Show progress
                        await vscode.window.withProgress(
                            {
                                location: vscode.ProgressLocation.Notification,
                                title: "Exporting ZXP to Boriel Basic...",
                                cancellable: false
                            },
                            async (progress) => {
                                return new Promise((resolve, reject) => {
                                    child_process.exec(command, (error, stdout, stderr) => {
                                        if (error) {
                                            vscode.window.showErrorMessage(`Error exporting ZXP: ${stderr || error.message}`);
                                            console.error(`Error: ${stderr}`);
                                            reject(error);
                                            return;
                                        }

                                        vscode.window.showInformationMessage(`ZXP exported successfully to ${path.basename(outputFile)}`);
                                        console.log(`Output: ${stdout}`);

                                        // Open the generated file
                                        vscode.workspace.openTextDocument(outputFile).then(doc => {
                                            vscode.window.showTextDocument(doc);
                                        });

                                        resolve();
                                    });
                                });
                            }
                        );
                        return;
                }
            },
            undefined,
            context.subscriptions
        );

    } catch (error) {
        vscode.window.showErrorMessage(`Error: ${error.message}`);
        console.error('Export error:', error);
    }
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

    // Registrar hover provider antes de iniciar el LSP
    const hoverProvider = vscode.languages.registerHoverProvider('borielbasic', {
        async provideHover(document, position, token) {
            // Obtener la palabra en la posición actual
            const wordRange = document.getWordRangeAtPosition(position);
            const word = wordRange ? document.getText(wordRange) : '';

            // Intentar obtener información del LSP si está disponible
            if (client && client.state === 2) { // 2 = Running
                try {
                    const params = {
                        textDocument: {
                            uri: document.uri.toString()
                        },
                        position: {
                            line: position.line,
                            character: position.character
                        }
                    };

                    const result = await client.sendRequest('textDocument/hover', params);

                    if (result && result.contents) {
                        // Extraer el contenido del LSP
                        let lspContent;
                        if (typeof result.contents === 'string') {
                            lspContent = result.contents;
                        } else if (Array.isArray(result.contents)) {
                            lspContent = result.contents.map(c => typeof c === 'string' ? c : c.value).join('\n\n');
                        } else if (result.contents.value) {
                            lspContent = result.contents.value;
                        } else {
                            lspContent = JSON.stringify(result.contents);
                        }

                        return new vscode.Hover(new vscode.MarkdownString(lspContent), result.range);
                    }
                } catch (error) {
                    console.error('[Boriel Basic] Error al obtener hover del LSP:', error);
                }
            }

            // Si el LSP no devolvió información, retornar null (no mostrar hover)
            return null;
        }
    });
    context.subscriptions.push(hoverProvider);

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

    // Registrar el comando "borielBasic.exportZXPToBoriel"
    const exportZXPCommand = vscode.commands.registerCommand('borielBasic.exportZXPToBoriel', (uri) => {
        exportZXPToBoriel(uri, context);
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
        const zesaruxCmd = `${zesaruxPath} --enable-remoteprotocol --remoteprotocol-port=${debugPort} --noconfigfile --machine 128k --no-realvideo --tape ${program}`;
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
        exportZXPCommand,
        launchZesaruxCommand
    );
    console.log('[Extension] DebugAdapterDescriptorFactory registrado para borielbasic');
    console.log('[Extension] activate FIN');
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