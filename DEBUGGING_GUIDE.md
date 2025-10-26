# Guía de Depuración con ZEsarUX

## Conceptos Básicos

ZEsarUX tiene dos formas principales de depuración:

1. **Debugger Visual (F11)** - Interfaz gráfica integrada
2. **Remote Protocol** - Control por comandos desde external (lo que usamos en VS Code)

## Método 1: Debugger Visual de ZEsarUX (Recomendado para aprender)

### Paso 1: Lanzar ZEsarUX con tu programa

```bash
zesarux --machine 128k --tape dist/main.tap
```

### Paso 2: Cargar el programa en el Spectrum

Una vez arranque ZEsarUX:
- El Spectrum mostrará la pantalla normal
- Escribe: `LOAD ""`
- Presiona ENTER
- El programa se cargará desde la cinta

### Paso 3: Abrir el Debugger

Presiona **F11** - se abrirá el debugger con varias ventanas:

```
┌─────────────────────────────────────────────┐
│ Registros    │ Memory Dump │ Disassembler  │
│ AF: 1234     │ 8000: 21... │ 8000: LD HL,..│
│ BC: 5678     │ 8001: 00... │ 8003: CALL... │
│ PC: 8000     │ ...         │ ...           │
└─────────────────────────────────────────────┘
```

### Paso 4: Cargar los símbolos del archivo .asm

En el debugger, puedes cargar tu archivo .asm para tener nombres simbólicos:

1. Presiona **F5** en el debugger (abre el menú)
2. Busca "Load source code" o "Load symbols"
3. Selecciona tu archivo `dist/main.asm`

Ahora verás nombres en vez de direcciones:
```
8000: LD HL, myVariable    ; en vez de LD HL, (0x5C00)
8003: CALL myFunction      ; en vez de CALL 0x8100
```

### Paso 5: Establecer Breakpoints

Hay varias formas:

**Por dirección de memoria:**
```
- En el disassembler, mueve el cursor a la línea deseada
- Presiona 'B' para toggle breakpoint
- Verás un símbolo (●) en esa línea
```

**Por símbolo (si cargaste el .asm):**
```
- Presiona F5 → "Set breakpoint"
- Escribe el nombre de la función/etiqueta: "myFunction"
```

**Por condición:**
```
- F5 → "Set conditional breakpoint"
- Ejemplo: "PC=8000H AND A=10"
```

### Paso 6: Ejecutar y Depurar

**Comandos principales:**

- **F5** - Menú de depuración
- **F6** - Step Into (ejecuta una instrucción, entra en CALLs)
- **F7** - Step Over (ejecuta una instrucción, salta CALLs)
- **F8** - Run (ejecuta hasta breakpoint)
- **F9** - Run to cursor (ejecuta hasta la línea del cursor)
- **F10** - View/Edit memory
- **F11** - Toggle debugger on/off

**Inspeccionar memoria:**
- En el memory dump, puedes ver y editar la memoria
- Escribe la dirección que quieres ver
- Presiona Enter para saltar a esa dirección

**Ver registros:**
- Los registros se actualizan en cada step
- Puedes ver valores en decimal, hexadecimal, binario

### Paso 7: Seguir el flujo de tu programa

Con los símbolos cargados, puedes:

1. **Ver qué línea de .asm se está ejecutando**
   - El PC (Program Counter) te indica la dirección actual
   - En el disassembler verás la instrucción con su símbolo

