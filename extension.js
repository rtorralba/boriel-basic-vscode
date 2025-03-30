const path = require('path');
const vscode = require('vscode');
const {
    LanguageClient,
    TransportKind
} = require('vscode-languageclient/node');

let client;

function activate(context) {
    let serverModule;

    // Intentar resolver el módulo zx-basic-lsp localmente
    try {
        serverModule = require.resolve('zx-basic-lsp');
        console.log('Ruta del servidor LSP (local):', serverModule);
    } catch (error) {
        console.error('Error al resolver zx-basic-lsp localmente:', error);

        // Si no se encuentra localmente, buscar en las dependencias globales
        try {
            const globalNodeModules = child_process.execSync('npm root -g').toString().trim();
            serverModule = path.join(globalNodeModules, 'zx-basic-lsp');
            console.log('Ruta del servidor LSP (global):', serverModule);

            // Verificar si el módulo existe en la ruta global
            require.resolve(serverModule);
        } catch (globalError) {
            console.error('Error al resolver zx-basic-lsp globalmente:', globalError);
        }
    }

    console.log('Ruta del servidor LSP:', serverModule);

    if (!serverModule) {
        throw new Error('No se pudo resolver el módulo zx-basic-lsp. Asegúrate de que esté instalado.');
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

    // Opciones del cliente
    const clientOptions = {
        documentSelector: [{ scheme: 'file', language: 'zxbasic' }],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.bas')
        }
    };

    // Crear el cliente LSP
    client = new LanguageClient(
        'zxBasicLanguageServer',
        'ZX Basic Language Server',
        serverOptions,
        clientOptions
    );

    // Iniciar el cliente
    client.start();
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