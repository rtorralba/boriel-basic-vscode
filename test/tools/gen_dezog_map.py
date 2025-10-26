#!/usr/bin/env python3
import json
import re
import sys
import os

# Configuración
LINEMAP_PATH = '../dist/main.linemap.json'
ASM_PATH = '../dist/main.asm'
MAP_PATH = '../dist/main.dezog.map'
ORG_ADDR = 32768  # Cambia si tu ORG es diferente

# Cargar linemap
with open(LINEMAP_PATH, 'r') as f:
    linemap = json.load(f)

# Parsear ASM para obtener: {linea_asm: offset desde ORG}
asm_line_to_offset = {}
with open(ASM_PATH, 'r') as f:
    offset = 0
    for idx, line in enumerate(f, 1):
        line = line.strip()
        # Solo contar líneas con código real (no comentarios, directivas, vacías)
        if line and not line.startswith(';') and not line.startswith('#') and not line.startswith('END') and not line.startswith('ASM'):
            asm_line_to_offset[idx] = offset
            # Asume 1 byte por instrucción (puedes mejorar esto si parseas instrucciones)
            offset += 1

# Generar el mapeo Boriel → dirección
with open(MAP_PATH, 'w') as f:
    f.write('; Dezog MAP: Boriel line -> address\n')
    for boriel_line, asm_lines in linemap.items():
        for asm_line in asm_lines:
            addr = ORG_ADDR + asm_line_to_offset.get(asm_line, 0)
            f.write(f'LINE {boriel_line} ${addr:04X}\n')
print(f'Mapeo Dezog generado en {MAP_PATH}')
