# Guía de Depuración de Boriel Basic

Esta extensión incluye un **debug adapter nativo de VS Code (DAP)** que permite depurar programas de Boriel Basic paso a paso, inspeccionar variables y registros, y establecer breakpoints directamente sobre el código `.bas`.

La depuración se puede realizar con dos emuladores:
1. **Turbo80 (Recomendado)**: Emulador web ZX Spectrum totalmente integrado en una pestaña Webview dentro de VS Code. **No requiere instalar nada externo** ni configurar rutas de ejecutables o puertos.
2. **ZEsarUX**: Emulador externo conectado mediante protocolo de depuración remota TCP (puerto 10000).

---

## 1. Depuración con Turbo80 (Integrado en VS Code)

### Ventajas de Turbo80
- **Cero configuración externa**: No necesitas instalar binarios ni configurar variables de entorno o PATH.
- **Pestaña integrada (Webview)**: El emulador se ejecuta junto a tu editor con filtro CRT, audio y pantalla completa opcional.
- **Rendimiento instantáneo**: Las variables se leen directamente desde un volcado de memoria RAM (snapshot) en microsegundos, sin latencias de sockets.
- **Paso a paso Boriel Basic**: Step Over (F10), Step Into (F11) y Step Out (Shift+F11) avanzan el CPU Z80 hasta la siguiente instrucción mapeada del código `.bas`.
- **Barra de estado**: Indicador en tiempo real con el estado de ejecución y dirección Z80 actual.

### Configuración básica para Turbo80 (`launch.json`)

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "borielbasic",
            "request": "launch",
            "name": "Debug Boriel Basic (Turbo80)",
            "emulator": "turbo80",
            "sourceFile": "src/main.bas",
            "stopOnEntry": true
        }
    ]
}
```

### Comandos directos de Turbo80
- **F5** (en archivo `.bas`): Iniciar depuración con Turbo80.
- **Ctrl+F5** (Cmd+F5 en macOS): Compilar y ejecutar en Turbo80 (sin depurar).
- Botón **Ejecutar en Turbo80** y **Depurar en Turbo80** en la barra superior del editor (`editor/title`).

---

## 2. Depuración con ZEsarUX (Emulador Externo)

### Cómo funciona con ZEsarUX
Al iniciar una sesión de depuración con ZEsarUX:
1. Compila el `.bas` automáticamente (con `-O0` para preservar la correspondencia de líneas).
2. Genera un ASM intermedio en la carpeta `.debug/` e invoca `zxbasm -d` para extraer las direcciones de los marcadores `BAS___N___filename`.
3. Construye el mapa `línea Boriel → dirección de memoria`.
4. Lanza ZEsarUX con el protocolo remoto habilitado.
5. Se conecta por socket al puerto de debug y carga el programa con `smartload`.
6. Pausa la ejecución en el punto de entrada (si `stopOnEntry: true`).

### Configuración para ZEsarUX (`launch.json`)

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "borielbasic",
            "request": "launch",
            "name": "Debug Boriel Basic (ZEsarUX)",
            "emulator": "zesarux",
            "program": "${workspaceFolder}/dist/main.tap",
            "zesaruxPath": "zesarux",
            "debugPort": 10000,
            "stopOnEntry": true,
            "sourceFile": "src/main.bas"
        }
    ]
}
```

### Propiedades de `launch.json`

| Propiedad | Tipo | Descripción | Por defecto |
|-----------|------|-------------|-------------|
| `emulator` | string | Emulador a usar: `"turbo80"` o `"zesarux"` | `"turbo80"` |
| `turbo80Model` | string | Modelo de máquina para Turbo80 (`"48k"` o `"128k"`) | `"48k"` |
| `sourceFile` | string | Archivo `.bas` principal (relativo al workspace o absoluto) | `borielBasic.mainFile` o `src/main.bas` |
| `stopOnEntry` | boolean | Pausar al inicio del programa en la primera línea de código Boriel | `true` |
| `program` | string | Ruta al `.tap` de salida (opcional para Turbo80 si compila) | `${workspaceFolder}/dist/main.tap` |
| `zesaruxPath` | string | Ruta al ejecutable de ZEsarUX (solo si `emulator` es `"zesarux"`) | `zesarux` (en PATH) |
| `debugPort` | integer | Puerto del protocolo remoto de ZEsarUX | `10000` |

