# Boriel Basic VSCode Extension

## Descripción

La extensión **Boriel Basic VSCode** está diseñada para facilitar el desarrollo de programas en el lenguaje Boriel Basic dentro del editor Visual Studio Code. Boriel Basic es un compilador que permite crear software para computadoras retro como el ZX Spectrum, proporcionando una experiencia de programación moderna para plataformas clásicas.

## Funcionalidades

- **Resaltado de sintaxis**: Coloreado de palabras clave, comentarios, cadenas, números y estructuras del lenguaje en archivos `.bas` y `.zxbas`. El resaltado también funciona en bloques de código Boriel Basic dentro de archivos Markdown.
- **Compilación integrada**: Compila directamente tus archivos `.bas` desde VSCode usando el compilador Boriel Basic incluido (Windows, Linux y macOS). Genera `.tap` o `.bin` en la carpeta `dist/`. Configurable desde los ajustes de la extensión.
- **Autocompletado (LSP)**: Sugerencias inteligentes de palabras clave, funciones, variables y símbolos definidos en el proyecto, proporcionadas por el Language Server.
- **Ir a la definición (LSP)**: Pulsa `F12` o usa clic derecho → *Go to Definition* para saltar directamente a donde se define una variable, función o etiqueta.
- **Buscar referencias (LSP)**: Localiza todos los usos de un símbolo en el proyecto con clic derecho → *Find All References* (`Shift+F12`).
- **Documentación al pasar el ratón (LSP)**: Muestra documentación e información de tipo de variables y funciones al situar el cursor sobre ellas.
- **Diagnósticos en tiempo real (LSP)**: Errores y advertencias subrayados directamente en el editor a medida que escribes, sin necesidad de compilar.
- **Formato e indentación (LSP)**: Formatea el documento con `Shift+Alt+F`. Opcionalmente convierte las palabras clave a mayúsculas o minúsculas según la opción `borielBasic.formatKeywords`.
- **Rename de símbolos (LSP)**: Renombra variables, funciones y etiquetas en todos los ficheros del proyecto a la vez pulsando `F2` sobre cualquier símbolo.
- **Refactor – Extract Method (LSP)**: Selecciona un bloque de código, abre el menú de refactoring (clic derecho → Refactor… o el icono de bombilla) y elige **Extract Method** para extraer el bloque a una nueva subrutina.
- **Exportar sprites ZXP**: Convierte archivos `.zxp` a código Boriel Basic listo para usar (clic derecho sobre el archivo → Export ZXP to Boriel Basic). Instala automáticamente la librería `zxp2boriel` en un entorno virtual Python la primera vez.
- **Actualización del LSP**: Actualiza el servidor de lenguaje a la última versión publicada en npm mediante el comando `Boriel Basic: Actualizar Boriel Basic LSP` (paleta de comandos).
- **Depuración integrada con Turbo80 (Webview)**: Ejecuta y depura tus programas Boriel Basic paso a paso (DAP) directamente en una pestaña de VS Code sin instalar software externo. Con emulación precisa de ZX Spectrum (48K/128K), shader CRT opcional, inspección en vivo de variables globales y soporte para puntos de ruptura.
- **Depuración con ZEsarUX**: Depura tus programas Boriel Basic externamente conectándote al emulador [ZEsarUX](https://github.com/chernandezba/zesarux) como backend de depuración mediante socket TCP.

## Depuración con Turbo80 (Webview Integrado)

La extensión incluye el emulador **Turbo80** integrado mediante Webview, permitiendo probar y depurar tus programas con 0 dependencias externas:

Para depurar con Turbo80, añade la siguiente configuración a tu `.vscode/launch.json`:

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "borielbasic",
            "request": "launch",
            "name": "Debug con Turbo80 (Webview)",
            "emulator": "turbo80",
            "program": "${workspaceFolder}/dist/main.tap",
            "sourceFile": "${workspaceFolder}/src/main.bas",
            "stopOnEntry": true,
            "turbo80Model": "128k",
            "turbo80Crt": true
        }
    ]
}
```

| Propiedad | Descripción |
|---|---|
| `emulator` | Debe ser `"turbo80"` (emulador integrado por defecto) o `"zesarux"` |
| `program` | Ruta al archivo `.tap` generado por la compilación |
| `sourceFile` | Archivo raíz del proyecto (`main.bas`) a compilar y depurar |
| `stopOnEntry` | Si es `true`, pausa en la primera línea de Boriel Basic al arrancar |
| `turbo80Model` | Modelo de ZX Spectrum a emular (`"128k"` por defecto, `"48k"`, `"16k"`, `"plus2"`, `"plus2a"`, etc.) |
| `turbo80Crt` | Activa (`true`) o desactiva (`false`) el filtro CRT de televisión clásica |

También puedes ejecutar directamente sin depurador usando el comando **Boriel Basic: Ejecutar en Turbo80 (Webview)** o cambiar el modelo en cualquier momento mediante **Boriel Basic: Seleccionar Modelo de ZX Spectrum (Turbo80)**.

## Depuración con ZEsarUX

Para depurar un programa con ZEsarUX necesitas configurar un archivo `.vscode/launch.json` en tu proyecto:

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "borielbasic",
            "request": "launch",
            "name": "Debug Boriel Basic (ZEsarUX)",
            "emulator": "zesarux",
            "program": "${workspaceFolder}\\dist\\main.tap",
            "sourceFile": "src/main.bas",
            "zesaruxPath": "C:\\path\\to\\ZEsarUX\\zesarux.exe",
            "debugPort": 10000,
            "stopOnEntry": false
        }
    ]
}
```

