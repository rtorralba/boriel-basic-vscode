function watchBasicFiles() {
    const chokidar = require('chokidar');

    const watcher = chokidar.watch('**/*.bas', {
        ignored: /node_modules/, // Ignorar la carpeta node_modules
        persistent: true
    });

    // Archivo creado
    watcher.on('add', (filePath) => {
        console.log(`Archivo creado: ${filePath}`);
        const uri = `file://${filePath}`;
        analyzeFile(filePath, uri);
    });

    // Archivo modificado
    watcher.on('change', (filePath) => {
        console.log(`Archivo modificado: ${filePath}`);
        const uri = `file://${filePath}`;
        analyzeFile(filePath, uri);
    });

    // Archivo eliminado
    watcher.on('unlink', (filePath) => {
        console.log(`Archivo eliminado: ${filePath}`);
        const uri = `file://${filePath}`;
        // Elimina las definiciones y referencias asociadas al archivo
        globalDefinitions.forEach((value, key) => {
            if (value.uri === uri) {
                globalDefinitions.delete(key);
            }
        });
        globalReferences.forEach((value, key) => {
            globalReferences.set(key, value.filter(location => location.uri !== uri));
        });
    });
}

module.exports = { watchBasicFiles };
