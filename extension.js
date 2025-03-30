const path = require('path');
const vscode = require('vscode');
const {
    LanguageClient,
    TransportKind
} = require('vscode-languageclient/node');
const child_process = require('child_process');
const fs = require('fs');

let client;

function compileZXBasic() {
    // Obtener configuraciones del usuario
    const config = vscode.workspace.getConfiguration('zxBasic');
    const mainFile = config.get('mainFile');
    const optimizeLevel = config.get('optimizeLevel');
    const outputFormat = config.get('outputFormat');
    const autorun = config.get('autorun');
    const org = config.get('org');
    const includeBasicLoader = config.get('includeBasicLoader');
    const heapSize = config.get('heapSize');

    // Obtener el archivo activo
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No hay ningún archivo abierto para compilar.');
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

    // Comprobar si existe la carpeta dist y si no crearla
    const workspaceFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const distFolder = path.join(workspaceFolder, 'dist');
    if (!fs.existsSync(distFolder)) {
        fs.mkdirSync(distFolder);
    }

    outputFile = path.join("dist", path.basename(mainFile, '.bas') + (outputFormat === 'tap' ? '.tap' : '.bin'));

    // Construir el comando de compilación
    const args = [
        `-O=${optimizeLevel}`,
        `-S=${org}`,
        `-H=${heapSize}`,
        includeBasicLoader ? '-B' : '',
        autorun ? '-a' : '',
        outputFormat === 'tap' ? '-t' : '-T',
    ].filter(arg => arg !== ''); // Eliminar argumentos vacíos

    const command = `${bin} ${args.join(' ')} ${mainFile} -o ${outputFile}`;
    console.log(`Ejecutando comando: ${command}`);

    // Ejecutar el comando
    child_process.exec(command, { cwd: workspaceFolder }, (error, stdout, stderr) => {
        if (error) {
            vscode.window.showErrorMessage(`Error al compilar: ${stderr}`);
            console.error(`Error: ${stderr}`);
            return;
        }

        vscode.window.showInformationMessage(`Compilación completada: ${outputFile}`);
        console.log(`Salida: ${stdout}`);
    });
}

function updateLSP() {
    vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "Actualizando ZX Basic LSP...",
            cancellable: false
        },
        async (progress) => {
            try {
                progress.report({ message: "Ejecutando npm install -g zx-basic-lsp..." });

                // Ejecutar el comando para actualizar el LSP
                const result = child_process.execSync('npm install -g zx-basic-lsp', { encoding: 'utf-8' });
                console.log(result);

                vscode.window.showInformationMessage("ZX Basic LSP actualizado correctamente.");
            } catch (error) {
                console.error("Error al actualizar ZX Basic LSP:", error);
                vscode.window.showErrorMessage(`Error al actualizar ZX Basic LSP: ${error.message}`);
            }
        }
    );
}

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

    // Registrar el comando "zxBasic.compile"
    const compileCommand = vscode.commands.registerCommand('zxBasic.compile', () => {
        compileZXBasic();
    });

    // Registrar el comando "zxBasic.updateLSP"
    const updateLSPCommand = vscode.commands.registerCommand('zxBasic.updateLSP', () => {
        updateLSP();
    });

    context.subscriptions.push(compileCommand);
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