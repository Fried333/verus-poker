/**
 * Texas Hold'em Hand Evaluator — zero dependencies
 * Evaluates best 5-card hand from 5-7 cards.
 * Returns numeric score (higher = better).
 */

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';

export const cardToString = (c) => RANKS[c % 13] + SUITS[Math.floor(c / 13)];
export const stringToCard = (s) => SUITS.indexOf(s[1]) * 13 + RANKS.indexOf(s[0]);

function evaluate5(cards) {
  const ranks = cards.map(c => c % 13).sort((a, b) => b - a);
  const suits = cards.map(c => Math.floor(c / 13));
  const isFlush = suits.every(s => s === suits[0]);

  let isStraight = false, straightHigh = 0;
  if (ranks[0] - ranks[4] === 4 && new Set(ranks).size === 5) {
    isStraight = true; straightHigh = ranks[0];
  }
  if (ranks[0] === 12 && ranks[1] === 3 && ranks[2] === 2 && ranks[3] === 1 && ranks[4] === 0) {
    isStraight = true; straightHigh = 3;
  }

  if (isStraight && isFlush) return (straightHigh === 12 ? 9 : 8) * 1e10 + straightHigh * 1e5;

  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const pat = groups.map(g => g[1]).join('');

  if (pat.startsWith('41')) return 7e10 + groups[0][0] * 1e5 + groups[1][0];
  if (pat.startsWith('32')) return 6e10 + groups[0][0] * 1e5 + groups[1][0];
  if (isFlush) return 5e10 + ranks[0] * 1e8 + ranks[1] * 1e6 + ranks[2] * 1e4 + ranks[3] * 100 + ranks[4];
  if (isStraight) return 4e10 + straightHigh * 1e5;
  if (pat.startsWith('311')) {
    const k = groups.filter(g => g[1] === 1).map(g => g[0]).sort((a, b) => b - a);
    return 3e10 + groups[0][0] * 1e5 + k[0] * 100 + k[1];
  }
  if (pat.startsWith('221')) {
    const p = groups.filter(g => g[1] === 2).map(g => g[0]).sort((a, b) => b - a);
    return 2e10 + p[0] * 1e6 + p[1] * 1e3 + groups.find(g => g[1] === 1)[0];
  }
  if (pat.startsWith('2111')) {
    const k = groups.filter(g => g[1] === 1).map(g => g[0]).sort((a, b) => b - a);
    return 1e10 + groups[0][0] * 1e6 + k[0] * 1e4 + k[1] * 100 + k[2];
  }
  return ranks[0] * 1e8 + ranks[1] * 1e6 + ranks[2] * 1e4 + ranks[3] * 100 + ranks[4];
}

export function evaluateHand(cards) {
  if (cards.length === 5) return evaluate5(cards);
  let best = -1;
  // Try all 5-card combos by excluding 2 cards
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const hand = cards.filter((_, idx) => idx !== i && idx !== j);
      if (hand.length === 5) {
        const score = evaluate5(hand);
        if (score > best) best = score;
      }
    }
  }
  return best;
}

/** Returns { score, bestCards } — the best 5-card hand from 7 cards */
export function evaluateHandWithCards(cards) {
  if (cards.length === 5) return { score: evaluate5(cards), bestCards: [...cards] };
  let best = -1;
  let bestHand = null;
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const hand = cards.filter((_, idx) => idx !== i && idx !== j);
      if (hand.length === 5) {
        const score = evaluate5(hand);
        if (score > best) { best = score; bestHand = hand; }
      }
    }
  }
  return { score: best, bestCards: bestHand || cards.slice(0, 5) };
}

export function handRank(score) {
  return Math.floor(score / 1e10);
}

export const HAND_NAMES = [
  'High Card', 'One Pair', 'Two Pair', 'Three of a Kind',
  'Straight', 'Flush', 'Full House', 'Four of a Kind',
  'Straight Flush', 'Royal Flush'
];

export function describeHand(cards) {
  const score = evaluateHand(cards);
  return HAND_NAMES[handRank(score)];
}
