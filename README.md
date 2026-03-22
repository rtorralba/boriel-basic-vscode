# Boriel Basic VSCode Extension

## Descripción

La extensión **Boriel Basic VSCode** está diseñada para facilitar el desarrollo de programas en el lenguaje Boriel Basic dentro del editor Visual Studio Code. Boriel Basic es un compilador que permite crear software para computadoras retro como el ZX Spectrum, proporcionando una experiencia de programación moderna para plataformas clásicas.

## Funcionalidades

- **Resaltado de sintaxis**: Mejora la legibilidad del código Boriel Basic con colores específicos para palabras clave, comentarios y estructuras del lenguaje.
- **Compilación integrada**: Compila directamente tus archivos `.bas` desde VSCode utilizando el compilador Boriel Basic.
- **Ejecución rápida**: Ejecuta tus programas en un emulador compatible con un solo clic.
- **Autocompletado**: Sugerencias inteligentes para comandos y funciones del lenguaje Boriel Basic.
- **Errores en tiempo de compilación**: Visualiza errores y advertencias directamente en el editor.
- **Soporte para proyectos**: Organiza y gestiona proyectos Boriel Basic de manera eficiente.
- **Rename de símbolos (LSP)**: Renombra variables, funciones y etiquetas en todos los ficheros del proyecto a la vez pulsando `F2` sobre cualquier símbolo. Requiere que el Language Server esté activo.
- **Refactor – Extract Method (LSP)**: Selecciona un bloque de código, abre el menú de refactoring (clic derecho → Refactor… o el icono de bombilla) y elige **Extract Method** para extraer el bloque a una nueva subrutina. Requiere que el Language Server soporte `textDocument/codeAction` con `refactor.extract`.
- **Exportar sprites ZXP**: Convierte archivos `.zxp` a código Boriel Basic listo para usar (clic derecho sobre el archivo → Export ZXP to Boriel Basic). Instala automáticamente la librería `zxp2boriel` en un entorno virtual Python la primera vez.
- **Actualización del LSP**: Actualiza el servidor de lenguaje a la última versión publicada en npm mediante el comando `Boriel Basic: Update LSP` (paleta de comandos).
- **Depuración con ZEsarUX**: Depura tus programas Boriel Basic directamente desde VSCode usando el emulador [ZEsarUX](https://github.com/chernandezba/zesarux) como backend de debug. Soporta puntos de ruptura, inspección de variables y ejecución paso a paso.

## Depuración con ZEsarUX

Para depurar un programa necesitas configurar un archivo `.vscode/launch.json` en tu proyecto:

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
            "debugPort": 10000
        }
    ]
}
```

| Propiedad | Descripción |
|---|---|
| `program` | Ruta al archivo `.tap` generado por la compilación |
| `zesaruxPath` | Ruta al ejecutable de ZEsarUX |
| `debugPort` | Puerto del protocolo remoto de ZEsarUX (por defecto `10000`) |

**Pasos para depurar:**

1. Compila tu proyecto (`Ctrl+Shift+P` → `Boriel Basic: Compile`) para generar el `.tap`.
2. Añade puntos de ruptura en tu código `.bas` haciendo clic en el margen izquierdo del editor.
3. Pulsa `F5` o ve a la vista de Depuración (`Ctrl+Shift+D`) y selecciona la configuración `Debug con ZEsarUX`.
4. ZEsarUX se lanzará automáticamente y la ejecución se detendrá en los breakpoints definidos.

> **Nota**: ZEsarUX debe estar instalado en tu sistema. Descárgalo desde [https://github.com/chernandezba/zesarux](https://github.com/chernandezba/zesarux).

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

- Opcional: Un emulador compatible con ZX Spectrum para probar tus programas.

## Contribuciones

Si deseas contribuir al desarrollo de esta extensión, por favor, abre un issue o envía un pull request en el repositorio oficial.

## Licencia

Este proyecto está bajo la licencia MIT. Consulta el archivo `LICENSE` para más detalles.
