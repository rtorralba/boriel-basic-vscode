const path = require('path');
const vscode = require('vscode');
const {
    LanguageClient,
    TransportKind
} = require('vscode-languageclient/node');
const child_process = require('child_process');
const fs = require('fs');
const net = require('net');
const https = require('https');
const turbo80Manager = require('./turbo80Manager');

let client;

const debugLineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(255, 215, 0, 0.22)',
    overviewRulerColor: 'rgba(255, 215, 0, 0.85)',
    overviewRulerLane: vscode.OverviewRulerLane.Full
});

function clearDebugDecorations() {
    vscode.window.visibleTextEditors.forEach(editor => {
        editor.setDecorations(debugLineDecoration, []);
    });
}

function highlightDebugPosition(sourceFile, lineNumber) {
    clearDebugDecorations();
    if (!sourceFile || !lineNumber || lineNumber < 1) return;

    const fileUri = vscode.Uri.file(sourceFile);
    const line0 = lineNumber - 1;

    vscode.workspace.openTextDocument(fileUri).then(doc => {
        if (line0 >= doc.lineCount) return;
        const lineText = doc.lineAt(line0).text;
        const lineRange = new vscode.Range(line0, 0, line0, lineText.length);

        const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath.toLowerCase() === sourceFile.toLowerCase());
        if (editor) {
            editor.setDecorations(debugLineDecoration, [lineRange]);
            editor.revealRange(lineRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        } else {
            vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true }).then(ed => {
                ed.setDecorations(debugLineDecoration, [lineRange]);
                ed.revealRange(lineRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            }, () => {});
        }
    }).catch(() => {});
}

function getBorielLaunchConfig(targetEmulator, folder) {
    const workspaceFolder = folder || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]);
    const launchConfigs = vscode.workspace.getConfiguration('launch', workspaceFolder?.uri).get('configurations') || [];
    if (targetEmulator) {
        const match = launchConfigs.find(c => c.type === 'borielbasic' && c.emulator === targetEmulator);
        if (match) return match;
    }
    return launchConfigs.find(c => c.type === 'borielbasic') || {};
}

