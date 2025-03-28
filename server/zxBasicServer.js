const {
    createConnection,
    Diagnostic,
    DiagnosticSeverity,
    Range,
    TextDocuments,
    TextDocumentSyncKind,
    CompletionItem,
    CompletionItemKind,
    TextEdit,
    Location
} = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');

// Crear conexión con el cliente
const connection = createConnection();
connection.console.info('ZX Basic LSP server is running');

// Manejo de documentos abiertos
const documents = new TextDocuments(TextDocument);
documents.listen(connection);

// Palabras clave de ZX Basic para autocompletado
const zxBasicKeywords = [
    // Control de flujo
    { label: 'IF', kind: CompletionItemKind.Keyword, detail: 'Estructura condicional' },
    { label: 'THEN', kind: CompletionItemKind.Keyword, detail: 'Parte de la estructura IF' },
    { label: 'ELSE', kind: CompletionItemKind.Keyword, detail: 'Parte de la estructura IF' },
    { label: 'ENDIF', kind: CompletionItemKind.Keyword, detail: 'Finaliza una estructura IF' },
    { label: 'FOR', kind: CompletionItemKind.Keyword, detail: 'Bucle FOR' },
    { label: 'TO', kind: CompletionItemKind.Keyword, detail: 'Parte de la estructura FOR' },
    { label: 'STEP', kind: CompletionItemKind.Keyword, detail: 'Incremento en un bucle FOR' },
    { label: 'NEXT', kind: CompletionItemKind.Keyword, detail: 'Finaliza un bucle FOR' },
    { label: 'WHILE', kind: CompletionItemKind.Keyword, detail: 'Bucle WHILE' },
    { label: 'WEND', kind: CompletionItemKind.Keyword, detail: 'Finaliza un bucle WHILE' },
    { label: 'DO', kind: CompletionItemKind.Keyword, detail: 'Inicio de un bucle DO' },
    { label: 'LOOP', kind: CompletionItemKind.Keyword, detail: 'Finaliza un bucle DO' },
    { label: 'EXIT', kind: CompletionItemKind.Keyword, detail: 'Sale de un bucle o subrutina' },
    { label: 'GOTO', kind: CompletionItemKind.Keyword, detail: 'Salta a una línea específica' },
    { label: 'GOSUB', kind: CompletionItemKind.Keyword, detail: 'Llama a una subrutina' },
    { label: 'RETURN', kind: CompletionItemKind.Keyword, detail: 'Regresa de una subrutina' },
    { label: 'ON', kind: CompletionItemKind.Keyword, detail: 'Control de flujo basado en condiciones' },

    // Declaraciones
    { label: 'DIM', kind: CompletionItemKind.Keyword, detail: 'Declara un array' },
    { label: 'CONST', kind: CompletionItemKind.Keyword, detail: 'Declara una constante' },
    { label: 'DEF', kind: CompletionItemKind.Keyword, detail: 'Define una función o subrutina' },
    { label: 'END', kind: CompletionItemKind.Keyword, detail: 'Finaliza el programa o bloque' },
    { label: 'LET', kind: CompletionItemKind.Keyword, detail: 'Asigna un valor a una variable' },

    // Entrada/Salida
    { label: 'PRINT', kind: CompletionItemKind.Keyword, detail: 'Imprime texto o valores en pantalla' },
    { label: 'INPUT', kind: CompletionItemKind.Keyword, detail: 'Solicita entrada del usuario' },
    { label: 'CLS', kind: CompletionItemKind.Keyword, detail: 'Limpia la pantalla' },
    { label: 'PAUSE', kind: CompletionItemKind.Keyword, detail: 'Pausa la ejecución del programa' },

    // Operadores
    { label: 'AND', kind: CompletionItemKind.Keyword, detail: 'Operador lógico AND' },
    { label: 'OR', kind: CompletionItemKind.Keyword, detail: 'Operador lógico OR' },
    { label: 'NOT', kind: CompletionItemKind.Keyword, detail: 'Operador lógico NOT' },
    { label: 'MOD', kind: CompletionItemKind.Keyword, detail: 'Operador de módulo' },

    // Funciones matemáticas
    { label: 'ABS', kind: CompletionItemKind.Function, detail: 'Devuelve el valor absoluto' },
    { label: 'SIN', kind: CompletionItemKind.Function, detail: 'Devuelve el seno de un ángulo' },
    { label: 'COS', kind: CompletionItemKind.Function, detail: 'Devuelve el coseno de un ángulo' },
    { label: 'TAN', kind: CompletionItemKind.Function, detail: 'Devuelve la tangente de un ángulo' },
    { label: 'INT', kind: CompletionItemKind.Function, detail: 'Devuelve la parte entera de un número' },
    { label: 'RND', kind: CompletionItemKind.Function, detail: 'Devuelve un número aleatorio' },
    { label: 'SGN', kind: CompletionItemKind.Function, detail: 'Devuelve el signo de un número' },
    { label: 'SQR', kind: CompletionItemKind.Function, detail: 'Devuelve la raíz cuadrada' },

    // Funciones de cadenas
    { label: 'CHR$', kind: CompletionItemKind.Function, detail: 'Devuelve el carácter correspondiente a un código ASCII' },
    { label: 'ASC', kind: CompletionItemKind.Function, detail: 'Devuelve el código ASCII de un carácter' },
    { label: 'LEN', kind: CompletionItemKind.Function, detail: 'Devuelve la longitud de una cadena' },
    { label: 'LEFT$', kind: CompletionItemKind.Function, detail: 'Devuelve una subcadena desde la izquierda' },
    { label: 'RIGHT$', kind: CompletionItemKind.Function, detail: 'Devuelve una subcadena desde la derecha' },
    { label: 'MID$', kind: CompletionItemKind.Function, detail: 'Devuelve una subcadena desde una posición específica' },

    // Otros
    { label: 'REM', kind: CompletionItemKind.Keyword, detail: 'Comentario en el código' },
    { label: 'DATA', kind: CompletionItemKind.Keyword, detail: 'Define datos para ser leídos con READ' },
    { label: 'READ', kind: CompletionItemKind.Keyword, detail: 'Lee datos definidos con DATA' },
    { label: 'RESTORE', kind: CompletionItemKind.Keyword, detail: 'Restaura el puntero de lectura de DATA' },
    { label: 'RANDOMIZE', kind: CompletionItemKind.Keyword, detail: 'Inicializa el generador de números aleatorios' },

    // Palabras clave adicionales de ZX Basic
    { label: 'BEEP', kind: CompletionItemKind.Keyword, detail: 'Genera un sonido' },
    { label: 'INK', kind: CompletionItemKind.Keyword, detail: 'Establece el color de la tinta' },
    { label: 'PAPER', kind: CompletionItemKind.Keyword, detail: 'Establece el color del fondo' },
    { label: 'BORDER', kind: CompletionItemKind.Keyword, detail: 'Establece el color del borde' },
    { label: 'POKE', kind: CompletionItemKind.Keyword, detail: 'Escribe un valor en una dirección de memoria' },
    { label: 'PEEK', kind: CompletionItemKind.Function, detail: 'Lee un valor de una dirección de memoria' },
    { label: 'OUT', kind: CompletionItemKind.Keyword, detail: 'Envía un valor a un puerto' },
    { label: 'IN', kind: CompletionItemKind.Function, detail: 'Lee un valor de un puerto' },
    { label: 'SUB', kind: CompletionItemKind.Keyword, detail: 'Define un procedimiento' },
    { label: 'FUNCTION', kind: CompletionItemKind.Keyword, detail: 'Define una función' },
];

