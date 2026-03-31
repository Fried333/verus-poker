/**
 * Provably Fair — seed commitment, reveal, and verification
 * Combined with the mental poker protocol for double-proof fairness.
 */

import { createHash, randomBytes } from 'crypto';

/**
 * Generate a random seed
 */
export function generateSeed() {
  return randomBytes(32).toString('hex');
}

/**
 * Hash a seed (for commitment)
 */
export function hashSeed(seed) {
  return createHash('sha256').update(seed).digest('hex');
}

/**
 * Combine multiple seeds into a single deterministic value
 */
export function combineSeeds(seeds) {
  const combined = seeds.sort().join(':');
  return createHash('sha256').update(combined).digest('hex');
}

/**
 * Derive a deterministic deck order from a combined seed
 * Returns an array of card indices 0-51 in shuffled order
 */
export function deriveDeck(combinedSeed, numCards = 52) {
  const deck = Array.from({ length: numCards }, (_, i) => i);

  // Fisher-Yates shuffle using seed-derived randomness
  let hashState = combinedSeed;
  for (let i = deck.length - 1; i > 0; i--) {
    hashState = createHash('sha256').update(hashState).digest('hex');
    const rand = parseInt(hashState.substring(0, 8), 16);
    const j = rand % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

/**
 * Verify a seed matches its commitment
 */
export function verifySeed(seed, commitment) {
  return hashSeed(seed) === commitment;
}

/**
 * Verify a deck order matches the combined seeds
 */
export function verifyDeck(seeds, expectedDeck, numCards = 52) {
  const combined = combineSeeds(seeds);
  const derived = deriveDeck(combined, numCards);
  if (derived.length !== expectedDeck.length) return false;
  for (let i = 0; i < derived.length; i++) {
    if (derived[i] !== expectedDeck[i]) return false;
  }
  return true;
}

/**
 * Create a provably fair hand manager
 */
export function createHandFairness() {
  const commitments = new Map(); // playerId → hash
  const seeds = new Map();       // playerId → seed
  let deckOrder = null;
  let combinedSeed = null;

  return {
    /**
     * Phase 1: Generate and commit a seed (each party calls this)
     */
    commit(playerId) {
      const seed = generateSeed();
      const hash = hashSeed(seed);
      commitments.set(playerId, hash);
      seeds.set(playerId, seed);
      return { hash, seed }; // Seed kept private, hash shared
    },

    /**
     * Get commitment hash for a player (to send to others)
     */
    getCommitment(playerId) {
      return commitments.get(playerId);
    },

    /**
     * Phase 2: Record someone else's commitment (received from them)
     */
    recordCommitment(playerId, hash) {
      commitments.set(playerId, hash);
    },

    /**
     * Phase 3: Reveal seed and verify against commitment
     */
    reveal(playerId, seed) {
      const expectedHash = commitments.get(playerId);
      if (!expectedHash) return { valid: false, error: 'No commitment found' };
      if (hashSeed(seed) !== expectedHash) return { valid: false, error: 'Seed does not match commitment' };
      seeds.set(playerId, seed);
      return { valid: true };
    },

    /**
     * Phase 4: Derive deck once all seeds revealed
     */
    deriveDeckOrder(numCards = 52) {
      const allSeeds = [...seeds.values()];
      if (allSeeds.length !== commitments.size) {
        return null; // Not all seeds revealed yet
      }
      combinedSeed = combineSeeds(allSeeds);
      deckOrder = deriveDeck(combinedSeed, numCards);
      return deckOrder;
    },

    /**
     * Get the card at a position in the fair deck
     */
    getCard(position) {
      if (!deckOrder) return null;
      return deckOrder[position];
    },

    /**
     * Get all data needed for verification
     */
    getProof() {
      return {
        commitments: Object.fromEntries(commitments),
        seeds: Object.fromEntries(seeds),
        combinedSeed,
        deckOrder
      };
    },

  };
}

// Static method workaround for ES modules
export function verifyHandProof(proof, numCards = 52) {
  for (const [id, seed] of Object.entries(proof.seeds)) {
    if (hashSeed(seed) !== proof.commitments[id]) {
      return { valid: false, error: 'Seed mismatch for ' + id };
    }
  }
  const expectedCombined = combineSeeds(Object.values(proof.seeds));
  if (expectedCombined !== proof.combinedSeed) {
    return { valid: false, error: 'Combined seed mismatch' };
  }
  const expectedDeck = deriveDeck(expectedCombined, numCards);
  for (let i = 0; i < expectedDeck.length; i++) {
    if (expectedDeck[i] !== proof.deckOrder[i]) {
      return { valid: false, error: 'Deck mismatch at position ' + i };
    }
  }
  return { valid: true };
}
