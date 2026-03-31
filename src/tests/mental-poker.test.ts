import { describe, it, expect } from 'vitest';
import {
  fieldMul,
  fieldRecip,
  blindCard,
  unblindCard,
  generateDeck,
  getCardIndex,
  generateBlindingKeys,
  blindDeck,
  cryptoShuffle,
  generatePermutation,
  applyPermutation,
  playerInitDeck,
  dealerShuffleAndBlind,
  blinderShuffleAndBlind,
  revealCard,
  randomFieldElement,
  bytesToBigInt,
  bigIntToBytes,
} from '../shared/crypto/mental-poker.js';

const P = (1n << 255n) - 19n;

describe('Field Arithmetic', () => {

  it('fieldMul should be commutative: a*b == b*a', () => {
    const a = randomFieldElement();
    const b = randomFieldElement();
    expect(fieldMul(a, b)).toBe(fieldMul(b, a));
  });

  it('fieldMul should be associative: (a*b)*c == a*(b*c)', () => {
    const a = randomFieldElement();
    const b = randomFieldElement();
    const c = randomFieldElement();
    expect(fieldMul(fieldMul(a, b), c)).toBe(fieldMul(a, fieldMul(b, c)));
  });

  it('fieldRecip should produce inverse: a * a^(-1) == 1', () => {
    const a = randomFieldElement();
    const inv = fieldRecip(a);
    expect(fieldMul(a, inv)).toBe(1n);
  });

  it('blinding then unblinding should recover original', () => {
    const card = randomFieldElement();
    const key = randomFieldElement();
    const blinded = blindCard(card, key);
    const unblinded = unblindCard(blinded, key);
    expect(unblinded).toBe(card);
  });

  it('double blinding should be removable in any order', () => {
    const card = randomFieldElement();
    const key1 = randomFieldElement();
    const key2 = randomFieldElement();

    const doubleBlinded = blindCard(blindCard(card, key1), key2);

    // Remove key1 first, then key2
    const result1 = unblindCard(unblindCard(doubleBlinded, key1), key2);
    // Remove key2 first, then key1
    const result2 = unblindCard(unblindCard(doubleBlinded, key2), key1);

    expect(result1).toBe(card);
    expect(result2).toBe(card);
  });
});

describe('Byte Conversion', () => {

  it('should roundtrip bigint through bytes', () => {
    const val = randomFieldElement();
    const bytes = bigIntToBytes(val);
    const recovered = bytesToBigInt(bytes);
    // May differ by modular reduction
    expect(recovered % P).toBe(val % P);
  });

  it('should embed and extract card index in byte 30', () => {
    for (let i = 0; i < 52; i++) {
      const val = randomFieldElement();
      const bytes = bigIntToBytes(val);
      bytes[30] = i;
      const withIndex = bytesToBigInt(bytes);
      expect(getCardIndex(withIndex)).toBe(i);
    }
  });
});

describe('Deck Generation', () => {

  it('should generate deck with unique card indices', () => {
    const deck = generateDeck(52);
    expect(deck.length).toBe(52);
    const indices = deck.map(kp => kp.cardIndex);
    expect(new Set(indices).size).toBe(52);
    for (let i = 0; i < 52; i++) {
      expect(indices[i]).toBe(i);
    }
  });

  it('should generate deck with unique private keys', () => {
    const deck = generateDeck(14);
    const privs = deck.map(kp => kp.priv);
    expect(new Set(privs.map(String)).size).toBe(14);
  });

  it('card index should survive field operations', () => {
    const deck = generateDeck(14);
    for (const kp of deck) {
      // Blind and unblind should preserve card index
      const key = randomFieldElement();
      const blinded = blindCard(kp.priv, key);
      const unblinded = unblindCard(blinded, key);
      expect(getCardIndex(unblinded)).toBe(kp.cardIndex);
    }
  });
});

