/**
 * Texas Hold'em Hand Evaluator
 *
 * Evaluates the best 5-card hand from 7 cards (2 hole + 5 community).
 * Returns a numeric score where higher = better hand.
 *
 * Hand rankings (high to low):
 * 9: Royal Flush
 * 8: Straight Flush
 * 7: Four of a Kind
 * 6: Full House
 * 5: Flush
 * 4: Straight
 * 3: Three of a Kind
 * 2: Two Pair
 * 1: One Pair
 * 0: High Card
 *
 * Score encoding: rank * 10^10 + primary * 10^5 + kicker
 * This ensures any hand of a higher rank always beats a lower rank,
 * with tiebreakers resolved by primary card values and kickers.
 */

import { CardIndex, RANKS } from '../types.js';

export interface HandResult {
  score: number;
  rank: number;        // 0-9
  name: string;        // "Pair", "Flush", etc.
  bestCards: number[]; // The 5 cards making the best hand (indices 0-51)
  description: string; // "Pair of Kings" etc.
}

const HAND_NAMES = [
  'High Card',
  'One Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
  'Royal Flush'
];

/**
 * Get rank (0-12) and suit (0-3) from card index
 */
function cardRank(card: CardIndex): number {
  return card % 13;
}

function cardSuit(card: CardIndex): number {
  return Math.floor(card / 13);
}

function rankName(rank: number): string {
  return RANKS[rank];
}

/**
 * Evaluate a 5-card hand. Returns [handRank, tiebreaker values...]
 */
function evaluate5(cards: CardIndex[]): number {
  const ranks = cards.map(cardRank).sort((a, b) => b - a);
  const suits = cards.map(cardSuit);

  // Check flush
  const isFlush = suits.every(s => s === suits[0]);

  // Check straight
  let isStraight = false;
  let straightHigh = 0;

  // Normal straight check
  if (ranks[0] - ranks[4] === 4 && new Set(ranks).size === 5) {
    isStraight = true;
    straightHigh = ranks[0];
  }
  // Wheel (A-2-3-4-5): ranks sorted desc would be [12, 3, 2, 1, 0]
  if (ranks[0] === 12 && ranks[1] === 3 && ranks[2] === 2 && ranks[3] === 1 && ranks[4] === 0) {
    isStraight = true;
    straightHigh = 3; // 5-high straight
  }

  if (isStraight && isFlush) {
    const rank = straightHigh === 12 ? 9 : 8; // Royal Flush vs Straight Flush
    return rank * 1e10 + straightHigh * 1e5;
  }

  // Count rank occurrences
  const counts: Map<number, number> = new Map();
  for (const r of ranks) {
    counts.set(r, (counts.get(r) || 0) + 1);
  }

  const groups = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]); // Sort by count desc, then rank desc

  const pattern = groups.map(g => g[1]).join('');

  // Four of a kind
  if (pattern.startsWith('41')) {
    return 7 * 1e10 + groups[0][0] * 1e5 + groups[1][0];
  }

  // Full house
  if (pattern.startsWith('32')) {
    return 6 * 1e10 + groups[0][0] * 1e5 + groups[1][0];
  }

  // Flush
  if (isFlush) {
    return 5 * 1e10 + ranks[0] * 1e8 + ranks[1] * 1e6 + ranks[2] * 1e4 + ranks[3] * 100 + ranks[4];
  }

  // Straight
  if (isStraight) {
    return 4 * 1e10 + straightHigh * 1e5;
  }

  // Three of a kind
  if (pattern.startsWith('311')) {
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]).sort((a, b) => b - a);
    return 3 * 1e10 + groups[0][0] * 1e5 + kickers[0] * 100 + kickers[1];
  }

  // Two pair
  if (pattern.startsWith('221')) {
    const pairs = groups.filter(g => g[1] === 2).map(g => g[0]).sort((a, b) => b - a);
    const kicker = groups.find(g => g[1] === 1)![0];
    return 2 * 1e10 + pairs[0] * 1e6 + pairs[1] * 1e3 + kicker;
  }

  // One pair
  if (pattern.startsWith('2111')) {
    const pairRank = groups[0][0];
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]).sort((a, b) => b - a);
    return 1 * 1e10 + pairRank * 1e6 + kickers[0] * 1e4 + kickers[1] * 100 + kickers[2];
  }

  // High card
  return ranks[0] * 1e8 + ranks[1] * 1e6 + ranks[2] * 1e4 + ranks[3] * 100 + ranks[4];
}

