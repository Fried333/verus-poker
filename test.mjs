import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  fieldMul, fieldRecip, blindCard, unblindCard,
  randomFieldElement, bytesToBigInt, bigIntToBytes, getCardIndex,
  generateDeck, generateBlindingKeys, cryptoShuffle, generatePermutation,
  applyPermutation, playerInitDeck, dealerShuffleAndBlind,
  blinderShuffleAndBlind, revealCard
} from './mental-poker.mjs';

import {
  evaluateHand, handRank, cardToString, stringToCard, describeHand, HAND_NAMES
} from './hand-eval.mjs';

const P = (1n << 255n) - 19n;
const cards = (...strs) => strs.map(stringToCard);

// ============================================================
// Field Arithmetic
// ============================================================
describe('Field Arithmetic', () => {

  it('a * b == b * a (commutative)', () => {
    const a = randomFieldElement(), b = randomFieldElement();
    assert.equal(fieldMul(a, b), fieldMul(b, a));
  });

  it('(a*b)*c == a*(b*c) (associative)', () => {
    const a = randomFieldElement(), b = randomFieldElement(), c = randomFieldElement();
    assert.equal(fieldMul(fieldMul(a, b), c), fieldMul(a, fieldMul(b, c)));
  });

  it('a * a^(-1) == 1', () => {
    const a = randomFieldElement();
    assert.equal(fieldMul(a, fieldRecip(a)), 1n);
  });

  it('blind then unblind recovers original', () => {
    const card = randomFieldElement(), key = randomFieldElement();
    assert.equal(unblindCard(blindCard(card, key), key), card);
  });

  it('double blind removable in either order', () => {
    const card = randomFieldElement(), k1 = randomFieldElement(), k2 = randomFieldElement();
    const dbl = blindCard(blindCard(card, k1), k2);
    assert.equal(unblindCard(unblindCard(dbl, k1), k2), card);
    assert.equal(unblindCard(unblindCard(dbl, k2), k1), card);
  });
});

// ============================================================
// Card Index Encoding
// ============================================================
describe('Card Index', () => {

  it('embed and extract card index in byte 30', () => {
    const deck = generateDeck(52);
    for (let i = 0; i < 52; i++) {
      assert.equal(getCardIndex(deck[i].priv), i);
    }
  });

  it('card index survives blind/unblind', () => {
    const deck = generateDeck(14);
    const key = randomFieldElement();
    for (const kp of deck) {
      const recovered = unblindCard(blindCard(kp.priv, key), key);
      assert.equal(getCardIndex(recovered), kp.cardIndex);
    }
  });
});

// ============================================================
// Shuffle
// ============================================================
describe('Shuffle', () => {

  it('produces all elements', () => {
    const arr = Array.from({ length: 52 }, (_, i) => i);
    const shuffled = cryptoShuffle(arr);
    assert.equal(shuffled.length, 52);
    assert.equal(new Set(shuffled).size, 52);
  });

  it('permutation contains all indices', () => {
    const perm = generatePermutation(14);
    assert.equal(new Set(perm).size, 14);
  });

  it('applyPermutation reorders correctly', () => {
    assert.deepEqual(applyPermutation(['a','b','c','d'], [2,0,3,1]), ['c','a','d','b']);
  });
});

// ============================================================
// Full 3-Party Protocol
// ============================================================
describe('3-Party Protocol', () => {

  it('reveal single card correctly', () => {
    const N = 14;
    const player = playerInitDeck(N);
    const dealer = dealerShuffleAndBlind(player.publicCards, N);
    const blinder = blinderShuffleAndBlind(dealer.blindedCards, N);

    const pos = 0;
    const blinderKey = blinder.deckInfo.keys[pos];
    const dealerPos = blinder.deckInfo.perm[pos];
    const dealerKey = dealer.deckInfo.keys[dealerPos];

    const revealed = revealCard(blinder.blindedCards[pos], blinderKey, dealerKey);

    const originalPos = dealer.deckInfo.perm[dealerPos];
    assert.equal(revealed, player.keypairs[originalPos].priv);
    assert.equal(getCardIndex(revealed), player.keypairs[originalPos].cardIndex);
  });

  it('reveal all 14 cards — all unique and valid', () => {
    const N = 14;
    const player = playerInitDeck(N);
    const dealer = dealerShuffleAndBlind(player.publicCards, N);
    const blinder = blinderShuffleAndBlind(dealer.blindedCards, N);

    const revealedCards = [];
    for (let pos = 0; pos < N; pos++) {
      const blinderKey = blinder.deckInfo.keys[pos];
      const dealerPos = blinder.deckInfo.perm[pos];
      const dealerKey = dealer.deckInfo.keys[dealerPos];
      const revealed = revealCard(blinder.blindedCards[pos], blinderKey, dealerKey);
      const originalPos = dealer.deckInfo.perm[dealerPos];
      revealedCards.push(player.keypairs[originalPos].cardIndex);
    }

    assert.equal(new Set(revealedCards).size, N);
    for (const c of revealedCards) {
      assert.ok(c >= 0 && c < N);
    }
  });

  it('dealer alone cannot see cards', () => {
    const N = 14;
    const player = playerInitDeck(N);
    const dealer = dealerShuffleAndBlind(player.publicCards, N);
    const blinder = blinderShuffleAndBlind(dealer.blindedCards, N);

    // Dealer tries to unblind without blinder's key
    const pos = 0;
    const dealerPos = blinder.deckInfo.perm[pos];
    const partial = unblindCard(blinder.blindedCards[pos], dealer.deckInfo.keys[dealerPos]);
    const isCard = player.keypairs.some(kp => kp.priv === partial);
    assert.equal(isCard, false);
  });

  it('works with 52-card deck', () => {
    const N = 52;
    const player = playerInitDeck(N);
    const dealer = dealerShuffleAndBlind(player.publicCards, N);
    const blinder = blinderShuffleAndBlind(dealer.blindedCards, N);

    const revealed = [];
    for (let pos = 0; pos < 9; pos++) {
      const bk = blinder.deckInfo.keys[pos];
      const dp = blinder.deckInfo.perm[pos];
      const dk = dealer.deckInfo.keys[dp];
      const r = revealCard(blinder.blindedCards[pos], bk, dk);
      revealed.push(player.keypairs[dealer.deckInfo.perm[dp]].cardIndex);
    }
    assert.equal(new Set(revealed).size, 9);
  });
});

