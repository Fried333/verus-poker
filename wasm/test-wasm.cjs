const fs = require('fs');
const path = require('path');
const code = fs.readFileSync(path.join(__dirname, 'poker_crypto.js'), 'utf8');
eval(code);
// createPokerCrypto is now in scope

async function main() {
  const Module = await createPokerCrypto();
  console.log('WASM loaded. Functions:', Object.keys(Module).filter(k => k.startsWith('_')).join(', '));

  const N = 52, B = 32;
  let dupes = 0, fails = 0;
  const TRIALS = 50;

  for (let trial = 0; trial < TRIALS; trial++) {
    Module._reset_permutations();

    const p1_privs = Module._malloc(N*B), p1_cards = Module._malloc(N*B), p1_pub = Module._malloc(B);
    Module._deckgen_player(p1_privs, p1_cards, p1_pub, N);

    const p2_privs = Module._malloc(N*B), p2_cards = Module._malloc(N*B), p2_pub = Module._malloc(B);
    Module._deckgen_player(p2_privs, p2_cards, p2_pub, N);

    const d_prods1 = Module._malloc(N*B), d_final1 = Module._malloc(N*B);
    Module._deckgen_vendor(0, d_prods1, d_final1, N, p1_cards);

    const d_prods2 = Module._malloc(N*B), d_final2 = Module._malloc(N*B);
    Module._deckgen_vendor(1, d_prods2, d_final2, N, p2_cards);

    const b1_blind = Module._malloc(N*B), b1_enc = Module._malloc(N*B);
    Module._p2p_bvv_init(b1_blind, b1_enc, d_final1, N);

    const b2_blind = Module._malloc(N*B), b2_enc = Module._malloc(N*B);
    Module._p2p_bvv_init(b2_blind, b2_enc, d_final2, N);

    const enc = Module._malloc(B), bv = Module._malloc(B);
    const allCards = [];

    for (let pos = 0; pos < 2; pos++) {
      Module.HEAPU8.set(Module.HEAPU8.subarray(b1_enc+pos*B, b1_enc+(pos+1)*B), enc);
      Module.HEAPU8.set(Module.HEAPU8.subarray(b1_blind+pos*B, b1_blind+(pos+1)*B), bv);
      allCards.push(Module._decode_card(enc, bv, p1_privs, d_prods1, N));
    }
    for (let pos = 2; pos < 4; pos++) {
      Module.HEAPU8.set(Module.HEAPU8.subarray(b2_enc+pos*B, b2_enc+(pos+1)*B), enc);
      Module.HEAPU8.set(Module.HEAPU8.subarray(b2_blind+pos*B, b2_blind+(pos+1)*B), bv);
      allCards.push(Module._decode_card(enc, bv, p2_privs, d_prods2, N));
    }
    for (let pos = 4; pos < 9; pos++) {
      Module.HEAPU8.set(Module.HEAPU8.subarray(b1_enc+pos*B, b1_enc+(pos+1)*B), enc);
      Module.HEAPU8.set(Module.HEAPU8.subarray(b1_blind+pos*B, b1_blind+(pos+1)*B), bv);
      allCards.push(Module._decode_card(enc, bv, p1_privs, d_prods1, N));
    }

    const unique = new Set(allCards);
    const hasBad = allCards.some(c => c < 0 || c > 51);
    if (unique.size !== allCards.length || hasBad) {
      dupes++;
      if (dupes <= 5) console.log('Trial ' + trial + ': ' + allCards.join(',') + (hasBad ? ' [BAD]' : ' [DUPE]'));
    }
    if (allCards.every(c => c === -1)) fails++;

    [p1_privs,p1_cards,p1_pub,p2_privs,p2_cards,p2_pub,d_prods1,d_final1,d_prods2,d_final2,
     b1_blind,b1_enc,b2_blind,b2_enc,enc,bv].forEach(p => Module._free(p));
  }

  console.log('\n' + dupes + '/' + TRIALS + ' dupes, ' + fails + '/' + TRIALS + ' total fails');
  if (dupes === 0 && fails === 0) console.log('PASS');
  else console.log('FAIL');
}

main().catch(e => { console.error(e); process.exit(1); });
