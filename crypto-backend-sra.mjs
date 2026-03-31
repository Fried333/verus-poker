/**
 * SRA Crypto Backend — plugs into poker-engine
 * 2-party protocol: each player encrypts + shuffles
 * Uses Pohlig-Hellman commutative encryption
 */

import {
  generateKeyPair, encrypt, decrypt, createDeck, cardFromPlaintext,
  encryptAndShuffle, cryptoShuffle
} from './mental-poker-sra.mjs';

/**
 * Create an SRA crypto backend for N players.
 * All players encrypt and shuffle sequentially.
 */
export function createSRABackend(numPlayers) {
  let keys = [];          // Per-player keypairs
  let encryptedDeck = null;

  return {
    name: 'sra',

    async initDeck(numCards) {
      // Create plaintext deck
      let deck = createDeck(numCards);

      // Each player encrypts and shuffles
      keys = [];
      for (let p = 0; p < numPlayers; p++) {
        const key = generateKeyPair();
        keys.push(key);
        deck = encryptAndShuffle(deck, key);
      }

      encryptedDeck = deck;
      return { deck: encryptedDeck, numCards };
    },

    async revealCard(position) {
      if (!encryptedDeck || keys.length === 0) {
        throw new Error('Deck not initialized');
      }
      if (position >= encryptedDeck.length) {
        throw new Error('Card position out of range: ' + position);
      }

      // Decrypt through all layers
      let card = encryptedDeck[position];
      for (const key of keys) {
        card = decrypt(card, key);
      }

      return cardFromPlaintext(card);
    }
  };
}
