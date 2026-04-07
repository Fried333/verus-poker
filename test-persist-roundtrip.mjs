#!/usr/bin/env node
// Unit test: prove BigInt persist→reload produces byte-identical b[] values
import { cashierShuffle } from './protocol.mjs';
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';

function bnReplacer(_k, v) {
  if (typeof v === 'bigint') return { $bn: v.toString(16) };
  return v;
}
function bnReviver(_k, v) {
  if (v && typeof v === 'object' && typeof v.$bn === 'string') return BigInt('0x' + v.$bn);
  return v;
}

// Build fake input decks: 2 players × 52 cards of random BigInts
function randBig() {
  let h = '';
  for (let i = 0; i < 64; i++) h += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  return BigInt('0x' + h);
}
const numPlayers = 2;
const numCards = 52;
const blindedDecks = [];
for (let p = 0; p < numPlayers; p++) {
  const deck = [];
  for (let c = 0; c < numCards; c++) deck.push(randBig());
  blindedDecks.push(deck);
}

console.log('Running cashierShuffle...');
const cd = cashierShuffle(blindedDecks, numPlayers, numCards, 2);
console.log('Got b[' + cd.b.length + '][' + cd.b[0].length + ']');
console.log('First b: ' + cd.b[0][0].toString(16).slice(0, 20) + '...');

// Persist
const handState = { b: cd.b, sigma: cd.sigma_Cashier };
const tmpFile = '/tmp/persist-test.json';
writeFileSync(tmpFile, JSON.stringify(handState, bnReplacer));
console.log('Persisted to ' + tmpFile);

// Reload
const reloaded = JSON.parse(readFileSync(tmpFile, 'utf8'), bnReviver);
console.log('Reloaded');

// Compare element-by-element
let total = 0, mismatch = 0;
for (let i = 0; i < numPlayers; i++) {
  for (let j = 0; j < numCards; j++) {
    total++;
    const orig = cd.b[i][j];
    const rec = reloaded.b[i][j];
    if (typeof rec !== 'bigint') { mismatch++; continue; }
    if (orig !== rec) {
      mismatch++;
      if (mismatch < 3) console.log('  MISMATCH [' + i + '][' + j + ']: orig=' + orig.toString(16) + ' rec=' + rec.toString(16));
    }
  }
}

// Compare sigma
const sigmaOk = JSON.stringify(cd.sigma_Cashier) === JSON.stringify(reloaded.sigma);

console.log('\nResults:');
console.log('  b values: ' + (total - mismatch) + '/' + total + ' identical');
console.log('  sigma: ' + (sigmaOk ? 'identical' : 'DIFFERENT'));

unlinkSync(tmpFile);
const ok = mismatch === 0 && sigmaOk;
console.log('\n' + (ok ? 'PASS — round-trip is byte-identical' : 'FAIL'));
process.exit(ok ? 0 : 1);
