const {
    Range,
    TextEdit,
} = require('vscode-languageserver/node');

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
        if (/^\s*(END SUB|END FUNCTION|END IF|NEXT|WEND|LOOP|END ASM|#ENDIF)\b/i.test(trimmedLine)) {
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
        if (/^\s*(SUB|FUNCTION|IF|FOR|WHILE|DO|ASM#IF)\b/i.test(trimmedLine)) {
            indentLevel++;
        }
    });

    console.log('Indentación corregida:', edits.length, 'líneas');

    return edits;
}

module.exports = {
    formatZXBasicCode
};