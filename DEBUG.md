# Depuración de Boriel Basic

Esta extensión incluye soporte completo para depurar programas de Boriel Basic paso a paso, con breakpoints en archivos `.bas`, inspección de variables y registros del Z80.

Soporta dos emuladores:
1. **Turbo80 (Integrado, recomendado)**: Emulador web en pestaña Webview de VS Code. No requiere instalar ningún ejecutable ni configurar rutas.
2. **ZEsarUX (Externo)**: Emulador externo mediante protocolo de depuración remota TCP.

## 1. Depuración con Turbo80 (Webview integrada)

No necesitas instalar ningún emulador externo. Simplemente abre tu archivo `.bas` y:
- Pulsa **F5** para iniciar la depuración.
- O pulsa **Ctrl+F5** (Cmd+F5 en macOS) para ejecutar sin depurar.
- O pulsa los botones de reproducción/depuración en la esquina superior derecha del editor.

### Configuración en `.vscode/launch.json`:

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

---

## 2. Depuración con ZEsarUX (Emulador externo)

### Requisitos previos para ZEsarUX

1. **ZEsarUX instalado**: Necesitas tener ZEsarUX instalado en tu sistema.
   - Linux: `sudo apt install zesarux` o descárgalo desde [ZEsarUX GitHub](https://github.com/chernandezba/zesarux)
   - Windows/macOS: Descarga desde [ZEsarUX GitHub](https://github.com/chernandezba/zesarux)

2. **Configurar la ruta de ZEsarUX** (opcional): Si ZEsarUX no está en tu PATH, puedes configurarlo en el `launch.json`:
   ```json
   "zesaruxPath": "/ruta/a/zesarux"
   ```

### Configuración en `.vscode/launch.json`:

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
            "sourceFile": "src/main.bas",
            "stopOnEntry": true
        }
    ]
}
```

### Parámetros de configuración general

- `program`: Ruta al archivo TAP/TZX a depurar (por defecto: `${workspaceFolder}/dist/main.tap`)
- `zesaruxPath`: Ruta al ejecutable de ZEsarUX (por defecto: `zesarux`)
- `debugPort`: Puerto para el protocolo de depuración remota (por defecto: 10000)
- `stopOnEntry`: Pausar al iniciar (por defecto: true)

## Uso

### 1. Compila tu programa
Usa el comando "Boriel Basic: Compilar Boriel Basic" desde la paleta de comandos (Ctrl+Shift+P).

### 2. Inicia la depuración
- Ve a la vista de depuración (Ctrl+Shift+D)
- Selecciona "Debug con ZEsarUX" de la lista
- Presiona F5 o haz clic en el botón de play verde
- ZEsarUX se iniciará automáticamente y VS Code se conectará al emulador

### 3. Controles de depuración desde VS Code

- **F5**: Continuar ejecución
- **F10**: Paso siguiente (Step Over)
- **F11**: Entrar en función (Step Into)  
- **Shift+F11**: Salir de función (Step Out)
- **F6**: Pausar
- **Shift+F5**: Detener depuración

### 4. Panel de depuración

En el panel izquierdo verás:
- **Variables**: Registros del Z80 (PC, SP, A, etc.)
- **Call Stack**: Pila de llamadas
- **Debug Console**: Salida de ZEsarUX y comandos

## Características

✅ **Control completo desde VS Code**: No necesitas tocar ZEsarUX
✅ **Inicio automático**: ZEsarUX se inicia y conecta automáticamente
✅ **Controles integrados**: Continue, Pause, Step, Step In, Step Out
✅ **Inspección de registros**: Ver el estado del Z80 en tiempo real
✅ **Consola de debug**: Ver la salida de ZEsarUX
✅ **Protocolo remoto**: Comunicación bidireccional con el emulador

## Configuración

### Configuración en settings.json

```json
{
    "borielBasic.zesaruxPath": "zesarux",
    "borielBasic.zesaruxRemoteDebugPort": 10000,
    "borielBasic.mainFile": "main.bas",
    "borielBasic.outputFormat": "tap"
}
```

### Parámetros de configuración

### Parámetros de configuración

- `borielBasic.zesaruxPath`: Ruta al ejecutable de ZEsarUX (por defecto: "zesarux")
- `borielBasic.zesaruxRemoteDebugPort`: Puerto para el protocolo de depuración remota (por defecto: 10000)
- `borielBasic.mainFile`: Archivo principal a compilar (por defecto: "main.bas")
- `borielBasic.outputFormat`: Formato de salida: "tap" o "tzx" (por defecto: "tap")

## Características actuales

✅ **Inicio automático de ZEsarUX** con el archivo TAP/TZX compilado
✅ **Protocolo de depuración remota habilitado** en el puerto configurado
✅ **Carga automática del programa** en el emulador
✅ **Configuración flexible** mediante settings.json

## Funciones de debug en ZEsarUX

Una vez iniciado ZEsarUX con el protocolo de debug, puedes usar su interfaz para:
- Ver y modificar la memoria
- Ver y modificar registros del Z80
- Establecer breakpoints
- Ejecutar paso a paso
- Ver el desensamblado
- Inspeccionar el stack

Accede al menú de debug en ZEsarUX: F5 → Debug

## Protocolo de depuración de ZEsarUX

ZEsarUX se inicia con el protocolo de depuración remota habilitado en el puerto configurado (por defecto 10000). Esto permite la comunicación con herramientas externas.

El protocolo soporta comandos como:
- `run`: Continuar ejecución
- `enter-cpu-step`: Entrar en modo step
- `cpu-step`: Ejecutar una instrucción
- `get-registers`: Obtener valores de registros
- `set-breakpoint`: Establecer un breakpoint

Para más información sobre el protocolo, consulta la [documentación de ZEsarUX](https://github.com/chernandezba/zesarux/blob/master/remote_protocol.txt).

## Solución de problemas

### ZEsarUX no se inicia
- Verifica que ZEsarUX esté instalado y en el PATH
- Comprueba la ruta en la configuración `borielBasic.zesaruxPath`
- Intenta ejecutar `zesarux --version` en la terminal

### No se encuentra el archivo compilado
- Asegúrate de compilar el proyecto antes de depurar
- Verifica que el archivo existe en la carpeta `dist/`
- Comprueba que el nombre del archivo principal coincide con la configuración

### El puerto de debug está en uso
- Cambia el puerto en la configuración `borielBasic.zesaruxRemoteDebugPort`
- Cierra cualquier instancia anterior de ZEsarUX
- Verifica que no haya otro proceso usando el puerto

## Futuras mejoras

- Integración completa con el Debug Adapter Protocol de VS Code
- Breakpoints mapeados desde el código fuente
- Inspección de variables en tiempo real
- Stack trace visual
- Soporte para archivos de mapeo del compilador

## Contribuir

Si encuentras problemas o tienes sugerencias para mejorar el soporte de depuración, por favor abre un issue en [GitHub](https://github.com/rtorralba/boriel-basic-vscode/issues).
