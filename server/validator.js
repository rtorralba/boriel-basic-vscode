// Función para validar documentos ZX Basic
function validateZXBasic(document) {
    const text = document.getText();
    const diagnostics = [];

    // Ejemplo: Detectar errores básicos de sintaxis
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
        const trimmedLine = line.trim();

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

        // Detectar errores comunes en ZX Basic (ejemplo: falta de "NEXT")
        if (/^\s*for\s+.+\s+to\s+.+\s+step\s+.+\s*$/i.test(trimmedLine) && !/next/i.test(text)) {
            diagnostics.push({
                range: Range.create(i, 0, i, line.length),
                message: 'Falta "NEXT" para este bucle FOR.',
                severity: DiagnosticSeverity.Error
            });
        }

        // Detectar errores comunes en ZX Basic (ejemplo: falta de "WEND")
        if (/^\s*while\s+.+\s*$/i.test(trimmedLine) && !/wend/i.test(text)) {
            diagnostics.push({
                range: Range.create(i, 0, i, line.length),
                message: 'Falta "WEND" para este bucle WHILE.',
                severity: DiagnosticSeverity.Error
            });
        }

        // Detectar errores comunes en ZX Basic (ejemplo: falta de "LOOP")
        if (/^\s*do\s*$/i.test(trimmedLine) && !/loop/i.test(text)) {
            diagnostics.push({
                range: Range.create(i, 0, i, line.length),
                message: 'Falta "LOOP" para este bucle DO.',
                severity: DiagnosticSeverity.Error
            });
        }

        // Detectar errores comunes en ZX Basic (ejemplo: falta de "RETURN")
        if (/^\s*gosub\s+.+\s*$/i.test(trimmedLine) && !/return/i.test(text)) {
            diagnostics.push({
                range: Range.create(i, 0, i, line.length),
                message: 'Falta "RETURN" para esta subrutina.',
                severity: DiagnosticSeverity.Error
            });
        }

        // Detectar errores comunes en ZX Basic (ejemplo: falta de "END FUNCTION")
        if (/^\s*def\s+function\s+.+\s*$/i.test(trimmedLine) && !/end\s+function/i.test(text)) {
            diagnostics.push({
                range: Range.create(i, 0, i, line.length),
                message: 'Falta "END FUNCTION" para esta función.',
                severity: DiagnosticSeverity.Error
            });
        }

        // Detectar errores comunes en ZX Basic (ejemplo: falta de "END SUB")
        if (/^\s*def\s+sub\s+.+\s*$/i.test(trimmedLine) && !/end\s+sub/i.test(text)) {
            diagnostics.push({
                range: Range.create(i, 0, i, line.length),
                message: 'Falta "END SUB" para esta subrutina.',
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

module.exports = {
    validateZXBasic
}