function getProjectRootSourceFile(folder, targetEmulator) {
    const workspaceFolder = folder || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]);
    const rootDir = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();

    // 1. Prioridad: leer 'sourceFile' de launch.json
    const borielConfig = getBorielLaunchConfig(targetEmulator, workspaceFolder);
    if (borielConfig && borielConfig.sourceFile) {
        const p = path.isAbsolute(borielConfig.sourceFile)
            ? borielConfig.sourceFile
            : path.join(rootDir, borielConfig.sourceFile);
        if (fs.existsSync(p)) return p;
    }

    // 2. Revisar configuración 'borielBasic.mainFile' en settings.json
    const mainFileSetting = vscode.workspace.getConfiguration('borielBasic', workspaceFolder?.uri).get('mainFile');
    if (mainFileSetting && typeof mainFileSetting === 'string') {
        const p = path.isAbsolute(mainFileSetting)
            ? mainFileSetting
            : path.join(rootDir, mainFileSetting);
        if (fs.existsSync(p)) return p;
    }

    // 3. Buscar candidatos habituales de archivo raíz del proyecto
    const candidates = [
        path.join(rootDir, 'src', 'main.bas'),
        path.join(rootDir, 'main.bas'),
        path.join(rootDir, 'test', 'src', 'main.bas'),
        path.join(rootDir, 'test', 'main.bas'),
        path.join(rootDir, 'src', 'main.zxbas'),
        path.join(rootDir, 'main.zxbas')
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }

    // 4. Último recurso: usar el archivo activo del editor si es .bas / .zxbas
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document) {
        const docPath = editor.document.fileName;
        const ext = path.extname(docPath).toLowerCase();
        const lang = editor.document.languageId;
        if (ext === '.bas' || ext === '.zxbas' || lang === 'borielbasic' || lang === 'boriel-basic') {
            return docPath;
        }
    }

    return null;
}

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

        // Limpiar carpeta .debug en cada compilación para evitar residuos de sesiones anteriores
        try {
            const debugDir = path.join(workspaceFolder, '.debug');
            if (fs.existsSync(debugDir)) {
                fs.rmSync(debugDir, { recursive: true, force: true });
                console.log('[Compilación] Carpeta .debug limpiada');
            }
        } catch (e) {
            console.error('[Compilación] No se pudo limpiar .debug:', e);
        }

        // Determinar el archivo fuente a usar priorizando launch.json / root del proyecto
        let sourceFilePath = null;

        if (options.sourceFile && typeof options.sourceFile === 'string') {
            sourceFilePath = path.isAbsolute(options.sourceFile) ? options.sourceFile : path.join(workspaceFolder, options.sourceFile);
            if (!fs.existsSync(sourceFilePath)) {
                sourceFilePath = null;
            }
        }

        if (!sourceFilePath) {
            sourceFilePath = getProjectRootSourceFile(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]);
        }

        if (!sourceFilePath) {
            const msg = 'No se pudo determinar el archivo fuente a compilar. Define "sourceFile" en tu launch.json o configura "borielBasic.mainFile".';
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

        // Crear carpeta de salida dist/ (junto a src/ si el fuente está en src/)
        let distFolder = path.join(workspaceFolder, 'dist');
        const sourceDir = path.dirname(sourceFilePath);
        if (path.basename(sourceDir).toLowerCase() === 'src') {
            distFolder = path.join(path.dirname(sourceDir), 'dist');
        }
        if (!fs.existsSync(distFolder)) {
            fs.mkdirSync(distFolder, { recursive: true });
        }

        const baseName = path.basename(sourceFilePath, path.extname(sourceFilePath));
        const effectiveOutputFormat = options.forceTap || outputFormat === 'tap' ? 'tap' : 'bin';
        const effectiveIncludeBasicLoader = includeBasicLoader || options.forceTap;
        const effectiveAutorun = options.forceAutorun === true ? true : (options.noAutorun === true ? false : autorun);
        const outputExt = effectiveOutputFormat === 'tap' ? '.tap' : '.bin';
        const outputFile = path.join(distFolder, baseName + outputExt);

        // Construir comando de compilación
        const args = [
            `-O${optimizeLevel}`,
            `-S${org}`,
            `-H${heapSize}`,
            effectiveIncludeBasicLoader ? '-B' : '',
            effectiveAutorun ? '-a' : '',
            effectiveOutputFormat === 'tap' ? '--output-format=tap' : '-T',
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

// (Removed Python detection and venv management — using native binaries instead)

function getExportFormHTML(context) {
    const htmlPath = path.join(context.extensionPath, 'resources', 'export_form.html');
    return fs.readFileSync(htmlPath, 'utf-8');
}

async function ensureZXP2BorielBinary(context) {
    const binDir = path.join(context.extensionPath, 'bin');
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

    const platform = process.platform;
    const targetName = platform === 'win32' ? 'zxp2boriel.exe' : (platform === 'darwin' ? 'zxp2boriel-macos' : 'zxp2boriel-linux');
    const outPath = path.join(binDir, targetName);

    if (fs.existsSync(outPath)) {
        return outPath;
    }

    // Fetch latest release info from GitHub
    const apiUrl = 'https://api.github.com/repos/rtorralba/zxp2boriel/releases/latest';
    const headers = { 'User-Agent': 'vscode-extension', Accept: 'application/vnd.github.v3+json' };

    const release = await new Promise((resolve, reject) => {
        const req = https.get(apiUrl, { headers }, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
    }).catch(err => { vscode.window.showErrorMessage('No se pudo obtener la información de releases desde GitHub: ' + err.message); return null; });

    if (!release || !Array.isArray(release.assets)) {
        vscode.window.showErrorMessage('No se encontró información válida de releases en GitHub para zxp2boriel.');
        return null;
    }

    // Choose asset by platform keywords
    const assets = release.assets;
    let chosen = null;
    for (const a of assets) {
        const n = (a.name || '').toLowerCase();
        if (platform === 'win32' && (n.includes('win') || n.includes('windows') || n.endsWith('.exe'))) { chosen = a; break; }
        if (platform === 'linux' && (n.includes('linux') || n.includes('x86') || n.includes('amd64') || n.includes('x86_64'))) { chosen = a; break; }
        if (platform === 'darwin' && (n.includes('mac') || n.includes('darwin') || n.includes('macos'))) { chosen = a; break; }
    }

    if (!chosen) {
        vscode.window.showErrorMessage('No se encontró un binario compatible para tu sistema en las releases de zxp2boriel.');
        return null;
    }

    const downloadUrl = chosen.browser_download_url;
    try {
        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(outPath, { mode: 0o755 });
            const req = https.get(downloadUrl, { headers }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    // follow redirect
                    https.get(res.headers.location, { headers }, (r2) => r2.pipe(file).on('finish', resolve)).on('error', reject);
                    return;
                }
                if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
                res.pipe(file);
                file.on('finish', () => { file.close(resolve); });
            });
            req.on('error', (e) => { try { fs.unlinkSync(outPath); } catch (_) { }; reject(e); });
        });
        if (process.platform !== 'win32') {
            try { fs.chmodSync(outPath, 0o755); } catch (e) { /* ignore */ }
        }
        vscode.window.showInformationMessage('Binario zxp2boriel descargado correctamente.');
        return outPath;
    } catch (err) {
        vscode.window.showErrorMessage('Error descargando zxp2boriel: ' + (err.message || err));
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) { }
        return null;
    }
}

