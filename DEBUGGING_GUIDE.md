# Guía de Depuración con ZEsarUX

## Cómo funciona el debugger

La extensión incluye un **debug adapter nativo de VS Code** que controla ZEsarUX de forma completamente automática. No es necesario lanzar ZEsarUX manualmente ni conectarse por telnet.

Al iniciar una sesión de depuración, la extensión:
1. Compila el `.bas` automáticamente (con `-O0` para preservar la correspondencia de líneas).
2. Genera un ASM intermedio en la carpeta `.debug/` e invoca `zxbasm -d` para extraer las direcciones de los marcadores `BAS___N___filename`.
3. Construye el mapa `línea Boriel → dirección de memoria`.
4. Lanza ZEsarUX con el protocolo remoto habilitado.
5. Se conecta por socket al puerto de debug y carga el programa con `smartload`.
6. Pausa la ejecución en el punto de entrada (si `stopOnEntry: true`).

## Configuración (launch.json)

Añade una configuración de tipo `borielbasic` en `.vscode/launch.json`:

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "borielbasic",
            "request": "launch",
            "name": "Debug con ZEsarUX",
            "program": "${workspaceFolder}/dist/main.tap",
            "zesaruxPath": "/ruta/a/zesarux",
            "debugPort": 10000,
            "stopOnEntry": true,
            "sourceFile": "src/main.bas"
        }
    ]
}
```

### Propiedades

| Propiedad | Tipo | Descripción | Por defecto |
|-----------|------|-------------|-------------|
| `program` | string | Ruta al `.tap` de salida | `${workspaceFolder}/dist/main.tap` |
| `zesaruxPath` | string | Ruta al ejecutable de ZEsarUX | `zesarux` (en PATH) |
| `debugPort` | integer | Puerto del protocolo remoto de ZEsarUX | `10000` |
| `stopOnEntry` | boolean | Pausar al inicio del programa | `true` |
| `sourceFile` | string | Archivo `.bas` principal (relativo al workspace o absoluto) | `borielBasic.mainFile` o `main.bas` |

Si no se especifica `zesaruxPath`, se usa el valor de `borielBasic.zesaruxPath` en la configuración de VS Code.

## Cómo iniciar el debugger

1. Configura `zesaruxPath` apuntando a tu instalación de ZEsarUX.
2. Presiona **F5** o usa el menú _Run → Start Debugging_.
3. VS Code compilará el proyecto, lanzará ZEsarUX y pausará en la primera línea.

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
