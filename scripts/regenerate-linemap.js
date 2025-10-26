#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

if (process.argv.length < 4) {
  console.error('Usage: regenerate-linemap.js <zxbasm_output_file> <out_linemap_json>');
  process.exit(2);
}

const inFile = process.argv[2];
const outFile = process.argv[3];

if (!fs.existsSync(inFile)) {
  console.error('Input file not found:', inFile);
  process.exit(2);
}

const content = fs.readFileSync(inFile, 'utf8').split('\n');
// pattern: Declaring '.__BASLINE_1__' (value 92BBh) in 2
const declRe = /Declaring\s+'\.?__BASLINE_(\d+)__'\s+\(value\s+([0-9A-Fa-f]+)h\)/i;
const mapping = {};
for (const l of content) {
  const m = l.match(declRe);
  if (m) {
    const bas = parseInt(m[1], 10);
    const hex = m[2].toUpperCase();
    mapping[String(bas)] = `${hex}H`;
  }
}

if (Object.keys(mapping).length === 0) {
  console.error('No __BASLINE_ declarations found in', inFile);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(mapping, null, 2), 'utf8');
console.log('Wrote linemap with', Object.keys(mapping).length, 'entries to', outFile);
