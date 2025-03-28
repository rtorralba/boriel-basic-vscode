const path = require('path');
const vscode = require('vscode');
const {
    LanguageClient,
    TransportKind
} = require('vscode-languageclient/node');

let client;

function activate(context) {
    // Ruta al servidor LSP
    const serverModule = context.asAbsolutePath(path.join('server/zxBasicServer.js'));

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