function formatZXBasicCode(document) {
    const text = document.getText();
    const lines = text.split(/\r?\n/);
    const edits = [];
    let indentLevel = 0;
    const indentSize = 4; // Tamaño de la indentación (4 espacios)


    lines.forEach((line, i) => {
        const trimmedLine = line.trim();

        console.log('Línea:', i, 'Indentación:', indentLevel, 'Texto:', trimmedLine);

        // Reducir nivel de indentación para palabras clave de cierre
        if (/^\s*(END SUB|END FUNCTION|END IF|NEXT|WEND|LOOP)\b/i.test(trimmedLine)) {
            indentLevel = Math.max(0, indentLevel - 1);
        }

        // Calcular la indentación esperada
        const expectedIndent = ' '.repeat(indentLevel * indentSize);
        if (!line.startsWith(expectedIndent) || line !== expectedIndent + trimmedLine) {
            // Crear un cambio de texto para corregir la indentación
            edits.push(TextEdit.replace(
                Range.create(i, 0, i, line.length),
                expectedIndent + trimmedLine
            ));
        }

        // Aumentar nivel de indentación para palabras clave de apertura
        if (/^\s*(SUB|FUNCTION|IF|FOR|WHILE|DO)\b/i.test(trimmedLine)) {
            indentLevel++;
        }
    });

    console.log('Indentación corregida:', edits.length, 'líneas');

    return edits;
}

