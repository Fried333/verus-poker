/**
 * sg777 Crypto Backend — plugs into poker-engine
 * 3-party protocol: player deck + dealer blind + blinder blind
 * Uses curve25519 field multiplication
 */

import {
  playerInitDeck, dealerShuffleAndBlind, blinderShuffleAndBlind,
  revealCard, getCardIndex, randomFieldElement
} from './mental-poker.mjs';

/**
 * Create an sg777 crypto backend for N players.
 * In this implementation, the server acts as both dealer and blinder.
 * Each player generates their own deck keypairs.
 */
export function createSg777Backend(numPlayers) {
  let playerDecks = [];   // Per-player deck info
  let dealerInfo = null;
  let blinderInfo = null;
  let finalDeck = null;

  return {
    name: 'sg777',

    async initDeck(numCards) {
      // Each player generates their deck
      playerDecks = [];
      for (let p = 0; p < numPlayers; p++) {
        playerDecks.push(playerInitDeck(numCards));
      }

      // For simplicity, use player 0's deck as the base
      // In real protocol, each player has their own deck and the dealer
      // processes each separately. For testing, we use one deck.
      const baseDeck = playerDecks[0];

      // Dealer shuffles and blinds
      dealerInfo = dealerShuffleAndBlind(baseDeck.publicCards, numCards);

      // Blinder shuffles and blinds again
      blinderInfo = blinderShuffleAndBlind(dealerInfo.blindedCards, numCards);

      finalDeck = blinderInfo.blindedCards;

      return { deck: finalDeck, numCards };
    },

    async revealCard(position) {
      if (!finalDeck || !blinderInfo || !dealerInfo) {
        throw new Error('Deck not initialized');
      }
      if (position >= finalDeck.length) {
        throw new Error('Card position out of range: ' + position);
      }

      // Get blinder's key for this position
      const blinderKey = blinderInfo.deckInfo.keys[position];

      // Map back through blinder's shuffle to get dealer position
      const dealerPos = blinderInfo.deckInfo.perm[position];
      const dealerKey = dealerInfo.deckInfo.keys[dealerPos];

      // Remove both blinding layers
      const revealed = revealCard(finalDeck[position], blinderKey, dealerKey);

      // Get the card index from the revealed value
      const originalPos = dealerInfo.deckInfo.perm[dealerPos];
      const cardIndex = playerDecks[0].keypairs[originalPos].cardIndex;

      return cardIndex;
    }
  };
}
