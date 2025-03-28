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

        // Ignorar líneas que son comentarios o están dentro de cadenas de texto
        if (trimmedLine.startsWith("'") || trimmedLine.startsWith('"')) {
            return;
        }

        // Detectar definiciones (SUB o FUNCTION)
        const definitionMatch = /^\s*(SUB|FUNCTION)\s+([a-zA-Z_][a-zA-Z0-9_]*)/i.exec(trimmedLine);
        if (definitionMatch) {
            const type = definitionMatch[1]; // SUB o FUNCTION
            const name = definitionMatch[2];
            console.log(`Definición encontrada: ${type} ${name} en ${filePath}, línea ${i + 1}`);
            globalDefinitions.set(name, Location.create(uri, Range.create(i, 0, i, trimmedLine.length)));
        }

        // Detectar referencias (llamadas a funciones o subrutinas)
        globalDefinitions.forEach((_, name) => {
            // Patrón para llamadas a funciones (nombre seguido de un paréntesis)
            const callPattern = new RegExp(`\\b${name}\\s*\\(`, 'i');
            // Patrón para subrutinas (nombre en una línea sin paréntesis, pero no dentro de cadenas de texto o comentarios)
            const subPattern = new RegExp(`\\b${name}\\b(?!\\s*\\()`, 'i');

            // Verificar si la línea contiene una llamada válida
            if (callPattern.test(trimmedLine) || (subPattern.test(trimmedLine) && !trimmedLine.includes('"') && !trimmedLine.startsWith("'"))) {
                if (!globalReferences.has(name)) {
                    globalReferences.set(name, []);
                }
                console.log(`Referencia encontrada: ${name} en ${filePath}, línea ${i + 1}`);
                globalReferences.get(name).push(Location.create(uri, Range.create(i, 0, i, trimmedLine.length)));
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

    // Primer pase: analizar definiciones
    files.forEach((file) => {
        const uri = `file://${file}`;
        console.log(`Analizando definiciones en archivo: ${file}`);
        analyzeFileForDefinitions(file, uri);
    });

    // Segundo pase: analizar referencias
    files.forEach((file) => {
        const uri = `file://${file}`;
        console.log(`Analizando referencias en archivo: ${file}`);
        analyzeFileForReferences(file, uri);
    });

    console.log('Análisis inicial completado');
    console.log('Definiciones globales:', Array.from(globalDefinitions.keys()));
    console.log('Referencias globales:', Array.from(globalReferences.keys()));
}

function analyzeFileForDefinitions(filePath, uri) {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/);

    lines.forEach((line, i) => {
        const trimmedLine = line.trim();

        // Ignorar líneas que son comentarios o están dentro de cadenas de texto
        if (trimmedLine.startsWith("'") || trimmedLine.startsWith('"')) {
            return;
        }

        // Detectar definiciones (SUB o FUNCTION, con o sin FASTCALL, con o sin parámetros)
        const definitionMatch = /^\s*(SUB|FUNCTION)\s+(FASTCALL\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(.*\)/i.exec(trimmedLine);
        if (definitionMatch) {
            const type = definitionMatch[1].toUpperCase(); // SUB o FUNCTION
            const name = definitionMatch[3]; // Nombre de la función o subrutina
            console.log(`Definición encontrada: ${type} ${name} en ${filePath}, línea ${i + 1}`);
            globalDefinitions.set(name, Location.create(uri, Range.create(i, 0, i, trimmedLine.length)));
        }
    });
}

function analyzeFileForReferences(filePath, uri) {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/);

    lines.forEach((line, i) => {
        const trimmedLine = line.trim();

        // Ignorar líneas que son comentarios o están dentro de cadenas de texto
        if (trimmedLine.startsWith("'") || trimmedLine.startsWith('"')) {
            return;
        }

        // Detectar referencias (llamadas a funciones o subrutinas)
        globalDefinitions.forEach((_, name) => {
            const callPattern = new RegExp(`\\b${name}\\s*\\(`, 'i');
            const subPattern = new RegExp(`\\b${name}\\b(?!\\s*\\()`, 'i');

            if (callPattern.test(trimmedLine) || (subPattern.test(trimmedLine) && !trimmedLine.includes('"') && !trimmedLine.startsWith("'"))) {
                if (!globalReferences.has(name)) {
                    globalReferences.set(name, []);
                }
                console.log(`Referencia encontrada: ${name} en ${filePath}, línea ${i + 1}`);
                globalReferences.get(name).push(Location.create(uri, Range.create(i, 0, i, trimmedLine.length)));
            }
        });
    });
}

module.exports = {
    analyzeProjectFiles,
    globalDefinitions,
    globalReferences
};