2. **Relacionar con tu código Boriel**
   - Mira los comentarios en el .asm (las directivas #line)
   - Ejemplo: `#line 4 "main.bas"` significa que esa parte del ASM viene de la línea 4 de main.bas

3. **Inspeccionar variables**
   - Las variables Boriel se mapean a direcciones de memoria
   - En el .asm verás etiquetas como `_myVariable` con su dirección
   - Usa F10 para ver esa dirección en memoria

## Método 2: Remote Protocol (lo que usa VS Code)

### Conectar por telnet para probar comandos

```bash
# En terminal 1: Lanzar ZEsarUX
zesarux --machine 128k --tape dist/main.tap \
        --enable-remoteprotocol \
        --remoteprotocol-port 10000

# En terminal 2: Conectar con telnet
telnet localhost 10000
```

### Comandos disponibles

Una vez conectado, puedes enviar comandos:

```
> help                           # Lista todos los comandos
> get-registers                  # Ver registros de CPU
> read-memory 8000 10            # Leer 10 bytes desde 0x8000
> cpu-step                       # Ejecutar una instrucción
> enter-cpu-step                 # Entrar en modo step
> exit-cpu-step                  # Salir de modo step
> run                           # Ejecutar hasta breakpoint
> set-breakpoint 0 8000         # Breakpoint en dirección 0x8000
> disassemble 8000 10           # Desensamblar 10 instrucciones desde 0x8000
```

### Ejemplo de sesión:

```bash
$ telnet localhost 10000
Trying 127.0.0.1...
Connected to localhost.

command> help
Available commands:
about, assemble, clear-membreakpoints, cpu-history, ...

command> get-registers
AF=0044 BC=0000 HL=0000 DE=0000 IX=0000 IY=5C3A SP=FF4C PC=0000
...

command> enter-cpu-step
command> cpu-step
command> get-registers
AF=0044 BC=0000 HL=0000 DE=0000 IX=0000 IY=5C3A SP=FF4C PC=0001
...
```

## Método 3: Combinación (Manual + Remote Protocol)

Lo más útil para desarrollar la extensión:

1. **Lanza ZEsarUX con remote protocol**
2. **Abre el debugger visual (F11)** para ver qué pasa
3. **Envía comandos desde VS Code** (o telnet)
4. **Observa en el debugger** cómo responde ZEsarUX

Esto te permite:
- Ver visualmente qué hacen los comandos
- Entender el estado de la máquina
- Verificar que los breakpoints funcionan
- Confirmar que el mapeo de líneas es correcto

## Flujo típico de depuración

### 1. Preparación (automático en VS Code)
```
- Compilar: main.bas → main.tap + main.asm
- Generar mapeo: main.linemap.json
- Lanzar ZEsarUX con remote protocol
```

### 2. Inicio del programa
```
- ZEsarUX arranca
- Se conecta el debug adapter
- Se envía: enter-cpu-step (para pausar)
- Estado: CPU en pausa, esperando comandos
```

### 3. Usuario establece breakpoint en línea 5 de main.bas
```
- VS Code busca en linemap.json: línea 5 → líneas ASM [120, 121, 122]
- Lee main.asm: línea 120 → dirección 0x8050
- Envía a ZEsarUX: set-breakpoint 0 8050
```

### 4. Usuario presiona "Continue"
```
- VS Code envía: run
- ZEsarUX ejecuta hasta hit breakpoint en 0x8050
- ZEsarUX envía evento de pausa
- VS Code lee PC: get-registers → PC=8050
- Busca 0x8050 en main.asm → línea 120 ASM
- Busca línea 120 en reverse linemap → línea 5 de main.bas
- VS Code muestra cursor en línea 5 de main.bas
```

### 5. Usuario presiona "Step Over"
```
- VS Code envía: cpu-step-over
- Se ejecuta la instrucción actual
- Se lee el nuevo PC
- Se mapea de nuevo a línea de código Boriel
```

## Comandos útiles para implementar en la extensión

### Control de ejecución
```
enter-cpu-step              # Entrar en modo debug (necesario primero)
exit-cpu-step               # Salir de modo debug
run                         # Ejecutar hasta breakpoint
cpu-step                    # Step into (siguiente instrucción)
cpu-step-over               # Step over (salta CALLs)
```

### Breakpoints
```
set-breakpoint NUM ADDRESS           # Establecer breakpoint
enable-breakpoint NUM               # Activar breakpoint
disable-breakpoint NUM              # Desactivar breakpoint
get-breakpoints                     # Listar breakpoints
clear-membreakpoints                # Borrar todos
```

### Inspección
```
get-registers                       # Ver todos los registros
read-memory ADDRESS LENGTH          # Leer memoria
disassemble ADDRESS LENGTH          # Desensamblar código
get-stack-backtrace                # Ver call stack
```

### Para próximos pasos

Una vez entiendas el flujo manual, podemos implementar en VS Code:

1. **BreakpointRequest** - mapear líneas Boriel → direcciones ASM → comandos ZEsarUX
2. **StackTrace** - leer PC, mapear a línea Boriel, mostrar en VS Code
3. **ScopesRequest** - leer variables desde memoria (necesitamos símbolos del .asm)
4. **Continue/Step** - enviar comandos run/cpu-step y actualizar UI

¿Te parece bien empezar probando manualmente con ZEsarUX y telnet para familiarizarte?