## Funcionalidades disponibles

### Breakpoints

Coloca breakpoints directamente en el editor sobre los archivos `.bas`. La extensión traduce automáticamente el número de línea Boriel a la dirección de memoria correspondiente y la envía a ZEsarUX con `set-breakpoint`.

Se admiten breakpoints en archivos incluidos (no solo en el archivo principal).

### Control de ejecución

| Acción VS Code | Comando ZEsarUX enviado |
|----------------|------------------------|
| Continue (F5) | `run` |
| Step Over (F10) | `cpu-step-over` |
| Step Into (F11) | `cpu-step` |
| Pause | `enter-cpu-step` |
| Stop | termina el proceso ZEsarUX |

### Variables

El panel **Variables** de VS Code muestra las variables globales declaradas en el programa. La extensión las detecta analizando el ASM generado (etiquetas seguidas de directivas `DB`/`DW`/`DS`) y lee su valor en tiempo real desde la memoria del emulador con `read-memory`.

Se soportan los tipos: `BYTE`, `UBYTE`, `INTEGER`, `UINTEGER`, `LONG`, `ULONG`, `FIXED`, `FLOAT`, `STRING` y arrays de todos ellos.

### Stack trace

El panel **Call Stack** muestra la posición actual en el código Boriel. Al hacer step, VS Code lee el nuevo valor de `PC` con `get-registers` y lo traduce de vuelta a la línea de código fuente usando el mapa generado.

## Archivos intermedios (.debug/)

Durante cada sesión de depuración la extensión crea (y limpia al inicio de cada sesión) la carpeta `.debug/` en la raíz del workspace con los siguientes archivos:

| Archivo | Contenido |
|---------|-----------|
| `.debug/<name>.asm` | ASM generado desde el `.bas` preprocesado, con marcadores `BAS___N___filename:` |
| `.debug/<name>.linemap.json` | Mapa `dirección → { borielLine, sourceFile, isEndOfSub }` generado por `zxbasm -d` |
| `.debug/<source>.bas` | Versiones preprocesadas de cada `.bas` del proyecto |

## Cómo funciona el mapeo de líneas

El compilador `zxbc` inserta en el ASM etiquetas de la forma:

```asm
BAS___5___main__bas:
    LD A, 42
    ...
BAS___6___main__bas:
    ...
```

La extensión invoca `zxbasm -d` sobre ese ASM y analiza las líneas `Declaring` de la salida, que tienen el formato:

```
Declaring '.BAS___5___main__bas' (value 92BBh) in 2
```

De ahí extrae que la línea 5 de `main.bas` está en la dirección `0x92BB`. Este proceso es el más fiable porque refleja el valor real calculado por el ensamblador.

Si no se encuentran declaraciones en la salida de `zxbasm` (fallback), la extensión usa una heurística buscando las etiquetas directamente en el texto del ASM.

## Comandos ZEsarUX usados internamente

```
enter-cpu-step        # Activar modo step (pausa la CPU)
exit-cpu-step         # Desactivar modo step
smartload <path>      # Cargar y ejecutar un .tap directamente
run                   # Ejecutar hasta el siguiente breakpoint
cpu-step              # Step into (una instrucción Z80)
cpu-step-over         # Step over (salta CALLs completos)
set-breakpoint N ADDR # Establecer breakpoint en dirección hexadecimal ADDR
enable-breakpoints    # Habilitar el sistema de breakpoints
get-registers         # Leer registros de la CPU (incluye PC)
read-memory ADDR LEN  # Leer LEN bytes desde ADDR (para leer variables)
```

## Requisitos

- **ZEsarUX** instalado y accesible en la ruta configurada en `zesaruxPath`.
- El proyecto debe tener un archivo `.bas` compilable (la extensión compila automáticamente).
- La carpeta `dist/` se crea automáticamente si no existe.