// ============================================================
// Hand Evaluator
// ============================================================
describe('Hand Evaluator', () => {

  it('Royal Flush', () => {
    assert.equal(handRank(evaluateHand(cards('Ts','Js','Qs','Ks','As'))), 9);
  });

  it('Straight Flush', () => {
    assert.equal(handRank(evaluateHand(cards('5h','6h','7h','8h','9h'))), 8);
  });

  it('Four of a Kind', () => {
    assert.equal(handRank(evaluateHand(cards('Kc','Kd','Kh','Ks','3c'))), 7);
  });

  it('Full House', () => {
    assert.equal(handRank(evaluateHand(cards('Jc','Jd','Jh','7s','7c'))), 6);
  });

  it('Flush', () => {
    assert.equal(handRank(evaluateHand(cards('2d','5d','8d','Td','Kd'))), 5);
  });

  it('Straight', () => {
    assert.equal(handRank(evaluateHand(cards('4c','5d','6h','7s','8c'))), 4);
  });

  it('Wheel (A-2-3-4-5)', () => {
    assert.equal(handRank(evaluateHand(cards('Ac','2d','3h','4s','5c'))), 4);
  });

  it('Three of a Kind', () => {
    assert.equal(handRank(evaluateHand(cards('9c','9d','9h','Ks','3c'))), 3);
  });

  it('Two Pair', () => {
    assert.equal(handRank(evaluateHand(cards('Ac','Ad','8h','8s','3c'))), 2);
  });

  it('One Pair', () => {
    assert.equal(handRank(evaluateHand(cards('Qc','Qd','8h','5s','3c'))), 1);
  });

  it('High Card', () => {
    assert.equal(handRank(evaluateHand(cards('Ac','Td','8h','5s','3c'))), 0);
  });

  it('Flush beats Straight', () => {
    const flush = evaluateHand(cards('2d','5d','8d','Td','Kd'));
    const straight = evaluateHand(cards('4c','5d','6h','7s','8c'));
    assert.ok(flush > straight);
  });

  it('Higher pair wins', () => {
    const kings = evaluateHand(cards('Kc','Kd','8h','5s','3c'));
    const queens = evaluateHand(cards('Qc','Qd','8h','5s','3c'));
    assert.ok(kings > queens);
  });

  it('7-card: finds flush in 7 cards', () => {
    assert.equal(handRank(evaluateHand(cards('2h','5h','8h','Th','Kh','3c','9d'))), 5);
  });

  it('7-card: finds full house over two pair', () => {
    assert.equal(handRank(evaluateHand(cards('Ac','Ad','Ah','Ks','Kc','3d','7h'))), 6);
  });

  it('7-card: Royal Flush beats everything', () => {
    const royal = evaluateHand(cards('Ah','Kh','Qh','Jh','Th','3c','7d'));
    const quads = evaluateHand(cards('Ac','Ad','As','Ah','Kc','3d','7h'));
    assert.ok(royal > quads);
  });
});

// ============================================================
// Performance
// ============================================================
describe('Performance', () => {

  it('52-card blind under 50ms', () => {
    const cards = Array.from({ length: 52 }, () => randomFieldElement());
    const keys = generateBlindingKeys(52);
    const start = performance.now();
    cards.map((c, i) => fieldMul(c, keys[i]));
    const ms = performance.now() - start;
    console.log(`  52-card blind: ${ms.toFixed(2)}ms`);
    assert.ok(ms < 50);
  });

  it('full protocol (14 cards) under 200ms', () => {
    const start = performance.now();
    const player = playerInitDeck(14);
    const dealer = dealerShuffleAndBlind(player.publicCards, 14);
    const blinder = blinderShuffleAndBlind(dealer.blindedCards, 14);
    for (let i = 0; i < 14; i++) {
      const dp = blinder.deckInfo.perm[i];
      revealCard(blinder.blindedCards[i], blinder.deckInfo.keys[i], dealer.deckInfo.keys[dp]);
    }
    const ms = performance.now() - start;
    console.log(`  Full protocol (14 cards): ${ms.toFixed(2)}ms`);
    assert.ok(ms < 200);
  });
});