describe('Shuffle', () => {

  it('cryptoShuffle should produce different order', () => {
    const arr = Array.from({ length: 52 }, (_, i) => i);
    const shuffled = cryptoShuffle(arr);
    expect(shuffled.length).toBe(52);
    expect(new Set(shuffled).size).toBe(52);
    // Extremely unlikely to be same order
    expect(shuffled).not.toEqual(arr);
  });

  it('permutation should contain all indices', () => {
    const perm = generatePermutation(14);
    expect(perm.length).toBe(14);
    expect(new Set(perm).size).toBe(14);
    for (let i = 0; i < 14; i++) {
      expect(perm).toContain(i);
    }
  });

  it('applyPermutation should reorder correctly', () => {
    const arr = ['a', 'b', 'c', 'd'];
    const perm = [2, 0, 3, 1]; // c, a, d, b
    const result = applyPermutation(arr, perm);
    expect(result).toEqual(['c', 'a', 'd', 'b']);
  });
});

describe('Full 3-Party Protocol', () => {

  it('should deal and reveal a card correctly (14-card deck)', () => {
    const NUM_CARDS = 14;

    // Step 1: Player initializes deck
    const playerDeck = playerInitDeck(NUM_CARDS);
    expect(playerDeck.keypairs.length).toBe(NUM_CARDS);

    // Step 2: Dealer shuffles and blinds
    const dealerResult = dealerShuffleAndBlind(playerDeck.publicCards, NUM_CARDS);
    expect(dealerResult.blindedCards.length).toBe(NUM_CARDS);

    // Step 3: Blinder shuffles and blinds
    const blinderResult = blinderShuffleAndBlind(dealerResult.blindedCards, NUM_CARDS);
    expect(blinderResult.blindedCards.length).toBe(NUM_CARDS);

    // Step 4: Reveal card at position 0
    const cardPos = 0;
    const blinderKey = blinderResult.deckInfo.blindingKeys[cardPos];
    const dealerKey = dealerResult.deckInfo.blindingKeys[
      blinderResult.deckInfo.permutation[cardPos]  // Map back through blinder's shuffle
    ];

    // Wait - we need to track the mapping properly.
    // After dealer shuffle: card at position i was originally at permutation[i]
    // After blinder shuffle: card at position j was at dealer position blinderPerm[j]
    // So blinder position j → dealer position blinderPerm[j] → original position dealerPerm[blinderPerm[j]]

    // The blinder reveals its key for position cardPos
    // The dealer needs to reveal its key for the dealer position that ended up at blinder position cardPos
    const dealerPos = blinderResult.deckInfo.permutation[cardPos];
    const actualDealerKey = dealerResult.deckInfo.blindingKeys[dealerPos];

    const revealed = revealCard(
      blinderResult.blindedCards[cardPos],
      blinderKey,
      actualDealerKey
    );

    // The revealed value should be one of the player's original card values
    // (after both shuffles, we don't know which card it is until we decode)
    const originalPos = dealerResult.deckInfo.permutation[dealerPos];
    const expectedCard = playerDeck.keypairs[originalPos];

    expect(revealed).toBe(expectedCard.pub);
    expect(getCardIndex(revealed)).toBe(expectedCard.cardIndex);
  });

  it('should reveal all cards correctly', () => {
    const NUM_CARDS = 14;

    const playerDeck = playerInitDeck(NUM_CARDS);
    const dealerResult = dealerShuffleAndBlind(playerDeck.publicCards, NUM_CARDS);
    const blinderResult = blinderShuffleAndBlind(dealerResult.blindedCards, NUM_CARDS);

    const revealedCards: number[] = [];

    for (let pos = 0; pos < NUM_CARDS; pos++) {
      const blinderKey = blinderResult.deckInfo.blindingKeys[pos];
      const dealerPos = blinderResult.deckInfo.permutation[pos];
      const dealerKey = dealerResult.deckInfo.blindingKeys[dealerPos];

      const revealed = revealCard(
        blinderResult.blindedCards[pos],
        blinderKey,
        dealerKey
      );

      const originalPos = dealerResult.deckInfo.permutation[dealerPos];
      const cardIndex = playerDeck.keypairs[originalPos].cardIndex;
      revealedCards.push(cardIndex);

      // Verify the revealed value matches
      expect(revealed).toBe(playerDeck.keypairs[originalPos].pub);
    }

    // All revealed cards should be unique and valid
    expect(revealedCards.length).toBe(NUM_CARDS);
    expect(new Set(revealedCards).size).toBe(NUM_CARDS);
    for (const card of revealedCards) {
      expect(card).toBeGreaterThanOrEqual(0);
      expect(card).toBeLessThan(NUM_CARDS);
    }
  });

  it('neither dealer nor blinder can determine card identity alone', () => {
    const NUM_CARDS = 14;

    const playerDeck = playerInitDeck(NUM_CARDS);
    const dealerResult = dealerShuffleAndBlind(playerDeck.publicCards, NUM_CARDS);
    const blinderResult = blinderShuffleAndBlind(dealerResult.blindedCards, NUM_CARDS);

    // Dealer knows: dealerResult.deckInfo (their keys + permutation)
    // Dealer does NOT know: blinderResult.deckInfo
    // So dealer cannot map final positions to original cards

    // Blinder knows: blinderResult.deckInfo (their keys + permutation)
    // Blinder does NOT know: dealerResult.deckInfo or player's private keys
    // So blinder cannot map final positions to card identities

    // Only with BOTH dealer and blinder keys can you reveal a card
    // (plus the player's original keypairs to decode the index)

    // Verify: with only dealer's key, can't recover original card
    const blinderPos = 0;
    const dealerPos = blinderResult.deckInfo.permutation[blinderPos];
    const partialReveal = unblindCard(
      blinderResult.blindedCards[blinderPos],
      dealerResult.deckInfo.blindingKeys[dealerPos]
    );
    // This is still blinded by the blinder's key — not a valid card
    const isValidCard = playerDeck.keypairs.some(kp => kp.pub === partialReveal);
    expect(isValidCard).toBe(false);
  });

  it('should handle 52-card deck', () => {
    const NUM_CARDS = 52;

    const playerDeck = playerInitDeck(NUM_CARDS);
    const dealerResult = dealerShuffleAndBlind(playerDeck.publicCards, NUM_CARDS);
    const blinderResult = blinderShuffleAndBlind(dealerResult.blindedCards, NUM_CARDS);

    // Reveal first 9 cards (2 hole cards each for 2 players + 5 community)
    const revealedCards: number[] = [];
    for (let pos = 0; pos < 9; pos++) {
      const blinderKey = blinderResult.deckInfo.blindingKeys[pos];
      const dealerPos = blinderResult.deckInfo.permutation[pos];
      const dealerKey = dealerResult.deckInfo.blindingKeys[dealerPos];

      const revealed = revealCard(
        blinderResult.blindedCards[pos],
        blinderKey,
        dealerKey
      );

      const originalPos = dealerResult.deckInfo.permutation[dealerPos];
      revealedCards.push(playerDeck.keypairs[originalPos].cardIndex);
    }

    expect(new Set(revealedCards).size).toBe(9);
    for (const card of revealedCards) {
      expect(card).toBeGreaterThanOrEqual(0);
      expect(card).toBeLessThan(52);
    }
  });
});