| Propiedad | Descripción |
|---|---|
| `program` | Ruta al archivo `.tap` generado por la compilación |
| `zesaruxPath` | Ruta al ejecutable de ZEsarUX |
| `debugPort` | Puerto del protocolo remoto de ZEsarUX (por defecto `10000`) |
| `stopOnEntry` | Si es `true`, la ejecución se detiene automáticamente al arrancar (por defecto `true`) |

**Pasos para depurar:**

1. Añade puntos de ruptura en tu código `.bas` haciendo clic en el margen izquierdo del editor.
2. Pulsa `F5` o ve a la vista de Depuración (`Ctrl+Shift+D`) y selecciona la configuración de depuración.
3. El emulador se lanzará automáticamente y la ejecución se detendrá en los breakpoints definidos.

> **Nota para ZEsarUX**: ZEsarUX debe estar instalado en tu sistema si utilizas este emulador. Descárgalo desde [https://github.com/chernandezba/zesarux](https://github.com/chernandezba/zesarux).

## Instalación

1. Descarga e instala [Visual Studio Code](https://code.visualstudio.com/).
2. Busca "Boriel Basic" en la sección de extensiones de VSCode.
3. Instala la extensión y reinicia el editor si es necesario.

## Uso

1. Abre un archivo `.bas` o crea uno nuevo.
2. Escribe tu código en Boriel Basic.
3. Usa los comandos disponibles en la paleta de comandos (`Ctrl+Shift+P` o `Cmd+Shift+P`) para compilar o ejecutar tu programa.
4. Visualiza los resultados en el emulador o revisa los errores en la consola.

<iframe width="560" height="315" src="https://www.youtube.com/embed/kRisOZiohL0?si=tc58zJQV8LMkkXlO" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>

## Requisitos

- Opcional: Un emulador compatible con ZX Spectrum para probar tus programas (si prefieres un emulador externo en vez del integrado Turbo80).

## Contribuciones

Si deseas contribuir al desarrollo de esta extensión, por favor, abre un issue o envía un pull request en el repositorio oficial.

## Agradecimientos y Mención Especial / Acknowledgements

* **Turbo80 (Emulador Web Integrado)**: La emulación integrada en Webview y depuración offline está impulsada por [Turbo80](https://turbo80.com), creado por **José Enrique García (Incinerator)**. Un agradecimiento muy especial por su extraordinario trabajo y su enorme contribución a la preservación del ZX Spectrum y a la comunidad de retroinformática.
* **Aspectos Legales y Licencias de ROMs (Turbo80)**:
  * **Amstrad**: Titular de las ROMs de los ordenadores Sinclair ZX Spectrum (16K, 48K, Spectrum+, 128K) y de los modelos Amstrad (+2, +2A, +3) (© 1982-1987 Sinclair Research Ltd / Amstrad), con permiso concedido para su redistribución junto a emuladores reteniendo sus derechos (*"Amstrad have kindly given their permission for the redistribution of their copyrighted material but retain that copyright"*).
  * **Timex**: Las modificaciones de ROM de Timex TC2048, TC2068 y TS2068 están en el dominio público.
  * **Interface 1**: ROM © 1983 Sinclair Research Ltd.
  * **esxDOS**: esxDOS 0.8.9 (© 2005-2021 Papaya Dezign, Miguel Guerreiro, https://esxdos.org/) incluido con permiso.
  * **+D y DISCiPLE**: ROMs de interfaces de disco incluidas con permiso de Datel.
* **Boriel ZX Basic Compiler**: A Boriel (José Rodríguez) por el magnífico compilador `zxbc` para ZX Spectrum.
* **ZEsarUX**: A César Hernández Bañó por el emulador ZEsarUX y su soporte de depuración remota.

## Licencia & Copyright

GNU Affero General Public License v3.0 (AGPL-3.0).  
Copyright (C) 2025-2026 **Raül Torralba (Juntelart)**.

> **Renuncia de garantía / Disclaimer (AS IS)**: El software se proporciona "tal cual" (*AS IS*), sin garantía de ningún tipo, expresa o implícita. En ningún caso el autor será responsable de ningún reclamo, daño u otra responsabilidad derivada del uso de este software.

Consulta el archivo [LICENSE](LICENSE) para más detalles.
