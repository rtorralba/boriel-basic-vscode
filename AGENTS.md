# Guía de Contexto y Arquitectura para Agentes (AGENTS.md)

Este documento contiene el estado actual, arquitectura y detalles técnicos de la extensión **Boriel ZX Basic para VS Code** (`boriel-basic-vscode`), con especial foco en la implementación del depurador integrado **Turbo80**.

---

## 1. Visión General del Proyecto

La extensión proporciona soporte para desarrollo en **Boriel ZX Basic** (`zxbc`) para ZX Spectrum en Visual Studio Code:
- Compilación a binarios `.tap` / `.tzx` / `.bin`.
- Resaltado de sintaxis, autocompletado y diagnósticos.
- **Depurador dual**:
  1. **ZEsarUX**: Depurador remoto clásico mediante conexión TCP por socket (puerto 10000).
  2. **Turbo80**: Depurador webview integrado (basado en HTML5/Canvas/WebGL CRT y WebAssembly), sin requerir instalación de software externo.

---

## 2. Arquitectura de Turbo80

La integración de Turbo80 se inspiró en `vscode-sinclair-basic`, adaptada para soportar código compilado por **Boriel Basic** (traducción BASIC -> Z80 ASM -> Código Máquina):

### Componentes y Archivos Clave

| Archivo | Responsabilidad |
|---|---|
| [turbo80Manager.js](file:///c:/Users/rault/dev/boriel-basic-vscode/turbo80Manager.js) | Gestor singleton del `WebviewPanel`. Controla el ciclo de vida, emite eventos EventEmitter (`cpuPaused`, `cpuResumed`, `terminalLog`), y envía comandos hacia el webview (`loadTap`, `continue`, `stepOver`, `stepInto`, `stepOut`, `pause`, `setBreakpoints`, `setMappedAddresses`). |
| [turbo80Html.js](file:///c:/Users/rault/dev/boriel-basic-vscode/turbo80Html.js) | Genera el HTML y CSS/JS incrustado en el webview. Incluye el motor de depuración en cliente (`borielDebugger`), el canvas de Turbo80, el shader CRT opcional y el puente de comunicación bidireccional (`vscode.postMessage`). |
| [debugAdapter.js](file:///c:/Users/rault/dev/boriel-basic-vscode/debugAdapter.js) | Implementación de `LoggingDebugSession` (DAP). Gestiona la compilación con marcadores, generación de linemaps, resolución de variables (a partir del volcado de 48KB de RAM enviado por Turbo80 o lecturas socket en ZEsarUX), pila de llamadas y puntos de interrupción. |
| [extension.js](file:///c:/Users/rault/dev/boriel-basic-vscode/extension.js) | Registra comandos de ejecución/depuración (`boriel.runTurbo80`, `boriel.debugTurbo80`, `boriel.stepOverTurbo80`, etc.), gestiona el decorador de línea actual (`currentLineDecoration`), items en la barra de estado y el proveedor de configuraciones iniciales. |
| [package.json](file:///c:/Users/rault/dev/boriel-basic-vscode/package.json) | Declara la contribución de depuración `borielbasic`, configuraciones (`boriel.turbo80.*`), atajos de teclado y comandos. |
| `media/turbo80/` | Librerías JavaScript, estilos, ROMs Spectrum y recursos estáticos de Turbo80. |

---

## 3. Mecanismo de Mapeo y Depuración Boriel <-> Z80

A diferencia de un intérprete de Sinclair BASIC, **Boriel Basic compila a código máquina Z80**. Una sola línea de Boriel (ej. `PRINT "Hola"`) produce entre 5 y 20 instrucciones ensamblador.

### Flujo de Compilación y Mapeo
1. **Inyección de marcadores**: Se preprocesa el código BASIC inyectando etiquetas `BAS___<linea>___<fichero>:` antes de cada sentencia.
2. **Generación de ASM y Linemap**:
   - `zxbc` compila con `-O0 -A`.
   - Se procesa el ensamblador resultante generando `.debug/<programa>.linemap.json`.
   - Se construyen en memoria:
     - `_basLineToAddress`: Dirección en memoria del inicio de cada línea en el archivo principal.
     - `_fileAddrMap`: Direcciones por fichero fuente absoluto (evita colisiones con archivos incluidos en `lib/`).
     - `_addrToFileAndLine`: Mapeo inverso de dirección Z80 -> `{ file, line }`.
     - `_addrToBasLine`: Mapeo inverso de dirección Z80 -> número de línea.
3. **Inicio de Turbo80**:
   - Se carga el TAP codificado en Base64.
   - Se calculan las direcciones de entrada y se envía el array `mappedAddresses` mediante `_getMappedAddresses()`.
   - Si `stopOnEntry` está activo, se fija un breakpoint en la dirección inicial (`entryAddr`).

---

## 4. Problemas Críticos Identificados y Resueltos

### Error 1: `The "path" argument must be of type string. Received undefined`
- **Causa**: Al lanzar el debugger sin una configuración explícita o con `languageId` `'borielbasic'` (en lugar de `'boriel-basic'`), `args.program` o `args.sourceFile` llegaban como `undefined`, provocando que `path.dirname(program)` fallara.
- **Solución**:
  - Normalización de ambos `languageId` (`borielbasic` y `boriel-basic`) en [extension.js](file:///c:/Users/rault/dev/boriel-basic-vscode/extension.js).
  - Búsqueda recursiva/heurística de `main.bas`, `src/main.bas` o `test/src/main.bas` y `.tap` por defecto en [debugAdapter.js](file:///c:/Users/rault/dev/boriel-basic-vscode/debugAdapter.js).
  - Añadido de `"emulator": "turbo80"` en [test/.vscode/launch.json](file:///c:/Users/rault/dev/boriel-basic-vscode/test/.vscode/launch.json).

### Error 2: Múltiples pulsaciones de Step para una sola línea de Boriel
- **Causa**:
  - En `turbo80Html.js`, la función `doStepOver` contenía:
    ```javascript
    while (steps < maxSteps && sp.breakHit == null) { ... }
    ```
  - Al invocar `main.stepOver()`, Turbo80 marcaba internamente `sp.breakHit` al término de cada instrucción o subrutina Z80. Esto provocaba que el bucle saliera **tras la primera instrucción ensamblador**, en lugar de continuar hasta la siguiente línea de Boriel.
  - Al estar el emulador ya en pausa (`main.paused === true`), no se emitía un nuevo evento de pausa a VS Code.
- **Solución**:
  - Se modificaron `doStepOver` y `doStepInto` en [turbo80Html.js](file:///c:/Users/rault/dev/boriel-basic-vscode/turbo80Html.js) para ejecutar instrucciones intermedias en un bucle continuo hasta que el registro `PC` del Z80 coincida con una dirección de Boriel Basic registrada (`addrSet.has(pc)`) o un breakpoint de usuario (`userBps.has(pc)`).
  - Se llama explícitamente a `borielDebugger.onPaused(main, sp, 'step')` para capturar registros, volcar 48KB de RAM en base64 y notificar inmediatamente a VS Code con `cpuPaused`.
  - Se actualizó `_getMappedAddresses()` en [debugAdapter.js](file:///c:/Users/rault/dev/boriel-basic-vscode/debugAdapter.js) para incluir todas las direcciones presentes en `_addrToBasLine` y `_addrToFileAndLine`.

### Error 3: Compilación errónea del archivo activo en vez del archivo raíz (`main.bas`)
- **Causa**: Al lanzar la ejecución o depuración con comandos (`runTurbo80`, `debugTurbo80`, o `F5`), el sistema priorizaba el archivo abierto actualmente en el editor (`activeTextEditor`, por ejemplo `lib/functions.bas`) sobre el archivo raíz del proyecto definido en `launch.json` (`sourceFile: "src/main.bas"`). Esto obligaba al usuario a tener que abrir siempre el archivo `main.bas` antes de pulsar F5 o depurar.
- **Solución**:
  - Se introdujeron funciones auxiliares `getBorielLaunchConfig` y `getProjectRootSourceFile` en [extension.js](file:///c:/Users/rault/dev/boriel-basic-vscode/extension.js).
  - La resolución del archivo fuente a compilar y depurar sigue un orden estricto de precedencia estándar:
    1. `sourceFile` definido en `launch.json` para la configuración activa/emulador correspondiente.
    2. Ajuste `borielBasic.mainFile` de la configuración de VS Code.
    3. Candidatos comunes de raíz del proyecto (`src/main.bas`, `main.bas`, `test/src/main.bas`).
    4. Archivo abierto en el editor (únicamente si no existe ningún archivo raíz definido).
### Error 4: Congelación y rebote a la última línea al terminar el programa
- **Causa**: Al ejecutar un Step Over o Step Into sobre la última instrucción del programa (ej. línea 10 `checkScoreAndPrint()`), el código máquina Z80 finaliza con `.core.__END_PROGRAM: ret`, devolviendo el control al intérprete de Sinclair BASIC en la ROM del Spectrum (`PC < 0x4000`). Como ninguna dirección de la ROM coincide con el mapeo de líneas Boriel en RAM (`addrSet`), el bucle de Step en `turbo80Html.js` iteraba 200.000 instrucciones ensamblador en un bucle síncrono bloqueante ("se queda pensando"). Al finalizar los 200.000 pasos, enviaba `cpuPaused` con el PC en ROM; como `debugAdapter.js` no encontraba fichero ni línea para una dirección de ROM, mantenía la última línea conocida (la línea 10), provocando que la sesión pareciera no terminar nunca.
- **Solución**:
  - Detección inmediata de retorno a ROM (`currentPc < 0x4000`) en `doStepOver`, `doStepInto` y `doStepOut` dentro de [turbo80Html.js](file:///c:/Users/rault/dev/boriel-basic-vscode/turbo80Html.js).
  - Emisión de un evento `programEnded` desde el webview hacia `turbo80Manager.js`.
  - En [debugAdapter.js](file:///c:/Users/rault/dev/boriel-basic-vscode/debugAdapter.js), recepción de `programEnded` o detección de `PC < 0x4000` en `_turbo80PausedHandler` que envía limpiamente un `TerminatedEvent()` de DAP a VS Code.
  - El emulador Turbo80 reanuda su ejecución normal (`emulator.resume()`) para que el usuario pueda seguir interactuando con la pantalla final del Spectrum, mientras que la barra de herramientas de depuración de VS Code finaliza limpiamente sin bloqueos.

---

## 5. Configuración de `launch.json`

Para depurar con Turbo80 (por defecto si no se especifica ZEsarUX):
```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "borielbasic",
            "request": "launch",
            "name": "Debug con Turbo80 (Webview)",
            "emulator": "turbo80",
            "program": "${workspaceFolder}/test/dist/main.tap",
            "sourceFile": "${workspaceFolder}/test/src/main.bas",
            "stopOnEntry": true,
            "turbo80Model": "128k",
            "turbo80Crt": true
        },
        {
            "type": "borielbasic",
            "request": "launch",
            "name": "Debug con ZEsarUX",
            "emulator": "zesarux",
            "zesaruxPath": "zesarux",
            "program": "${workspaceFolder}/test/dist/main.tap",
            "sourceFile": "${workspaceFolder}/test/src/main.bas",
            "stopOnEntry": true
        }
    ]
}
```

---

## 6. Verificación y Pruebas

Para comprobar que no hay errores de sintaxis en los archivos principales:
```bash
node -c extension.js debugAdapter.js turbo80Manager.js turbo80Html.js
```

### Comprobaciones al depurar:
1. **F5 (Iniciar Depuración)**: Abre el panel de Turbo80, carga el TAP y se detiene en la primera instrucción (`stopOnEntry: true`), resaltando la línea 4 en `main.bas`.
2. **F10 (Step Over)**: Debe avanzar exactamente una línea de Boriel Basic por pulsación.
3. **F11 (Step Into)**: Debe entrar dentro de funciones/subrutinas definidas en Boriel Basic.
4. **F5 (Continue)**: Reanuda la ejecución del Z80 hasta el siguiente breakpoint o el final.
5. **Inspección de variables**: El panel de variables de VS Code decodifica variables globales leyendo directamente del volcado de RAM de Turbo80.
