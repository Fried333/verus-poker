// Card representation: 0-51
// suit = Math.floor(card / 13): 0=clubs, 1=diamonds, 2=hearts, 3=spades
// rank = card % 13: 0=2, 1=3, ..., 8=T, 9=J, 10=Q, 11=K, 12=A
export type CardIndex = number; // 0-51

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export const SUITS = ['c', 'd', 'h', 's'] as const;
export const DECK_SIZE = 52;

export function cardToString(card: CardIndex): string {
  return RANKS[card % 13] + SUITS[Math.floor(card / 13)];
}

export function stringToCard(s: string): CardIndex {
  const rank = RANKS.indexOf(s[0] as any);
  const suit = SUITS.indexOf(s[1] as any);
  if (rank === -1 || suit === -1) throw new Error(`Invalid card string: ${s}`);
  return suit * 13 + rank;
}

// Game states
export enum GameState {
  WAITING_FOR_PLAYERS = 'waiting',
  SHUFFLING = 'shuffling',
  DEALING = 'dealing',
  PREFLOP = 'preflop',
  FLOP = 'flop',
  FLOP_BETTING = 'flop_betting',
  TURN = 'turn',
  TURN_BETTING = 'turn_betting',
  RIVER = 'river',
  RIVER_BETTING = 'river_betting',
  SHOWDOWN = 'showdown',
  SETTLEMENT = 'settlement',
}

// Player actions
export enum Action {
  FOLD = 'fold',
  CHECK = 'check',
  CALL = 'call',
  RAISE = 'raise',
  ALL_IN = 'allin',
  SMALL_BLIND = 'small_blind',
  BIG_BLIND = 'big_blind',
}

export interface PlayerState {
  id: string;           // VerusID or session ID
  seat: number;         // 0-8
  chips: number;        // Current stack
  bet: number;          // Current bet this round
  totalBet: number;     // Total bet this hand
  folded: boolean;
  allIn: boolean;
  connected: boolean;
  holeCards: CardIndex[];  // Only visible to this player
}

export interface TableConfig {
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
  minBuyin: number;
  maxBuyin: number;
  rakePercent: number;
}

export interface GameSnapshot {
  state: GameState;
  players: PlayerState[];
  board: CardIndex[];
  pot: number;
  sidePots: { amount: number; eligible: number[] }[];
  dealerSeat: number;
  currentPlayer: number;  // seat index of who acts next
  minRaise: number;
  toCall: number;
}