/**
 * Get all 21 combinations of 5 cards from 7
 */
function combinations5of7(cards: CardIndex[]): CardIndex[][] {
  const result: CardIndex[][] = [];
  for (let i = 0; i < 7; i++) {
    for (let j = i + 1; j < 7; j++) {
      // Exclude cards i and j
      const hand = cards.filter((_, idx) => idx !== i && idx !== j);
      result.push(hand);
    }
  }
  return result;
}

/**
 * Evaluate the best 5-card hand from 7 cards.
 */
export function evaluateHand(cards: CardIndex[]): HandResult {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`Expected 5-7 cards, got ${cards.length}`);
  }

  if (cards.length === 5) {
    const score = evaluate5(cards);
    const rank = Math.floor(score / 1e10);
    return {
      score,
      rank,
      name: HAND_NAMES[rank],
      bestCards: cards,
      description: HAND_NAMES[rank]
    };
  }

  // For 6 or 7 cards, try all 5-card combinations
  const combos = cards.length === 7
    ? combinations5of7(cards)
    : combinations5of6(cards);

  let bestScore = -1;
  let bestCards = combos[0];

  for (const combo of combos) {
    const score = evaluate5(combo);
    if (score > bestScore) {
      bestScore = score;
      bestCards = combo;
    }
  }

  const rank = Math.floor(bestScore / 1e10);
  return {
    score: bestScore,
    rank,
    name: HAND_NAMES[rank],
    bestCards,
    description: describeHand(rank, bestCards)
  };
}

function combinations5of6(cards: CardIndex[]): CardIndex[][] {
  const result: CardIndex[][] = [];
  for (let i = 0; i < 6; i++) {
    result.push(cards.filter((_, idx) => idx !== i));
  }
  return result;
}

function describeHand(rank: number, cards: CardIndex[]): string {
  const ranks = cards.map(cardRank).sort((a, b) => b - a);
  const counts: Map<number, number> = new Map();
  for (const r of ranks) {
    counts.set(r, (counts.get(r) || 0) + 1);
  }
  const groups = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  switch (rank) {
    case 9: return 'Royal Flush';
    case 8: return `Straight Flush, ${rankName(ranks[0])} high`;
    case 7: return `Four of a Kind, ${rankName(groups[0][0])}s`;
    case 6: return `Full House, ${rankName(groups[0][0])}s full of ${rankName(groups[1][0])}s`;
    case 5: return `Flush, ${rankName(ranks[0])} high`;
    case 4: return `Straight, ${rankName(ranks[0])} high`;
    case 3: return `Three of a Kind, ${rankName(groups[0][0])}s`;
    case 2: {
      const pairs = groups.filter(g => g[1] === 2).map(g => g[0]).sort((a, b) => b - a);
      return `Two Pair, ${rankName(pairs[0])}s and ${rankName(pairs[1])}s`;
    }
    case 1: return `Pair of ${rankName(groups[0][0])}s`;
    default: return `${rankName(ranks[0])} high`;
  }
}

/**
 * Compare two hands. Returns positive if hand1 wins, negative if hand2 wins, 0 for tie.
 */
export function compareHands(hand1: CardIndex[], hand2: CardIndex[]): number {
  return evaluateHand(hand1).score - evaluateHand(hand2).score;
}
