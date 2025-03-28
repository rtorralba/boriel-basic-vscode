const {
    Range,
    Location
} = require('vscode-languageserver/node');

// Índices para definiciones y referencias
const globalDefinitions = new Map(); // { nombre: Location }
const globalReferences = new Map(); // { nombre: [Location, ...] }

const fs = require('fs');

function analyzeFile(filePath, uri) {
    const text = fs.readFileSync(filePath, 'utf8');
    console.log(`Contenido del archivo ${filePath}:\n${text}`);

    const lines = text.split(/\r?\n/);

    lines.forEach((line, i) => {
        const trimmedLine = line.trim();

        // Detectar definiciones (SUB o FUNCTION)
        const definitionMatch = /^\s*(SUB|FUNCTION)\s+([a-zA-Z_][a-zA-Z0-9_]*)/i.exec(trimmedLine);
        if (definitionMatch) {
            const type = definitionMatch[1]; // SUB o FUNCTION
            const name = definitionMatch[2];
            console.log(`Definición encontrada: ${type} ${name} en ${filePath}, línea ${i + 1}`);
            globalDefinitions.set(name, Location.create(uri, Range.create(i, 0, i, trimmedLine.length)));
        }

        // Detectar referencias (uso de identificadores)
        const words = trimmedLine.split(/\s+/).map(word => word.replace(/[^\w]/g, ''));
        console.log(`Palabras detectadas en la línea ${i + 1}:`, words);

        words.forEach((word) => {
            if (globalDefinitions.has(word)) {
                if (!globalReferences.has(word)) {
                    globalReferences.set(word, []);
                }
                console.log(`Referencia encontrada: ${word} en ${filePath}, línea ${i + 1}`);
                globalReferences.get(word).push(Location.create(uri, Range.create(i, 0, i, trimmedLine.length)));
            }
        });
    });
}

const path = require('path');
const glob = require('glob');

// Obtener la ruta del proyecto desde los argumentos
const projectPath = process.argv[2]; // La ruta del proyecto se pasa como argumento al servidor

if (!projectPath) {
    console.error('No se proporcionó la ruta del proyecto.');
    process.exit(1);
}

function analyzeProjectFiles() {
    const pattern = `${projectPath}/**/*.bas`;

    console.log('Ruta del proyecto:', projectPath);
    console.log('Patrón de búsqueda:', pattern);

    const files = glob.sync(pattern);

    console.log('Archivos encontrados:', files);

    files.forEach((file) => {
        const uri = `file://${file}`;
        console.log(`Analizando archivo: ${file}`);
        analyzeFile(file, uri);
    });

    console.log('Análisis inicial completado');
    console.log('Definiciones globales:', Array.from(globalDefinitions.keys()));
    console.log('Referencias globales:', Array.from(globalReferences.keys()));
}

module.exports = {
    analyzeProjectFiles,
    globalDefinitions,
    globalReferences
};