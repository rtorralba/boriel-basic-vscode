// Test regex parsing for zxbasm Declaring lines

const testLines = [
    "debug: memory.py:219 Declaring '.__BASLINE_1__' (value 92BBh) in 2",
    "debug: memory.py:219 Declaring '.__BASLINE_2__' (value 92C8h) in 7",
    "debug: memory.py:219 Declaring '.__BASLINE_3__' (value 92D5h) in 11",
    "debug: memory.py:219 Declaring '.__BASLINE_4__' (value 92E2h) in 15",
    "debug: memory.py:219 Declaring '.__BASLINE_5__' (value 92EFh) in 19"
];

const declRe = /Declaring\s+'\.?__BASLINE_(\d+)__'.*\(value\s+([0-9A-Fa-f]+)h?\)/i;

console.log('Testing regex pattern:', declRe);
console.log('');

const results = {};

for (const line of testLines) {
    const match = line.match(declRe);
    if (match) {
        const basNum = parseInt(match[1], 10);
        const hex = match[2];
        const addrDec = parseInt(hex, 16);
        results[basNum] = addrDec;
        console.log(`✓ Line ${basNum}: ${hex}h -> decimal ${addrDec} (0x${addrDec.toString(16).toUpperCase()})`);
    } else {
        console.log(`✗ NO MATCH: ${line}`);
    }
}

console.log('');
console.log('Expected mapping:');
console.log('  BASLINE_1 -> 92BBh (decimal 37563)');
console.log('  BASLINE_2 -> 92C8h (decimal 37576)');
console.log('  BASLINE_3 -> 92D5h (decimal 37589)');
console.log('  BASLINE_4 -> 92E2h (decimal 37602)');
console.log('  BASLINE_5 -> 92EFh (decimal 37615)');

console.log('');
console.log('Actual results:');
for (const [k, v] of Object.entries(results)) {
    console.log(`  BASLINE_${k} -> 0x${v.toString(16).toUpperCase()} (decimal ${v})`);
}

console.log('');
console.log('JSON format (as should be persisted):');
const simple = {};
for (const [k, v] of Object.entries(results)) {
    simple[String(k)] = `${v.toString(16).toUpperCase()}H`;
}
console.log(JSON.stringify(simple, null, 2));
