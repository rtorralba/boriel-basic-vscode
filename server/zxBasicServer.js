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

const { validateZXBasic } = require('./validator');

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