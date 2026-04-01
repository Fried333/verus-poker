/**
 * Test WASM poker crypto — verify no duplicate cards
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const createPokerCrypto = require('./poker_crypto.js');
const Module = await createPokerCrypto();

const N = 52;
const B = 32; // bytes per bits256

function alloc(n) { return Module._malloc(n); }

let dupes = 0, fails = 0;
const TRIALS = 50;

for (let trial = 0; trial < TRIALS; trial++) {
  Module._reset_permutations();

  // Player 1
  const p1_privs = alloc(N * B);
  const p1_cards = alloc(N * B);
  const p1_pub = alloc(B);
  Module._deckgen_player(p1_privs, p1_cards, p1_pub, N);

  // Player 2
  const p2_privs = alloc(N * B);
  const p2_cards = alloc(N * B);
  const p2_pub = alloc(B);
  Module._deckgen_player(p2_privs, p2_cards, p2_pub, N);

  // Dealer processes P1
  const d_prods1 = alloc(N * B);
  const d_final1 = alloc(N * B);
  Module._deckgen_vendor(0, d_prods1, d_final1, N, p1_cards);

  // Dealer processes P2
  const d_prods2 = alloc(N * B);
  const d_final2 = alloc(N * B);
  Module._deckgen_vendor(1, d_prods2, d_final2, N, p2_cards);

  // Cashier blinds P1
  const b1_blind = alloc(N * B);
  const b1_enc = alloc(N * B);
  Module._p2p_bvv_init(b1_blind, b1_enc, d_final1, N);

  // Cashier blinds P2
  const b2_blind = alloc(N * B);
  const b2_enc = alloc(N * B);
  Module._p2p_bvv_init(b2_blind, b2_enc, d_final2, N);

  // Decode cards
  const enc = alloc(B);
  const bv = alloc(B);
  const allCards = [];

  // P1 hole cards (pos 0,1)
  for (let pos = 0; pos < 2; pos++) {
    Module.HEAPU8.set(Module.HEAPU8.subarray(b1_enc + pos * B, b1_enc + (pos+1) * B), enc);
    Module.HEAPU8.set(Module.HEAPU8.subarray(b1_blind + pos * B, b1_blind + (pos+1) * B), bv);
    allCards.push(Module._decode_card(enc, bv, p1_privs, d_prods1, N));
  }

  // P2 hole cards (pos 2,3)
  for (let pos = 2; pos < 4; pos++) {
    Module.HEAPU8.set(Module.HEAPU8.subarray(b2_enc + pos * B, b2_enc + (pos+1) * B), enc);
    Module.HEAPU8.set(Module.HEAPU8.subarray(b2_blind + pos * B, b2_blind + (pos+1) * B), bv);
    allCards.push(Module._decode_card(enc, bv, p2_privs, d_prods2, N));
  }

  // Community (pos 4-8 from deck 1)
  for (let pos = 4; pos < 9; pos++) {
    Module.HEAPU8.set(Module.HEAPU8.subarray(b1_enc + pos * B, b1_enc + (pos+1) * B), enc);
    Module.HEAPU8.set(Module.HEAPU8.subarray(b1_blind + pos * B, b1_blind + (pos+1) * B), bv);
    allCards.push(Module._decode_card(enc, bv, p1_privs, d_prods1, N));
  }

  const unique = new Set(allCards);
  const hasBad = allCards.some(c => c < 0 || c > 51);
  if (unique.size !== allCards.length || hasBad) {
    dupes++;
    if (dupes <= 5) console.log('Trial ' + trial + ': ' + allCards.join(',') + (hasBad ? ' [BAD]' : ' [DUPE]'));
  }
  if (allCards.every(c => c === -1)) fails++;

  // Free
  [p1_privs, p1_cards, p1_pub, p2_privs, p2_cards, p2_pub,
   d_prods1, d_final1, d_prods2, d_final2,
   b1_blind, b1_enc, b2_blind, b2_enc, enc, bv].forEach(p => Module._free(p));
}

console.log('\nResults: ' + dupes + '/' + TRIALS + ' dupes, ' + fails + '/' + TRIALS + ' total fails');
if (dupes === 0 && fails === 0) console.log('PASS — WASM crypto works, no duplicates');
else if (fails > 0) console.log('FAIL — decode_card returning -1');
else console.log('FAIL — duplicates found');
