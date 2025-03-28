const {
    createConnection,
    Diagnostic,
    DiagnosticSeverity,
    Range,
    TextDocuments,
    TextDocumentSyncKind,
    CompletionItem,
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

const { zxBasicKeywords } = require('./const');
const { formatZXBasicCode } = require('./formatter');
const { globalDefinitions, globalReferences, analyzeProjectFiles } = require('./analyzer');

// Manejar el evento de formato de documentos
connection.onDocumentFormatting((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return [];
    }

    // Aplicar las reglas de formato
    return formatZXBasicCode(document);
});

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

const { watchBasicFiles } = require('./watcher');
watchBasicFiles();

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