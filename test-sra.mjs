import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateKeyPair, encrypt, decrypt, createDeck, cardFromPlaintext,
  encryptAndShuffle, cryptoShuffle, playerEncryptAndShuffle
} from './mental-poker-sra.mjs';

describe('SRA Basics', () => {

  it('encrypt then decrypt recovers original', () => {
    const key = generateKeyPair();
    const val = 42n;
    assert.equal(decrypt(encrypt(val, key), key), val);
  });

  it('commutative: E_a(E_b(x)) == E_b(E_a(x))', () => {
    const a = generateKeyPair(), b = generateKeyPair();
    const x = 42n;
    assert.equal(encrypt(encrypt(x, a), b), encrypt(encrypt(x, b), a));
  });

  it('decrypt in any order', () => {
    const a = generateKeyPair(), b = generateKeyPair();
    const x = 42n;
    const enc = encrypt(encrypt(x, a), b);
    assert.equal(decrypt(decrypt(enc, a), b), x);
    assert.equal(decrypt(decrypt(enc, b), a), x);
  });

  it('commutative with 3 parties', () => {
    const a = generateKeyPair(), b = generateKeyPair(), c = generateKeyPair();
    const x = 7n;
    const enc = encrypt(encrypt(encrypt(x, a), b), c);
    assert.equal(decrypt(decrypt(decrypt(enc, a), b), c), x);
    assert.equal(decrypt(decrypt(decrypt(enc, c), a), b), x);
    assert.equal(decrypt(decrypt(decrypt(enc, b), c), a), x);
  });

  it('all 52 cards roundtrip', () => {
    const key = generateKeyPair();
    for (let i = 2; i <= 53; i++) {
      assert.equal(decrypt(encrypt(BigInt(i), key), key), BigInt(i));
    }
  });
});

describe('SRA 2-Player Protocol', () => {

  it('full deal: both players encrypt, deal cards, verify', () => {
    const deck = createDeck(52);

    // Player A encrypts + shuffles
    const a = playerEncryptAndShuffle(deck);
    // Player B encrypts + shuffles
    const b = playerEncryptAndShuffle(a.encrypted);

    // Deck is now double-encrypted, double-shuffled
    // Neither player knows the mapping

    // Deal card 0 to Player A:
    // B decrypts their layer → sends to A → A decrypts → sees card
    const bDecrypted = decrypt(b.encrypted[0], b.key);
    const cardA = cardFromPlaintext(decrypt(bDecrypted, a.key));
    assert.ok(cardA >= 0 && cardA < 52);

    // Deal card 1 to Player B:
    // A decrypts their layer → sends to B → B decrypts → sees card
    const aDecrypted = decrypt(b.encrypted[1], a.key);
    const cardB = cardFromPlaintext(decrypt(aDecrypted, b.key));
    assert.ok(cardB >= 0 && cardB < 52);

    // Cards should be different
    assert.notEqual(cardA, cardB);
  });

  it('deal 9 cards — all unique', () => {
    const deck = createDeck(52);
    const a = playerEncryptAndShuffle(deck);
    const b = playerEncryptAndShuffle(a.encrypted);

    const dealt = [];
    for (let i = 0; i < 9; i++) {
      // Both decrypt
      const partial = decrypt(b.encrypted[i], b.key);
      dealt.push(cardFromPlaintext(decrypt(partial, a.key)));
    }

    assert.equal(new Set(dealt).size, 9);
    for (const c of dealt) assert.ok(c >= 0 && c < 52);
  });

  it('neither player can see other cards', () => {
    const deck = createDeck(52);
    const a = playerEncryptAndShuffle(deck);
    const b = playerEncryptAndShuffle(a.encrypted);

    // Player A tries to read card 0 with only their key
    const aOnly = decrypt(b.encrypted[0], a.key);
    // This is still encrypted with B's key — not a valid plaintext
    const val = Number(aOnly);
    assert.ok(val < 2 || val > 53); // Not a valid card plaintext

    // Player B tries to read card 0 with only their key
    const bOnly = decrypt(b.encrypted[0], b.key);
    // Still encrypted with A's key
    const val2 = Number(bOnly);
    assert.ok(val2 < 2 || val2 > 53);
  });
});

describe('SRA 4-Player Protocol', () => {

  it('deck passes through 4 players, all cards recoverable', () => {
    const deck = createDeck(52);
    const keys = [];

    let current = deck;
    for (let i = 0; i < 4; i++) {
      const result = playerEncryptAndShuffle(current);
      keys.push(result.key);
      current = result.encrypted;
    }

    // Reveal card 0: all 4 players decrypt in sequence
    let card = current[0];
    for (const key of keys) card = decrypt(card, key);
    const idx = cardFromPlaintext(card);
    assert.ok(idx >= 0 && idx < 52);
  });
});

// ============================================================
// Performance comparison
// ============================================================
describe('SRA Performance', () => {

  it('keygen time', () => {
    const start = performance.now();
    for (let i = 0; i < 10; i++) generateKeyPair();
    const ms = performance.now() - start;
    console.log(`  10 keypairs: ${ms.toFixed(2)}ms (${(ms/10).toFixed(2)}ms each)`);
  });

  it('single card encrypt', () => {
    const key = generateKeyPair();
    const card = 42n;
    const start = performance.now();
    for (let i = 0; i < 52; i++) encrypt(BigInt(i + 2), key);
    const ms = performance.now() - start;
    console.log(`  52 encryptions: ${ms.toFixed(2)}ms (${(ms/52).toFixed(3)}ms each)`);
  });

  it('single card decrypt', () => {
    const key = generateKeyPair();
    const enc = encrypt(42n, key);
    const start = performance.now();
    for (let i = 0; i < 52; i++) decrypt(enc, key);
    const ms = performance.now() - start;
    console.log(`  52 decryptions: ${ms.toFixed(2)}ms (${(ms/52).toFixed(3)}ms each)`);
  });

  it('full 2-player protocol (52 cards)', () => {
    const start = performance.now();

    const deck = createDeck(52);
    const a = playerEncryptAndShuffle(deck);
    const b = playerEncryptAndShuffle(a.encrypted);

    // Deal 9 cards (2+2 hole + 5 community)
    for (let i = 0; i < 9; i++) {
      const partial = decrypt(b.encrypted[i], b.key);
      decrypt(partial, a.key);
    }

    const ms = performance.now() - start;
    console.log(`  Full 2-player protocol (52 cards, 9 revealed): ${ms.toFixed(2)}ms`);
  });

  it('full 2-player protocol (14 cards)', () => {
    const start = performance.now();

    const deck = createDeck(14);
    const a = playerEncryptAndShuffle(deck);
    const b = playerEncryptAndShuffle(a.encrypted);

    for (let i = 0; i < 9; i++) {
      const partial = decrypt(b.encrypted[i], b.key);
      decrypt(partial, a.key);
    }

    const ms = performance.now() - start;
    console.log(`  Full 2-player protocol (14 cards, 9 revealed): ${ms.toFixed(2)}ms`);
  });
});