// Manejar el evento de formato de documentos
connection.onDocumentFormatting((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return [];
    }

    // Aplicar las reglas de formato
    return formatZXBasicCode(document);
});

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

// Manejar solicitud de definición
connection.onDefinition((params) => {
    const position = params.position;
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return null;
    }

    const lineText = document.getText(Range.create(position.line, 0, position.line, document.getText().length));
    const words = lineText.trim().split(/\s+/).map(word => word.replace(/[^\w]/g, ''));

    for (const word of words) {
        if (globalDefinitions.has(word)) {
            console.log(`Definición global encontrada para: ${word}`);
            return globalDefinitions.get(word);
        }
    }

    console.log('No se encontró definición global');
    return null;
});

// Manejar solicitud de referencias
connection.onReferences((params) => {
    const position = params.position;
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return [];
    }

    const lineText = document.getText(Range.create(position.line, 0, position.line, document.getText().length));
    const words = lineText.trim().split(/\s+/).map(word => word.replace(/[^\w]/g, ''));

    console.log(`Palabras detectadas en la línea ${position.line + 1}:`, words);

    for (const word of words) {
        if (globalReferences.has(word)) {
            console.log(`Referencias globales encontradas para: ${word}`);
            return globalReferences.get(word);
        }
    }

    console.log('No se encontraron referencias globales');
    return [];
});

// Inicialización del servidor
connection.onInitialize(() => {
    analyzeProjectFiles();

    return {
        capabilities: {
            textDocumentSync: {
                openClose: true,
                change: TextDocumentSyncKind.Incremental
            },
            completionProvider: {
                resolveProvider: true // Permite resolver detalles adicionales de los ítems
            },
            documentFormattingProvider: true, // Habilitar el formato de documentos
            definitionProvider: true, // Habilitar ir a la definición
            referencesProvider: true  // Habilitar encontrar referencias
        }
    };
});

const chokidar = require('chokidar');

// Observar archivos .bas en el proyecto
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

// Función para validar documentos ZX Basic
function validateZXBasic(document) {
    const text = document.getText();
    const diagnostics = [];

    // Ejemplo: Detectar errores básicos de sintaxis
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
        const trimmedLine = line.trim();

        // Detectar líneas vacías o mal formateadas
        if (trimmedLine === '') {
            diagnostics.push({
                range: Range.create(i, 0, i, line.length),
                message: 'Línea vacía detectada.',
                severity: DiagnosticSeverity.Information
            });
        }

        // Detectar palabras reservadas mal escritas (ejemplo: "pritn" en lugar de "print")
        if (/pritn/i.test(trimmedLine)) {
            diagnostics.push({
                range: Range.create(i, trimmedLine.indexOf('pritn'), i, trimmedLine.indexOf('pritn') + 5),
                message: '¿Quisiste decir "PRINT"?',
                severity: DiagnosticSeverity.Warning
            });
        }

        // Detectar errores comunes en ZX Basic (ejemplo: falta de "END")
        if (/^\s*if\s+.+\s+then\s*$/i.test(trimmedLine) && !/end\s*if/i.test(text)) {
            diagnostics.push({
                range: Range.create(i, 0, i, line.length),
                message: 'Falta "END IF" para esta estructura condicional.',
                severity: DiagnosticSeverity.Error
            });
        }
    });

    // Enviar diagnósticos al cliente
    connection.sendDiagnostics({
        uri: document.uri,
        version: document.version,
        diagnostics
    });
}

// Validar documentos al abrir o cambiar contenido
documents.onDidOpen((event) => {
    validateZXBasic(event.document);
});

documents.onDidChangeContent((event) => {
    validateZXBasic(event.document);
});

// Proveer autocompletado
connection.onCompletion(() => {
    // Retornar las palabras clave como sugerencias de autocompletado
    return zxBasicKeywords;
});

// Resolver detalles adicionales de los ítems de autocompletado
connection.onCompletionResolve((item) => {
    // Puedes agregar más detalles aquí si es necesario
    return item;
});

// Escuchar la conexión
connection.listen();