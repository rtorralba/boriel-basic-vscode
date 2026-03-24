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
            req.on('error', (e) => { try { fs.unlinkSync(outPath); } catch (_) {} ; reject(e); });
        });
        if (process.platform !== 'win32') {
            try { fs.chmodSync(outPath, 0o755); } catch (e) { /* ignore */ }
        }
        vscode.window.showInformationMessage('Binario zxp2boriel descargado correctamente.');
        return outPath;
    } catch (err) {
        vscode.window.showErrorMessage('Error descargando zxp2boriel: ' + (err.message || err));
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
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
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Reindexando proyecto...', cancellable: false }, async () => {
                try { await client.stop(); } catch (e) { /* ignore */ }
                try { client.start(); } catch (e) { console.error('[Boriel Basic] Error al reiniciar LSP:', e); }
                try { if (client && typeof client.onReady === 'function') await client.onReady(); } catch (e) { /* ignore */ }
            });
            vscode.window.showInformationMessage('Reindexado completado.');
        } catch (e) {
            console.error('[Boriel Basic] Error durante reindexado fallback:', e);
        }
    }

    // Listener: al guardar cualquier archivo dentro del workspace, lanzar reindexado.
    const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
        try {
            // Ignorar archivos fuera del workspace (por ejemplo archivos temporales)
            if (!workspacePath) return;
            const docPath = document.uri && document.uri.fsPath;
            if (!docPath || !docPath.startsWith(workspacePath)) return;
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

    // (Removed Python package management commands)

    // Registrar comando para forzar actualización del binario zxp2boriel
    const updateZxpBinaryCommand = vscode.commands.registerCommand('borielBasic.updateZXP2Boriel', () => {
        updateZXP2BorielBinary(context);
    });

    // Registrar el comando "borielBasic.exportZXPToBoriel"
    const exportZXPCommand = vscode.commands.registerCommand('borielBasic.exportZXPToBoriel', (uri) => {
        exportZXPToBoriel(uri, context);
    });

    // Registrar comando para lanzar ZEsarUX
    const launchZesaruxCommand = vscode.commands.registerCommand('borielBasic.launchZesarux', (config) => {
        // Leer zesaruxPath desde los argumentos del comando (que vienen del launch.json)
        // Si no se pasa directamente, buscar la config borielbasic activa en launch.json
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

    // Registrar DebugConfigurationProvider para inyectar sourceFile automáticamente
    const debugConfigProvider = {
        resolveDebugConfiguration(folder, debugConfig) {
            if (debugConfig.type === 'borielbasic' && !debugConfig.sourceFile) {
                const mainFile = vscode.workspace.getConfiguration('borielBasic').get('mainFile');
                if (mainFile) {
                    debugConfig.sourceFile = mainFile;
                }
            }
            return debugConfig;
        }
    };

    // Registrar el DebugAdapterDescriptorFactory para 'borielbasic'
    const debugAdapterFactory = new InlineDebugAdapterFactory();
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('borielbasic', debugConfigProvider),
        vscode.debug.registerDebugAdapterDescriptorFactory('borielbasic', debugAdapterFactory),
        compileCommand,
        updateLSPCommand,
        updateZxpBinaryCommand,
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