#!/usr/bin/env python3
import json
import re
import sys

# Configuración
LINEMAP_PATH = '../dist/main.linemap.json'
LST_PATH = '../dist/main.lst'

# Cargar linemap
with open(LINEMAP_PATH, 'r') as f:
    linemap = json.load(f)

# Parsear .lst para obtener: {linea_asm: direccion}
asm_line_to_addr = {}
pat = re.compile(r'^(\s*)(\d+)(\s+)([0-9A-Fa-f]{4})')
with open(LST_PATH, 'r') as f:
    for line in f:
        m = pat.match(line)
        if m:
            asm_line = int(m.group(2))
            addr = m.group(4)
            asm_line_to_addr[asm_line] = addr

# Mapear Boriel → dirección
boriel_to_addr = {}
for boriel_line, asm_lines in linemap.items():
    addrs = []
    for asm_line in asm_lines:
        addr = asm_line_to_addr.get(asm_line)
        if addr:
            addrs.append(addr)
    if addrs:
        boriel_to_addr[boriel_line] = addrs

# Mostrar resultado
print('Línea Boriel → Direcciones de memoria:')
for boriel_line, addrs in boriel_to_addr.items():
    print(f'Línea {boriel_line}: {", ".join(addrs)}')

# Guardar como JSON
with open('../dist/main.boriel_addr_map.json', 'w') as f:
    json.dump(boriel_to_addr, f, indent=2)
print('\nGuardado en main.boriel_addr_map.json')
