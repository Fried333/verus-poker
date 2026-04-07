#!/usr/bin/env node
// Verify cashier persistence: load a real JSON and check BigInt structure
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

function bnReviver(_key, value) {
  if (value && typeof value === 'object' && typeof value.$bn === 'string') {
    return BigInt('0x' + value.$bn);
  }
  return value;
}

const dir = process.argv[2];
if (!dir) { console.error('usage: verify-persist.mjs <state-dir>'); process.exit(1); }

const files = readdirSync(dir).filter(f => f.endsWith('.json'));
console.log('Files: ' + files.length);

let allOk = true;
for (const f of files) {
  const data = JSON.parse(readFileSync(join(dir, f), 'utf8'), bnReviver);
  const players = data.b ? data.b.length : 0;
  const cardsPerPlayer = data.b && data.b[0] ? data.b[0].length : 0;
  const sample = data.b && data.b[0] && data.b[0][0];
  const sampleType = typeof sample;
  const sampleHex = sampleType === 'bigint' ? sample.toString(16).slice(0, 16) + '...' : String(sample);
  // Check ALL values are BigInt and non-zero
  let nonBigint = 0, zeroes = 0, total = 0;
  for (let i = 0; i < players; i++) {
    for (let j = 0; j < cardsPerPlayer; j++) {
      total++;
      const v = data.b[i][j];
      if (typeof v !== 'bigint') nonBigint++;
      else if (v === 0n) zeroes++;
    }
  }
  const ok = nonBigint === 0 && zeroes < total;
  console.log(`${f}: players=${players} cards=${cardsPerPlayer} sample=${sampleHex} type=${sampleType} nonBigint=${nonBigint}/${total} zeroes=${zeroes}/${total} ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) allOk = false;
}

console.log(allOk ? '\nALL FILES VALID' : '\nFAILURES FOUND');
process.exit(allOk ? 0 : 1);
