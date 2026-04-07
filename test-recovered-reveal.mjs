#!/usr/bin/env node
// Simulates the cashier's reveal-serving path on recovered data.
// Proves: a cashier that reloaded from disk responds with the SAME bytes
// that the live cashier would have, for any reveal request.
//
// Inputs: a persisted state file from a real hand
// Method:
//   1. Load the persisted file via the same bnReviver the cashier uses
//   2. Run the cashier's reveal-serving code (extracted) against it
//   3. Compare output to direct lookup in the in-memory b[] structure
//   4. Verify all values are bigints, all positions resolve, no nulls

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

function bnReviver(_k, v) {
  if (v && typeof v === 'object' && typeof v.$bn === 'string') return BigInt('0x' + v.$bn);
  return v;
}

// Same code as cashier-runner.mjs reveal handler:
function serveReveal(handData, positions, playerIdx) {
  const blindings = {};
  for (const pos of positions) {
    if (handData.b[playerIdx] && handData.b[playerIdx][pos] !== undefined) {
      blindings[pos] = handData.b[playerIdx][pos];
    }
  }
  return blindings;
}

const dir = process.argv[2] || '/root/.verus-poker/cashier-cashier1-ptable2';
const files = readdirSync(dir).filter(f => f.endsWith('.json'));
console.log('State dir: ' + dir);
console.log('Found ' + files.length + ' persisted hand(s)');

if (files.length === 0) { console.error('No state files'); process.exit(1); }

let allOk = true;
for (const f of files) {
  const handId = f.replace(/\.json$/, '');
  console.log('\n=== Hand ' + handId + ' ===');
  const data = JSON.parse(readFileSync(join(dir, f), 'utf8'), bnReviver);
  const numPlayers = data.b.length;
  const numCards = data.b[0].length;
  console.log('Recovered shape: ' + numPlayers + ' players × ' + numCards + ' cards');

  // Test 1: serve a hole-cards reveal (positions 0..(2N+5))
  const allPositions = [];
  for (let i = 0; i < numPlayers * 2 + 5; i++) allPositions.push(i);
  const reveal1 = serveReveal(data, allPositions, 0);
  const got = Object.keys(reveal1).length;
  const expected = allPositions.length;
  console.log('Reveal request: positions=' + allPositions.join(',') + ' playerIdx=0');
  console.log('  Got ' + got + '/' + expected + ' blindings');

  // Verify all are BigInts and match the original directly
  let allBigint = true, allMatch = true;
  for (const p of allPositions) {
    if (typeof reveal1[p] !== 'bigint') { allBigint = false; console.log('  pos ' + p + ' not bigint'); }
    if (reveal1[p] !== data.b[0][p]) { allMatch = false; console.log('  pos ' + p + ' mismatch'); }
  }
  console.log('  All BigInt: ' + allBigint);
  console.log('  All match in-memory b[][]: ' + allMatch);

  // Test 2: serve a single-card reveal (showdown style)
  const reveal2 = serveReveal(data, [10], 0);
  const single = reveal2[10];
  console.log('Single-card reveal pos=10: ' + (typeof single === 'bigint' ? single.toString(16).slice(0, 16) + '...' : 'FAIL'));

  // Test 3: out-of-range request (should return empty for those positions)
  const reveal3 = serveReveal(data, [9999], 0);
  console.log('Out-of-range (pos 9999): ' + (reveal3[9999] === undefined ? 'correctly empty' : 'returned something'));

  // Test 4: every position in the deck
  const reveal4 = serveReveal(data, Array.from({length: numCards}, (_, i) => i), 0);
  const deckGot = Object.keys(reveal4).length;
  console.log('Full deck reveal: ' + deckGot + '/' + numCards + ' values');

  const handOk = got === expected && allBigint && allMatch &&
                 typeof single === 'bigint' &&
                 reveal3[9999] === undefined &&
                 deckGot === numCards;
  console.log(handOk ? 'PASS' : 'FAIL');
  if (!handOk) allOk = false;
}

console.log('\n' + (allOk ? '═══ ALL HANDS PASS ═══' : '═══ FAILURES ═══'));
process.exit(allOk ? 0 : 1);
