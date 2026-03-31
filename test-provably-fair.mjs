import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSeed, hashSeed, combineSeeds, deriveDeck,
  verifySeed, verifyDeck, createHandFairness, verifyHandProof
} from './provably-fair.mjs';

describe('Provably Fair', () => {

  it('seed generates 64 hex chars', () => {
    const seed = generateSeed();
    assert.equal(seed.length, 64);
    assert.match(seed, /^[0-9a-f]+$/);
  });

  it('hash is deterministic', () => {
    const seed = generateSeed();
    assert.equal(hashSeed(seed), hashSeed(seed));
  });

  it('different seeds produce different hashes', () => {
    assert.notEqual(hashSeed(generateSeed()), hashSeed(generateSeed()));
  });

  it('verifySeed checks commitment', () => {
    const seed = generateSeed();
    const hash = hashSeed(seed);
    assert.ok(verifySeed(seed, hash));
    assert.ok(!verifySeed('wrong', hash));
  });

  it('combinedSeeds is order-independent', () => {
    const s1 = generateSeed(), s2 = generateSeed();
    assert.equal(combineSeeds([s1, s2]), combineSeeds([s2, s1]));
  });

  it('deriveDeck produces valid shuffled deck', () => {
    const deck = deriveDeck('test_seed', 52);
    assert.equal(deck.length, 52);
    assert.equal(new Set(deck).size, 52);
    for (const c of deck) assert.ok(c >= 0 && c < 52);
  });

  it('deriveDeck is deterministic', () => {
    const d1 = deriveDeck('same_seed', 52);
    const d2 = deriveDeck('same_seed', 52);
    assert.deepEqual(d1, d2);
  });

  it('different seeds produce different decks', () => {
    const d1 = deriveDeck('seed_a', 52);
    const d2 = deriveDeck('seed_b', 52);
    assert.notDeepEqual(d1, d2);
  });

  it('verifyDeck confirms correct deck', () => {
    const seeds = [generateSeed(), generateSeed()];
    const combined = combineSeeds(seeds);
    const deck = deriveDeck(combined, 14);
    assert.ok(verifyDeck(seeds, deck, 14));
  });

  it('verifyDeck rejects tampered deck', () => {
    const seeds = [generateSeed(), generateSeed()];
    const combined = combineSeeds(seeds);
    const deck = deriveDeck(combined, 14);
    deck[0] = deck[1]; // Tamper
    assert.ok(!verifyDeck(seeds, deck, 14));
  });
});

describe('Hand Fairness Flow', () => {

  it('full commit-reveal-verify cycle', () => {
    const hf = createHandFairness();

    // Phase 1: Each party commits
    const house = hf.commit('house');
    const p1 = hf.commit('player1');
    const p2 = hf.commit('player2');

    // Commitments are hashes — can be shared publicly
    assert.equal(house.hash.length, 64);
    assert.notEqual(house.hash, p1.hash);

    // Phase 2: Reveal seeds
    assert.ok(hf.reveal('house', house.seed).valid);
    assert.ok(hf.reveal('player1', p1.seed).valid);
    assert.ok(hf.reveal('player2', p2.seed).valid);

    // Wrong seed should fail
    assert.ok(!hf.reveal('house', 'wrong_seed').valid);

    // Phase 3: Derive deck
    const deck = hf.deriveDeckOrder(14);
    assert.equal(deck.length, 14);
    assert.equal(new Set(deck).size, 14);

    // Phase 4: Verify proof
    const proof = hf.getProof();
    const result = verifyHandProof(proof, 14);
    assert.ok(result.valid);
  });

  it('simulate multi-party commitment exchange', () => {
    // House creates fairness for hand
    const houseFair = createHandFairness();
    const houseSeed = houseFair.commit('house');

    // Players create their own fairness trackers
    const p1Fair = createHandFairness();
    const p1Seed = p1Fair.commit('player1');

    const p2Fair = createHandFairness();
    const p2Seed = p2Fair.commit('player2');

    // Exchange commitments (via z-memos in real protocol)
    p1Fair.recordCommitment('house', houseSeed.hash);
    p1Fair.recordCommitment('player2', p2Seed.hash);
    p2Fair.recordCommitment('house', houseSeed.hash);
    p2Fair.recordCommitment('player1', p1Seed.hash);
    houseFair.recordCommitment('player1', p1Seed.hash);
    houseFair.recordCommitment('player2', p2Seed.hash);

    // Reveal seeds
    houseFair.reveal('player1', p1Seed.seed);
    houseFair.reveal('player2', p2Seed.seed);
    p1Fair.reveal('house', houseSeed.seed);
    p1Fair.reveal('player2', p2Seed.seed);
    p2Fair.reveal('house', houseSeed.seed);
    p2Fair.reveal('player1', p1Seed.seed);

    // All three should derive the same deck
    const houseDeck = houseFair.deriveDeckOrder(14);
    const p1Deck = p1Fair.deriveDeckOrder(14);
    const p2Deck = p2Fair.deriveDeckOrder(14);

    assert.deepEqual(houseDeck, p1Deck);
    assert.deepEqual(p1Deck, p2Deck);

    // All proofs should verify
    assert.ok(verifyHandProof(houseFair.getProof(), 14).valid);
    assert.ok(verifyHandProof(p1Fair.getProof(), 14).valid);
  });

  it('cannot change seed after commitment', () => {
    const hf = createHandFairness();
    const real = hf.commit('house');

    // House committed hash of real seed
    // Now tries to reveal a different seed
    const fake = generateSeed();
    const result = hf.reveal('house', fake);
    assert.ok(!result.valid);
  });

  it('100 hands all produce unique decks', () => {
    const decks = new Set();
    for (let i = 0; i < 100; i++) {
      const hf = createHandFairness();
      hf.commit('house');
      hf.commit('player');
      hf.reveal('house', hf.getProof().seeds.house);
      hf.reveal('player', hf.getProof().seeds.player);
      const deck = hf.deriveDeckOrder(14);
      decks.add(deck.join(','));
    }
    assert.equal(decks.size, 100);
  });
});
