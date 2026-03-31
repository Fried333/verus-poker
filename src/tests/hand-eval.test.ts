import { describe, it, expect } from 'vitest';
import { evaluateHand, compareHands, HandResult } from '../shared/crypto/hand-eval.js';
import { stringToCard, cardToString } from '../shared/types.js';

// Helper: convert card strings to indices
function cards(...strs: string[]): number[] {
  return strs.map(stringToCard);
}

describe('Hand Evaluator', () => {

  describe('Hand Rankings', () => {
    it('should identify a Royal Flush', () => {
      const hand = cards('Ts', 'Js', 'Qs', 'Ks', 'As');
      const result = evaluateHand(hand);
      expect(result.rank).toBe(9);
      expect(result.name).toBe('Royal Flush');
    });

    it('should identify a Straight Flush', () => {
      const hand = cards('5h', '6h', '7h', '8h', '9h');
      const result = evaluateHand(hand);
      expect(result.rank).toBe(8);
      expect(result.name).toBe('Straight Flush');
    });

    it('should identify Four of a Kind', () => {
      const hand = cards('Kc', 'Kd', 'Kh', 'Ks', '3c');
      const result = evaluateHand(hand);
      expect(result.rank).toBe(7);
      expect(result.name).toBe('Four of a Kind');
    });

    it('should identify a Full House', () => {
      const hand = cards('Jc', 'Jd', 'Jh', '7s', '7c');
      const result = evaluateHand(hand);
      expect(result.rank).toBe(6);
      expect(result.name).toBe('Full House');
    });

    it('should identify a Flush', () => {
      const hand = cards('2d', '5d', '8d', 'Td', 'Kd');
      const result = evaluateHand(hand);
      expect(result.rank).toBe(5);
      expect(result.name).toBe('Flush');
    });

    it('should identify a Straight', () => {
      const hand = cards('4c', '5d', '6h', '7s', '8c');
      const result = evaluateHand(hand);
      expect(result.rank).toBe(4);
      expect(result.name).toBe('Straight');
    });

    it('should identify a Wheel (A-2-3-4-5)', () => {
      const hand = cards('Ac', '2d', '3h', '4s', '5c');
      const result = evaluateHand(hand);
      expect(result.rank).toBe(4);
      expect(result.name).toBe('Straight');
    });

    it('should identify Three of a Kind', () => {
      const hand = cards('9c', '9d', '9h', 'Ks', '3c');
      const result = evaluateHand(hand);
      expect(result.rank).toBe(3);
      expect(result.name).toBe('Three of a Kind');
    });

    it('should identify Two Pair', () => {
      const hand = cards('Ac', 'Ad', '8h', '8s', '3c');
      const result = evaluateHand(hand);
      expect(result.rank).toBe(2);
      expect(result.name).toBe('Two Pair');
    });

    it('should identify One Pair', () => {
      const hand = cards('Qc', 'Qd', '8h', '5s', '3c');
      const result = evaluateHand(hand);
      expect(result.rank).toBe(1);
      expect(result.name).toBe('One Pair');
    });

    it('should identify High Card', () => {
      const hand = cards('Ac', 'Td', '8h', '5s', '3c');
      const result = evaluateHand(hand);
      expect(result.rank).toBe(0);
      expect(result.name).toBe('High Card');
    });
  });

  describe('Hand Comparison', () => {
    it('Flush beats Straight', () => {
      const flush = cards('2d', '5d', '8d', 'Td', 'Kd');
      const straight = cards('4c', '5d', '6h', '7s', '8c');
      expect(compareHands(flush, straight)).toBeGreaterThan(0);
    });

    it('Full House beats Flush', () => {
      const fullHouse = cards('Jc', 'Jd', 'Jh', '7s', '7c');
      const flush = cards('2d', '5d', '8d', 'Td', 'Kd');
      expect(compareHands(fullHouse, flush)).toBeGreaterThan(0);
    });

    it('Higher pair beats lower pair', () => {
      const pairKings = cards('Kc', 'Kd', '8h', '5s', '3c');
      const pairQueens = cards('Qc', 'Qd', '8h', '5s', '3c');
      expect(compareHands(pairKings, pairQueens)).toBeGreaterThan(0);
    });

    it('Same pair, higher kicker wins', () => {
      const pairAceKicker = cards('Kc', 'Kd', 'Ah', '5s', '3c');
      const pairQueenKicker = cards('Kc', 'Kd', 'Qh', '5s', '3c');
      expect(compareHands(pairAceKicker, pairQueenKicker)).toBeGreaterThan(0);
    });

    it('Identical hands tie', () => {
      // Same ranks, different suits
      const hand1 = cards('Ac', 'Kd', 'Qh', 'Js', '9c');
      const hand2 = cards('Ad', 'Kc', 'Qd', 'Jh', '9d');
      expect(compareHands(hand1, hand2)).toBe(0);
    });

    it('Royal Flush beats everything', () => {
      const royal = cards('Ts', 'Js', 'Qs', 'Ks', 'As');
      const quads = cards('Ac', 'Ad', 'Ah', 'As', 'Kc');
      expect(compareHands(royal, quads)).toBeGreaterThan(0);
    });
  });

  describe('7-Card Evaluation', () => {
    it('should find best 5 from 7 cards', () => {
      // Has a flush in hearts among the 7 cards
      const hand = cards('2h', '5h', '8h', 'Th', 'Kh', '3c', '9d');
      const result = evaluateHand(hand);
      expect(result.rank).toBe(5); // Flush
    });

    it('should find straight in 7 cards', () => {
      const hand = cards('3c', '4d', '5h', '6s', '7c', 'Jd', 'Ks');
      const result = evaluateHand(hand);
      expect(result.rank).toBe(4); // Straight
    });

    it('should find full house over two pair in 7 cards', () => {
      // Could be two pair (AA, KK) but also full house (AAA, KK) with 3 aces
      const hand = cards('Ac', 'Ad', 'Ah', 'Ks', 'Kc', '3d', '7h');
      const result = evaluateHand(hand);
      expect(result.rank).toBe(6); // Full House
    });

    it('should evaluate a real poker scenario', () => {
      // Player 1: Ah Kh + board
      const board = cards('Qh', 'Jh', 'Th', '3c', '7d');
      const player1 = cards('Ah', 'Kh', ...board.map(cardToString));
      const player2 = cards('As', '2d', ...board.map(cardToString));

      const result1 = evaluateHand(player1);
      const result2 = evaluateHand(player2);

      // Player 1 has Royal Flush in hearts
      expect(result1.rank).toBe(9);
      // Player 2 has a straight (A high)
      expect(result2.rank).toBe(4);
      // Player 1 wins
      expect(result1.score).toBeGreaterThan(result2.score);
    });
  });

  describe('Edge Cases', () => {
    it('should handle the wheel (A-5 straight) correctly in 7 cards', () => {
      const hand = cards('Ac', '2d', '3h', '4s', '5c', 'Kd', 'Qh');
      const result = evaluateHand(hand);
      expect(result.rank).toBe(4); // Straight
    });

    it('should prefer straight flush over flush', () => {
      const hand = cards('5h', '6h', '7h', '8h', '9h', 'Ah', '2h');
      const result = evaluateHand(hand);
      expect(result.rank).toBe(8); // Straight Flush, not just Flush
    });

    it('should handle all same suit (7 hearts)', () => {
      const hand = cards('2h', '4h', '6h', '8h', 'Th', 'Qh', 'Ah');
      const result = evaluateHand(hand);
      expect(result.rank).toBe(5); // Flush (best 5 of 7)
    });
  });
});