async function updateZXP2BorielBinary(context) {
    const binDir = path.join(context.extensionPath, 'bin');
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
    const platform = process.platform;
    const targetName = platform === 'win32' ? 'zxp2boriel.exe' : (platform === 'darwin' ? 'zxp2boriel-macos' : 'zxp2boriel-linux');
    const outPath = path.join(binDir, targetName);

    const choice = await vscode.window.showWarningMessage(
        '¿Deseas forzar la actualización del binario zxp2boriel? Se descargará la última versión desde GitHub.',
        'Sí, actualizar', 'Cancelar'
    );
    if (choice !== 'Sí, actualizar') {
        return null;
    }

    try {
        if (fs.existsSync(outPath)) {
            try { fs.unlinkSync(outPath); } catch (e) { console.warn('No se pudo eliminar binario antiguo:', e); }
        }
        const downloaded = await ensureZXP2BorielBinary(context);
        if (downloaded) {
            vscode.window.showInformationMessage('zxp2boriel actualizado correctamente.');
            return downloaded;
        }
        return null;
    } catch (e) {
        vscode.window.showErrorMessage('Error actualizando zxp2boriel: ' + (e && e.message ? e.message : e));
        console.error('updateZXP2BorielBinary error:', e);
        return null;
    }
}

async function exportZXPToBoriel(uri, context) {
    try {
        // Ensure we have a native zxp2boriel binary for this OS
        const binPath = await ensureZXP2BorielBinary(context);
        if (!binPath) {
            return; // User cancelled or download failed
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
                        const { width, rows, cols, name, skipAttributes, matrix } = message;

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

                        if (matrix) {
                            args.push('--matrix');
                        }

                        const command = `"${binPath}" ${args.join(' ')}`;
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
                                            vscode.window.showErrorMessage(`Error al ejecutar zxp2boriel: ${stderr || error.message}`);
                                            console.error('zxp2boriel error:', stderr || error.message);
                                            reject(error);
                                            return;
                                        }
                                        vscode.window.showInformationMessage(`ZXP exported successfully to ${path.basename(outputFile)}`);
                                        console.log(`Output: ${stdout}`);
                                        vscode.workspace.openTextDocument(outputFile).then(doc => vscode.window.showTextDocument(doc));
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

    // Hover is provided by the LanguageClient; do not register a manual hover provider

    // Crear el cliente LSP
    client = new LanguageClient(
        'borielBasicLanguageServer',
        'Boriel Basic Language Client',
        serverOptions,
        clientOptions
    );

    // Iniciar el cliente
    client.start();

    // Reindexar al guardar: intentar notificar al LSP con una petición custom
    // y, si falla, reiniciar el cliente para forzar reindexado.
    async function triggerReindexOnSave() {
        if (!client) return;
        try {
            // Intentamos enviar una petición personalizada 'workspace/reindex'
            // Muchos LSPs soportan acciones custom; si el servidor no la soporta
            // el envío fallará y haremos el reinicio como fallback.
            await client.sendRequest('workspace/reindex', { path: workspacePath });
            console.log('[Boriel Basic] Petición workspace/reindex enviada al LSP');
            return;
        } catch (err) {
            console.log('[Boriel Basic] workspace/reindex no soportado o fallo, reiniciando LSP:', err && err.message ? err.message : err);
        }

        // Fallback: reiniciar el cliente para forzar reindexado
        const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        statusItem.text = '$(sync~spin) Reindexando Boriel Basic...';
        statusItem.show();
        try {
            try { await client.stop(); } catch (e) { /* ignore */ }
            try { client.start(); } catch (e) { console.error('[Boriel Basic] Error al reiniciar LSP:', e); }
            try { if (client && typeof client.onReady === 'function') await client.onReady(); } catch (e) { /* ignore */ }
            statusItem.text = '$(check) Reindexado completado';
            setTimeout(() => statusItem.dispose(), 3000);
        } catch (e) {
            console.error('[Boriel Basic] Error durante reindexado fallback:', e);
            statusItem.dispose();
        }
    }

    // Listener: al guardar cualquier archivo dentro del workspace, lanzar reindexado.
    const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
        try {
            // Ignorar archivos fuera del workspace (por ejemplo archivos temporales)
            if (!workspacePath) return;
            const docPath = document.uri && document.uri.fsPath;
            if (!docPath || !docPath.startsWith(workspacePath)) return;
            // Solo reindexar cuando el archivo guardado es un .bas
            if (!docPath.endsWith('.bas') && !docPath.endsWith('.zxbas')) return;
            // Disparar reindex (no await para no bloquear el guardado)
            triggerReindexOnSave();
        } catch (e) {
            console.error('[Boriel Basic] Error al manejar onDidSaveTextDocument:', e);
        }
    });
    context.subscriptions.push(saveListener);

    // Registrar soporte de rename usando el LSP. Registramos el provider directamente
    // (las funciones comprueban `client.state` antes de enviar solicitudes), así
    // evitamos depender de `client.onReady()` que puede no existir en algunas versiones.
    try {
        const renameProvider = vscode.languages.registerRenameProvider('borielbasic', {
            async provideRenameEdits(document, position, newName, token) {
                if (!client || client.state !== 2) return null;

                const params = {
                    textDocument: { uri: document.uri.toString() },
                    position: { line: position.line, character: position.character },
                    newName
                };

                try {
                    const result = await client.sendRequest('textDocument/rename', params);
                    if (!result) return null;

                    const workspaceEdit = new vscode.WorkspaceEdit();

                    if (result.changes) {
                        for (const uri in result.changes) {
                            const edits = result.changes[uri];
                            const vsUri = vscode.Uri.parse(uri);
                            for (const e of edits) {
                                const r = e.range;
                                const range = new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
                                workspaceEdit.replace(vsUri, range, e.newText);
                            }
                        }
                    } else if (result.documentChanges) {
                        for (const change of result.documentChanges) {
                            if (change.textDocument && change.edits) {
                                const uri = change.textDocument.uri;
                                const vsUri = vscode.Uri.parse(uri);
                                for (const e of change.edits) {
                                    const r = e.range;
                                    const range = new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
                                    workspaceEdit.replace(vsUri, range, e.newText);
                                }
                            } else if (change.edits && change.uri) {
                                const vsUri = vscode.Uri.parse(change.uri);
                                for (const e of change.edits) {
                                    const r = e.range;
                                    const range = new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
                                    workspaceEdit.replace(vsUri, range, e.newText);
                                }
                            }
                        }
                    }

                    return workspaceEdit;
                } catch (err) {
                    console.error('[Boriel Basic] Error al realizar rename via LSP:', err);
                    return null;
                }
            },

            async prepareRename(document, position, token) {
                if (!client || client.state !== 2) return null;

                const params = {
                    textDocument: { uri: document.uri.toString() },
                    position: { line: position.line, character: position.character }
                };

                try {
                    const res = await client.sendRequest('textDocument/prepareRename', params);
                    if (!res) return null;

                    if (res.range) {
                        const r = res.range;
                        return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
                    } else if (res.start && res.end) {
                        return new vscode.Range(res.start.line, res.start.character, res.end.line, res.end.character);
                    }
                    return null;
                } catch (err) {
                    return null;
                }
            }
        });

        context.subscriptions.push(renameProvider);
        console.log('[Boriel Basic] RenameProvider registrado');
    } catch (err) {
        console.error('Error registrando RenameProvider:', err);
    }

    // Registrar CodeActionProvider para refactor extract (Extract Method)
    try {
        const codeActionProvider = vscode.languages.registerCodeActionsProvider('borielbasic', {
            async provideCodeActions(document, range, context, token) {
                if (!client || client.state !== 2) return [];

                // Forward the real VSCode context (diagnostics and 'only' kinds) to the LSP.
                const lspDiagnostics = (context.diagnostics || []).map(d => ({
                    range: {
                        start: { line: d.range.start.line, character: d.range.start.character },
                        end: { line: d.range.end.line, character: d.range.end.character }
                    },
                    severity: d.severity,
                    code: d.code,
                    source: d.source,
                    message: d.message
                }));

                // context.only is a single CodeActionKind instance (or undefined), not an array.
                // Use its .value to tell the LSP which action kinds we want.
                const lspOnly = context.only && context.only.value
                    ? [context.only.value]
                    : undefined;

                const params = {
                    textDocument: { uri: document.uri.toString() },
                    range: {
                        start: { line: range.start.line, character: range.start.character },
                        end: { line: range.end.line, character: range.end.character }
                    },
                    context: lspOnly ? { diagnostics: lspDiagnostics, only: lspOnly } : { diagnostics: lspDiagnostics }
                };

                try {
                    console.log('[Boriel Basic] Solicitud codeAction params:', params);
                    const res = await client.sendRequest('textDocument/codeAction', params);
                    console.log('[Boriel Basic] Respuesta codeAction:', res);
                    if (!res || !Array.isArray(res)) {
                        if (client && client.state === 2) {
                            vscode.window.showInformationMessage('No refactorings returned by LSP (check Extension Host logs).');
                        }
                        return [];
                    }

                    const actions = [];
                    for (const item of res) {
                        const title = item.title || (item.command && item.command.title) || 'Refactor';
                        // Build a proper CodeActionKind instance (VS Code internals expect .value, not a plain string)
                        let kindStr = 'refactor.extract';
                        if (item.kind && typeof item.kind === 'string') {
                            kindStr = item.kind;
                        } else if (item.kind && typeof item.kind === 'object' && item.kind.value) {
                            kindStr = item.kind.value;
                        }
                        const kind = new vscode.CodeActionKind(kindStr);
                        const ca = new vscode.CodeAction(title, kind);

                        // If LSP returned an edit, convert it
                        if (item.edit) {
                            const workspaceEdit = new vscode.WorkspaceEdit();
                            const changes = item.edit.changes || {};
                            const docChanges = item.edit.documentChanges || [];

                            for (const uri in changes) {
                                const edits = changes[uri];
                                const vsUri = vscode.Uri.parse(uri);
                                for (const e of edits) {
                                    const r = e.range;
                                    const range = new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
                                    workspaceEdit.replace(vsUri, range, e.newText);
                                }
                            }

                            for (const change of docChanges) {
                                if (change.textDocument && change.edits) {
                                    const uri = change.textDocument.uri;
                                    const vsUri = vscode.Uri.parse(uri);
                                    for (const e of change.edits) {
                                        const r = e.range;
                                        const range = new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
                                        workspaceEdit.replace(vsUri, range, e.newText);
                                    }
                                }
                            }

                            ca.edit = workspaceEdit;
                        }

                        // If LSP returned a command, attach it
                        if (item.command) {
                            ca.command = {
                                title: item.command.title,
                                command: item.command.command,
                                arguments: item.command.arguments
                            };
                        }

                        // Validate minimal shape before pushing
                        if (!ca.title) {
                            console.warn('[Boriel Basic] Skipping CodeAction without title:', item);
                            continue;
                        }

                        actions.push(ca);
                    }

                    // Defensive filter: ensure we only return plain objects with expected properties
                    const validActions = actions.filter(a => {
                        if (!a || typeof a !== 'object') return false;
                        if (!a.title || typeof a.title !== 'string') return false;
                        // kind must be a CodeActionKind instance (has .value string)
                        if (a.kind !== undefined && (typeof a.kind !== 'object' || typeof a.kind.value !== 'string')) return false;
                        return true;
                    });

                    if (validActions.length !== actions.length) {
                        console.warn('[Boriel Basic] Some CodeActions were filtered out for being invalid.');
                    }

                    return validActions;
                } catch (err) {
                    console.error('[Boriel Basic] Error requesting codeAction (extract):', err);
                    return [];
                }
            }
        }, { providedCodeActionKinds: [new vscode.CodeActionKind('refactor.extract')] });

        context.subscriptions.push(codeActionProvider);
        console.log('[Boriel Basic] CodeActionProvider (refactor.extract) registrado');
    } catch (err) {
        console.error('Error registrando CodeActionProvider:', err);
    }



    // Inicializar Turbo80 Manager
    turbo80Manager.init(context);

    // Barra de estado para depuración Turbo80
    const debugStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    context.subscriptions.push(debugStatusBarItem);

    turbo80Manager.on('cpuPaused', (msg) => {
        vscode.commands.executeCommand('setContext', 'borielBasic.isDebugging', true);
        vscode.commands.executeCommand('setContext', 'borielBasic.isPaused', true);
        const pcHex = msg?.pc ? msg.pc.toString(16).toUpperCase().padStart(4, '0') : '????';
        debugStatusBarItem.text = `$(debug-pause) Boriel: PC=$${pcHex}`;
        debugStatusBarItem.tooltip = `Boriel Basic pausado en Z80 PC=$${pcHex}. Clic para continuar.`;
        debugStatusBarItem.command = 'borielBasic.debugContinue';
        debugStatusBarItem.show();
    });

    turbo80Manager.on('cpuResumed', () => {
        clearDebugDecorations();
        vscode.commands.executeCommand('setContext', 'borielBasic.isPaused', false);
        debugStatusBarItem.text = '$(play) Boriel: Ejecutando...';
        debugStatusBarItem.tooltip = 'Boriel Basic en ejecución en Turbo80';
        debugStatusBarItem.show();
    });

    turbo80Manager.on('closed', () => {
        clearDebugDecorations();
        debugStatusBarItem.hide();
        vscode.commands.executeCommand('setContext', 'borielBasic.isDebugging', false);
        vscode.commands.executeCommand('setContext', 'borielBasic.isPaused', false);
    });

    turbo80Manager.on('debugStopped', () => {
        clearDebugDecorations();
        debugStatusBarItem.hide();
        vscode.commands.executeCommand('setContext', 'borielBasic.isDebugging', false);
        vscode.commands.executeCommand('setContext', 'borielBasic.isPaused', false);
    });

    turbo80Manager.on('programEnded', () => {
        clearDebugDecorations();
        vscode.commands.executeCommand('setContext', 'borielBasic.isDebugging', false);
        vscode.commands.executeCommand('setContext', 'borielBasic.isPaused', false);
        debugStatusBarItem.text = '$(check) Boriel: Finalizado';
        debugStatusBarItem.tooltip = 'Programa Boriel Basic finalizado con éxito';
        debugStatusBarItem.show();
        setTimeout(() => {
            debugStatusBarItem.hide();
        }, 4000);
    });

    // Registrar el comando "borielBasic.compile"
    console.log('[Extension] Registrando comando borielBasic.compile');
    const compileCommand = vscode.commands.registerCommand('borielBasic.compile', () => {
        console.log('[Extension] Comando borielBasic.compile ejecutado (forzando autorun)');
        compileBorielBasic({ forceAutorun: true });
    });

    // Registrar el comando "borielBasic.updateLSP"
    const updateLSPCommand = vscode.commands.registerCommand('borielBasic.updateLSP', () => {
        updateLSP(context);
    });

    // Registrar comando para forzar actualización del binario zxp2boriel
    const updateZxpBinaryCommand = vscode.commands.registerCommand('borielBasic.updateZXP2Boriel', () => {
        updateZXP2BorielBinary(context);
    });

    // Registrar el comando "borielBasic.runTurbo80"
    const runTurbo80Command = vscode.commands.registerCommand('borielBasic.runTurbo80', async () => {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
            const rootDir = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();
            const borielConfig = getBorielLaunchConfig('turbo80', workspaceFolder);

            const sourceFile = getProjectRootSourceFile(workspaceFolder, 'turbo80');

            const result = await compileBorielBasic({
                sourceFile: sourceFile,
                forceAutorun: true
            });
            const program = result.outputFile;
            if (!program || !fs.existsSync(program)) {
                vscode.window.showErrorMessage(`No se encontró el archivo compilado: ${program}`);
                return;
            }
            const tapBuffer = fs.readFileSync(program);
            const targetModel = borielConfig.turbo80Model || vscode.workspace.getConfiguration('borielBasic', workspaceFolder?.uri).get('turbo80Model', '128k');
            turbo80Manager.createOrShowPanel({
                base64: tapBuffer.toString('base64'),
                filename: path.basename(program),
                model: targetModel,
                crt: borielConfig.turbo80Crt !== undefined ? borielConfig.turbo80Crt : true,
                debug: false
            });
            vscode.window.showInformationMessage(`Ejecutando en Turbo80: ${path.basename(program)} (${targetModel.toUpperCase()})`);
        } catch (err) {
            vscode.window.showErrorMessage(`Error al ejecutar en Turbo80: ${err.message || err}`);
        }
    });

    // Registrar el comando "borielBasic.debugTurbo80"
    const debugTurbo80Command = vscode.commands.registerCommand('borielBasic.debugTurbo80', async () => {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
            const rootDir = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();
            const borielConfig = getBorielLaunchConfig('turbo80', workspaceFolder);

            const sourceFile = getProjectRootSourceFile(workspaceFolder, 'turbo80');

            // Determinar programa (.tap) de launch.json o del sourceFile
            let program = borielConfig.program;
            if (program) {
                program = program.replace(/\$\{workspaceFolder\}/g, rootDir);
                program = path.isAbsolute(program) ? program : path.join(rootDir, program);
            } else if (sourceFile) {
                const base = path.basename(sourceFile, path.extname(sourceFile));
                const sDir = path.dirname(sourceFile);
                if (path.basename(sDir).toLowerCase() === 'src') {
                    program = path.join(path.dirname(sDir), 'dist', `${base}.tap`);
                } else {
                    program = path.join(rootDir, 'dist', `${base}.tap`);
                }
            } else {
                program = path.join(rootDir, 'dist', 'main.tap');
            }

            const targetModel = borielConfig.turbo80Model || vscode.workspace.getConfiguration('borielBasic', workspaceFolder?.uri).get('turbo80Model', '128k');
            await vscode.debug.startDebugging(workspaceFolder, {
                name: borielConfig.name || 'Debug Boriel Basic (Turbo80)',
                type: 'borielbasic',
                request: 'launch',
                emulator: 'turbo80',
                sourceFile: sourceFile,
                program: program,
                stopOnEntry: borielConfig.stopOnEntry !== undefined ? borielConfig.stopOnEntry : true,
                turbo80Model: targetModel,
                turbo80Crt: borielConfig.turbo80Crt !== undefined ? borielConfig.turbo80Crt : true
            });
        } catch (err) {
            vscode.window.showErrorMessage(`Error al depurar en Turbo80: ${err.message || err}`);
        }
    });

    // Registrar comandos de control de depuración Turbo80
    const debugContinueCommand = vscode.commands.registerCommand('borielBasic.debugContinue', () => {
        if (vscode.debug.activeDebugSession) {
            vscode.commands.executeCommand('workbench.action.debug.continue');
        } else {
            turbo80Manager.continue();
        }
    });

    const debugPauseCommand = vscode.commands.registerCommand('borielBasic.debugPause', () => {
        if (vscode.debug.activeDebugSession) {
            vscode.commands.executeCommand('workbench.action.debug.pause');
        } else {
            turbo80Manager.pause();
        }
    });

    const debugStepOverCommand = vscode.commands.registerCommand('borielBasic.debugStepOver', () => {
        if (vscode.debug.activeDebugSession) {
            vscode.commands.executeCommand('workbench.action.debug.stepOver');
        } else {
            turbo80Manager.stepOver();
        }
    });

    const debugStepIntoCommand = vscode.commands.registerCommand('borielBasic.debugStepInto', () => {
        if (vscode.debug.activeDebugSession) {
            vscode.commands.executeCommand('workbench.action.debug.stepInto');
        } else {
            turbo80Manager.stepInto();
        }
    });

    const debugStepOutCommand = vscode.commands.registerCommand('borielBasic.debugStepOut', () => {
        if (vscode.debug.activeDebugSession) {
            vscode.commands.executeCommand('workbench.action.debug.stepOut');
        } else {
            turbo80Manager.stepOut();
        }
    });

    const debugStopCommand = vscode.commands.registerCommand('borielBasic.debugStop', () => {
        if (vscode.debug.activeDebugSession) {
            vscode.commands.executeCommand('workbench.action.debug.stop');
        } else {
            turbo80Manager.stop();
        }
    });

    // Registrar el comando "borielBasic.compileAndRun"
    console.log('[Extension] Registrando comando borielBasic.compileAndRun');
    const compileAndRunCommand = vscode.commands.registerCommand('borielBasic.compileAndRun', async () => {
        console.log('[Extension] Comando borielBasic.compileAndRun ejecutado');

        // 1. Obtener la configuración de launch.json
        const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        const defaultEmulator = vscode.workspace.getConfiguration('borielBasic').get('defaultEmulator', 'turbo80');
        const borielConfig = getBorielLaunchConfig(null, workspaceFolder);
        const targetEmulator = borielConfig.emulator || defaultEmulator;

        // 2. Determinar el archivo fuente priorizando launch.json
        const sourceFile = getProjectRootSourceFile(workspaceFolder, targetEmulator);

        if (targetEmulator === 'turbo80') {
            try {
                const result = await compileBorielBasic({
                    sourceFile: sourceFile,
                    forceAutorun: true
                });
                const program = result.outputFile;
                if (!program || !fs.existsSync(program)) {
                    vscode.window.showErrorMessage(`No se encontró el archivo compilado: ${program}`);
                    return;
                }
                const targetModel = borielConfig.turbo80Model || vscode.workspace.getConfiguration('borielBasic', workspaceFolder?.uri).get('turbo80Model', '128k');
                turbo80Manager.createOrShowPanel({
                    base64: tapBuffer.toString('base64'),
                    filename: path.basename(program),
                    model: targetModel,
                    crt: borielConfig.turbo80Crt !== undefined ? borielConfig.turbo80Crt : true,
                    debug: false
                });
                vscode.window.showInformationMessage(`Ejecutando juego en Turbo80: ${path.basename(program)} (${targetModel.toUpperCase()})`);
                return;
            } catch (err) {
                console.error('[Extension] Error en compileAndRun (Turbo80):', err);
                vscode.window.showErrorMessage(`Error al compilar y ejecutar en Turbo80: ${err.message || err}`);
                return;
            }
        }

        // Si no es turbo80, usar ZEsarUX
        const zesaruxPath = borielConfig.zesaruxPath || 'zesarux';

        try {
            // 3. Compilar
            const result = await compileBorielBasic({
                sourceFile: sourceFile,
                forceAutorun: true
            });

            // 4. Lanzar ZEsarUX de forma independiente (SOLO EJECUCIÓN, sin debug)
            const program = result.outputFile;

            if (!zesaruxPath) {
                vscode.window.showErrorMessage('No se ha especificado la ruta de ZEsarUX. Configura "zesaruxPath" en tu launch.json.');
                return;
            }

            if (!fs.existsSync(zesaruxPath) && zesaruxPath !== 'zesarux') {
                vscode.window.showErrorMessage(`No se encuentra el ejecutable ZEsarUX en: ${zesaruxPath}`);
                return;
            }

            const zesaruxCmd = `${zesaruxPath} --noconfigfile --machine 128k --nosplash --nowelcomemessage --quickexit --tape "${program}"`;

            const terminal = vscode.window.createTerminal({
                name: 'Boriel Run',
                cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || undefined
            });
            terminal.sendText(zesaruxCmd);
            terminal.show();
            vscode.window.showInformationMessage(`Ejecutando juego en ZEsarUX: ${path.basename(program)}`);

        } catch (err) {
            console.error('[Extension] Error en compileAndRun:', err);
        }
    });

    // Registrar el comando "borielBasic.exportZXPToBoriel"
    const exportZXPCommand = vscode.commands.registerCommand('borielBasic.exportZXPToBoriel', (uri) => {
        exportZXPToBoriel(uri, context);
    });

    // Registrar comando para lanzar ZEsarUX
    const launchZesaruxCommand = vscode.commands.registerCommand('borielBasic.launchZesarux', (config) => {
        let zesaruxPath = config?.zesaruxPath;
        if (!zesaruxPath) {
            const launchConfigs = vscode.workspace.getConfiguration('launch').get('configurations') || [];
            const borielConfig = launchConfigs.find(c => c.type === 'borielbasic');
            zesaruxPath = borielConfig?.zesaruxPath;
        }
        const debugPort = config?.debugPort || 10000;
        const program = config?.program;
        if (!zesaruxPath || !program) {
            vscode.window.showErrorMessage('No se ha especificado la ruta de ZEsarUX o el archivo .tap. Configura "zesaruxPath" en tu launch.json.');
            return;
        }
        const zesaruxCmd = `${zesaruxPath} --enable-remoteprotocol --remoteprotocol-port=${debugPort} --noconfigfile --machine 128k --nosplash --nowelcomemessage --tape ${program}`;
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

    // Registrar DebugConfigurationProvider para inyectar sourceFile, program y emulator automáticamente
    const debugConfigProvider = {
        resolveDebugConfiguration(folder, debugConfig) {
            if (!debugConfig) debugConfig = {};
            if (!debugConfig.type) debugConfig.type = 'borielbasic';
            if (!debugConfig.request) debugConfig.request = 'launch';

            if (debugConfig.type === 'borielbasic') {
                const workspacePath = folder ? folder.uri.fsPath : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd());

                if (!debugConfig.emulator) {
                    const borielConfig = getBorielLaunchConfig(null, folder);
                    debugConfig.emulator = borielConfig.emulator || vscode.workspace.getConfiguration('borielBasic').get('defaultEmulator', 'turbo80');
                }

                if (!debugConfig.sourceFile) {
                    debugConfig.sourceFile = getProjectRootSourceFile(folder, debugConfig.emulator);
                }

                if (debugConfig.sourceFile && !path.isAbsolute(debugConfig.sourceFile)) {
                    const candidate = path.join(workspacePath, debugConfig.sourceFile);
                    if (fs.existsSync(candidate)) {
                        debugConfig.sourceFile = candidate;
                    }
                }

                if (!debugConfig.turbo80Model) {
                    const borielConfig = getBorielLaunchConfig(debugConfig.emulator, folder);
                    debugConfig.turbo80Model = borielConfig.turbo80Model || vscode.workspace.getConfiguration('borielBasic', folder?.uri).get('turbo80Model', '128k');
                }

                if (!debugConfig.program) {
                    const borielConfig = getBorielLaunchConfig(debugConfig.emulator, folder);
                    if (borielConfig.program) {
                        debugConfig.program = borielConfig.program.replace(/\$\{workspaceFolder\}/g, workspacePath);
                    } else {
                        let baseName = 'main';
                        if (debugConfig.sourceFile && typeof debugConfig.sourceFile === 'string') {
                            baseName = path.basename(debugConfig.sourceFile, path.extname(debugConfig.sourceFile));
                            const srcDir = path.dirname(debugConfig.sourceFile);
                            if (path.basename(srcDir).toLowerCase() === 'src') {
                                debugConfig.program = path.join(path.dirname(srcDir), 'dist', `${baseName}.tap`);
                            } else {
                                debugConfig.program = path.join(workspacePath, 'dist', `${baseName}.tap`);
                            }
                        } else {
                            debugConfig.program = path.join(workspacePath, 'dist', 'main.tap');
                        }
                    }
                }
            }
            return debugConfig;
        }
    };

    // Registrar comando para seleccionar interactivamente el modelo de ZX Spectrum para Turbo80
    const selectTurbo80ModelCommand = vscode.commands.registerCommand('borielBasic.selectTurbo80Model', async () => {
        const models = [
            { label: 'ZX Spectrum 128K', description: '128k', detail: 'Modo 128K con chip de sonido AY-3-8912 y 128KB RAM (Por defecto)' },
            { label: 'ZX Spectrum 48K', description: '48k', detail: 'Modelo clásico Sinclair 48K' },
            { label: 'ZX Spectrum +2', description: 'plus2', detail: 'Modelo gris con reproductor de cassette' },
            { label: 'ZX Spectrum +2A', description: 'plus2a', detail: 'Modelo negro Amstrad +2A' },
            { label: 'ZX Spectrum +3', description: 'plus3', detail: 'Modelo con unidad de disco de 3 pulgadas' },
            { label: 'ZX Spectrum 16K', description: '16k', detail: 'Modelo Sinclair con 16KB de RAM' }
        ];

        const currentModel = vscode.workspace.getConfiguration('borielBasic').get('turbo80Model', '128k');
        const selected = await vscode.window.showQuickPick(models, {
            placeHolder: `Selecciona el modelo de ZX Spectrum para Turbo80 (actual: ${currentModel.toUpperCase()})`
        });

        if (selected) {
            await vscode.workspace.getConfiguration('borielBasic').update('turbo80Model', selected.description, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Modelo de ZX Spectrum para Turbo80 establecido a: ${selected.label}`);
        }
    });

    // Registrar el DebugAdapterDescriptorFactory para 'borielbasic'
    const debugAdapterFactory = new InlineDebugAdapterFactory();
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('borielbasic', debugConfigProvider),
        vscode.debug.registerDebugAdapterDescriptorFactory('borielbasic', debugAdapterFactory),
        compileAndRunCommand,
        compileCommand,
        updateLSPCommand,
        updateZxpBinaryCommand,
        exportZXPCommand,
        launchZesaruxCommand,
        runTurbo80Command,
        debugTurbo80Command,
        debugContinueCommand,
        debugPauseCommand,
        debugStepOverCommand,
        debugStepIntoCommand,
        debugStepOutCommand,
        debugStopCommand,
        selectTurbo80ModelCommand
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