describe('Performance', () => {

  it('should blind 52 cards in under 100ms', () => {
    const cards = Array.from({ length: 52 }, () => randomFieldElement());
    const keys = generateBlindingKeys(52);

    const start = performance.now();
    blindDeck(cards, keys);
    const elapsed = performance.now() - start;

    console.log(`52-card blind: ${elapsed.toFixed(2)}ms`);
    expect(elapsed).toBeLessThan(100);
  });

  it('should complete full 3-party protocol in under 500ms', () => {
    const start = performance.now();

    const playerDeck = playerInitDeck(14);
    const dealerResult = dealerShuffleAndBlind(playerDeck.publicCards, 14);
    const blinderResult = blinderShuffleAndBlind(dealerResult.blindedCards, 14);

    // Reveal all cards
    for (let pos = 0; pos < 14; pos++) {
      const blinderKey = blinderResult.deckInfo.blindingKeys[pos];
      const dealerPos = blinderResult.deckInfo.permutation[pos];
      const dealerKey = dealerResult.deckInfo.blindingKeys[dealerPos];
      revealCard(blinderResult.blindedCards[pos], blinderKey, dealerKey);
    }

    const elapsed = performance.now() - start;
    console.log(`Full protocol (14 cards): ${elapsed.toFixed(2)}ms`);
    expect(elapsed).toBeLessThan(500);
  });
});
