/**
 * Texas Hold'em Game State Machine — zero dependencies
 * Handles betting rounds, pot calculation, side pots, turn management.
 * Protocol-agnostic — works with any card crypto backend.
 */

// Actions
export const FOLD = 'fold';
export const CHECK = 'check';
export const CALL = 'call';
export const RAISE = 'raise';
export const ALL_IN = 'allin';

// Game phases
export const WAITING = 'waiting';
export const SHUFFLING = 'shuffling';
export const PREFLOP = 'preflop';
export const FLOP = 'flop';
export const TURN = 'turn';
export const RIVER = 'river';
export const SHOWDOWN = 'showdown';
export const SETTLED = 'settled';

/**
 * Create a new game state
 */
export function createGame(config) {
  return {
    phase: WAITING,
    players: [],          // Array of player objects
    board: [],            // Community cards (0-5)
    pot: 0,
    sidePots: [],
    dealerSeat: 0,
    currentTurn: -1,      // Index into players array
    lastRaiser: -1,
    lastRaise: 0,
    minRaise: config.bigBlind,
    smallBlind: config.smallBlind,
    bigBlind: config.bigBlind,
    rake: config.rake || 0,
    actedThisRound: new Set(),
  };
}

/**
 * Add a player to the game
 */
export function addPlayer(game, id, chips) {
  if (game.phase !== WAITING) throw new Error('Game already started');
  if (game.players.length >= 9) throw new Error('Table full');
  if (game.players.find(p => p.id === id)) throw new Error('Already seated');
  if (chips <= 0) throw new Error('Invalid buy-in');

  game.players.push({
    id,
    chips,
    bet: 0,           // Current bet this round
    totalBet: 0,       // Total bet this hand
    folded: false,
    allIn: false,
    holeCards: [],
    seat: game.players.length,
  });
  return game;
}

/**
 * Start a new hand — post blinds, set up for dealing
 */
export function startHand(game) {
  if (game.players.length < 2) throw new Error('Need at least 2 players');

  // Reset for new hand
  game.phase = SHUFFLING;
  game.board = [];
  game.pot = 0;
  game.sidePots = [];
  game.lastRaiser = -1;
  game.lastRaise = 0;
  game.minRaise = game.bigBlind;
  game.actedThisRound = new Set();

  for (const p of game.players) {
    p.bet = 0;
    p.totalBet = 0;
    p.folded = false;
    p.allIn = false;
    p.holeCards = [];
  }

  // Advance dealer button
  game.dealerSeat = game.dealerSeat % game.players.length;

  return game;
}

/**
 * Post blinds and transition to preflop betting
 */
export function postBlinds(game) {
  const n = game.players.length;
  let sbSeat, bbSeat;

  if (n === 2) {
    // Heads-up: dealer posts small blind, other posts big blind
    sbSeat = game.dealerSeat;
    bbSeat = (game.dealerSeat + 1) % n;
  } else {
    sbSeat = (game.dealerSeat + 1) % n;
    bbSeat = (game.dealerSeat + 2) % n;
  }

  placeBet(game, sbSeat, Math.min(game.smallBlind, game.players[sbSeat].chips));
  placeBet(game, bbSeat, Math.min(game.bigBlind, game.players[bbSeat].chips));

  game.phase = PREFLOP;

  // First to act preflop is left of big blind
  if (n === 2) {
    game.currentTurn = sbSeat; // Heads-up: SB acts first preflop
  } else {
    game.currentTurn = (bbSeat + 1) % n;
  }

  // Skip to first non-folded, non-all-in player
  game.currentTurn = findNextPlayer(game, game.currentTurn);
  game.lastRaiser = bbSeat; // BB is last raiser initially (counts as a raise)
  game.actedThisRound = new Set();

  return game;
}

/**
 * Internal: place a bet for a player
 */
function placeBet(game, seat, amount) {
  const p = game.players[seat];
  const actual = Math.min(amount, p.chips);
  p.chips -= actual;
  p.bet += actual;
  p.totalBet += actual;
  game.pot += actual;
  if (p.chips === 0) p.allIn = true;
  return actual;
}

/**
 * Find next active player (not folded, not all-in) starting from seat
 */
function findNextPlayer(game, fromSeat) {
  const n = game.players.length;
  for (let i = 0; i < n; i++) {
    const seat = (fromSeat + i) % n;
    const p = game.players[seat];
    if (!p.folded && !p.allIn) return seat;
  }
  return -1; // All folded or all-in
}

/**
 * Get the current amount a player needs to call
 */
export function getToCall(game, seat) {
  const maxBet = Math.max(...game.players.map(p => p.bet));
  return maxBet - game.players[seat].bet;
}

/**
 * Get valid actions for current player
 */
export function getValidActions(game) {
  if (game.currentTurn < 0) return [];
  const seat = game.currentTurn;
  const p = game.players[seat];
  const toCall = getToCall(game, seat);
  const actions = [FOLD];

  if (toCall === 0) {
    actions.push(CHECK);
  } else {
    actions.push(CALL);
  }

  // Can raise if has more chips than the call amount
  if (p.chips > toCall) {
    actions.push(RAISE);
    // All-in only makes sense as a distinct option when it differs from call/raise
    actions.push(ALL_IN);
  }

  return actions;
}

/**
 * Process a player action. Returns the updated game state.
 */
export function playerAction(game, seat, action, raiseAmount = 0) {
  if (seat !== game.currentTurn) throw new Error(`Not your turn (expected ${game.currentTurn}, got ${seat})`);
  if (typeof raiseAmount !== 'number' || raiseAmount < 0 || !isFinite(raiseAmount)) raiseAmount = 0;

  const p = game.players[seat];
  const toCall = getToCall(game, seat);

  switch (action) {
    case FOLD:
      p.folded = true;
      break;

    case CHECK:
      if (toCall > 0) throw new Error('Cannot check, must call or fold');
      break;

    case CALL:
      placeBet(game, seat, toCall);
      break;

    case RAISE: {
      if (raiseAmount < game.minRaise && raiseAmount < p.chips) {
        throw new Error(`Raise must be at least ${game.minRaise}`);
      }
      const totalRaise = toCall + raiseAmount;
      if (totalRaise > p.chips) throw new Error('Insufficient chips for raise');
      placeBet(game, seat, totalRaise);
      game.lastRaiser = seat;
      game.lastRaise = raiseAmount;
      game.minRaise = raiseAmount; // Min raise = last raise size
      game.actedThisRound = new Set(); // Reset — everyone needs to act again
      game.actedThisRound.add(seat);
      break;
    }

    case ALL_IN: {
      const amount = p.chips;
      placeBet(game, seat, amount);
      if (amount > toCall) {
        // All-in raise
        game.lastRaiser = seat;
        game.lastRaise = amount - toCall;
        game.actedThisRound = new Set();
      }
      game.actedThisRound.add(seat);
      break;
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }

  if (action !== RAISE && action !== ALL_IN) {
    game.actedThisRound.add(seat);
  }

  // Check if hand is over (only 1 non-folded player)
  const activePlayers = game.players.filter(p => !p.folded);
  if (activePlayers.length === 1) {
    game.phase = SHOWDOWN;
    game.currentTurn = -1;
    return game;
  }

  // If all non-folded players except at most one are all-in, no more betting possible
  const canAct = activePlayers.filter(p => !p.allIn);
  if (canAct.length <= 1 && isRoundComplete(game)) {
    game.phase = SHOWDOWN;
    game.currentTurn = -1;
    return game;
  }

  // Find next player to act
  const nextSeat = findNextPlayer(game, (seat + 1) % game.players.length);

  // Check if betting round is complete
  if (nextSeat === -1 || isRoundComplete(game)) {
    advancePhase(game);
  } else {
    game.currentTurn = nextSeat;
  }

  return game;
}

/**
 * Check if the current betting round is complete
 */
function isRoundComplete(game) {
  const activePlayers = game.players.filter(p => !p.folded && !p.allIn);

  // If all active players have acted and bets are equal, round is complete
  if (activePlayers.length === 0) return true;

  const maxBet = Math.max(...game.players.filter(p => !p.folded).map(p => p.bet));

  for (const p of activePlayers) {
    if (!game.actedThisRound.has(p.seat)) return false;
    if (p.bet < maxBet) return false;
  }

  return true;
}

/**
 * Advance to the next phase
 */
function advancePhase(game) {
  // Reset bets and min raise for new street
  for (const p of game.players) {
    p.bet = 0;
  }
  game.actedThisRound = new Set();
  game.lastRaiser = -1;
  game.minRaise = game.bigBlind; // Reset to BB each street

  switch (game.phase) {
    case PREFLOP:
      game.phase = FLOP;
      break;
    case FLOP:
      game.phase = TURN;
      break;
    case TURN:
      game.phase = RIVER;
      break;
    case RIVER:
      game.phase = SHOWDOWN;
      game.currentTurn = -1;
      return;
  }

  // Set first to act: left of dealer (post-flop)
  const n = game.players.length;
  const firstToAct = (game.dealerSeat + 1) % n;
  game.currentTurn = findNextPlayer(game, firstToAct);

  // If no one can act (all all-in or folded), go straight to showdown
  if (game.currentTurn === -1) {
    game.phase = SHOWDOWN;
  }
}

/**
 * Deal community cards to the board (called by the protocol layer)
 */
export function dealBoard(game, cards) {
  game.board.push(...cards);
  return game;
}

/**
 * Set a player's hole cards (called by the protocol layer)
 */
export function setHoleCards(game, seat, cards) {
  game.players[seat].holeCards = cards;
  return game;
}

/**
 * Calculate side pots for all-in situations
 */
export function calculatePots(game) {
  const contenders = game.players
    .filter(p => !p.folded)
    .map(p => ({ seat: p.seat, totalBet: p.totalBet }))
    .sort((a, b) => a.totalBet - b.totalBet);

  const pots = [];
  let processed = 0;

  for (let i = 0; i < contenders.length; i++) {
    const level = contenders[i].totalBet;
    if (level <= processed) continue;

    const contribution = level - processed;
    let potSize = 0;

    // Everyone who bet at least this level contributes
    for (const p of game.players) {
      if (p.folded) {
        // Folded players contribute what they already put in up to this level
        potSize += Math.min(Math.max(p.totalBet - processed, 0), contribution);
      } else {
        potSize += Math.min(Math.max(p.totalBet - processed, 0), contribution);
      }
    }

    const eligible = contenders
      .filter(c => c.totalBet >= level)
      .map(c => c.seat);

    pots.push({ amount: potSize, eligible });
    processed = level;
  }

  // Sweep any remaining contributions from folded players
  // (e.g., folded player posted BB higher than any contender's all-in)
  if (pots.length > 0) {
    let leftover = 0;
    for (const p of game.players) {
      if (p.folded && p.totalBet > processed) {
        leftover += p.totalBet - processed;
      }
    }
    if (leftover > 0) {
      pots[pots.length - 1].amount += leftover;
    }
  }

  game.sidePots = pots;
  return pots;
}

/**
 * Determine winners and payouts.
 * evaluator: function(cards[]) → score (higher = better)
 */
export function settleHand(game, evaluator) {
  const pots = calculatePots(game);
  const payouts = {};

  // Initialize payouts
  for (const p of game.players) payouts[p.seat] = 0;

  // Check for last-man-standing (everyone else folded)
  const nonFolded = game.players.filter(p => !p.folded);
  if (nonFolded.length === 1) {
    payouts[nonFolded[0].seat] = game.pot;
    applyRake(game, payouts);
    game.phase = SETTLED;
    return payouts;
  }

  // Evaluate hands and award each pot
  for (const pot of pots) {
    let bestScore = -1;
    let winners = [];

    for (const seat of pot.eligible) {
      const p = game.players[seat];
      const hand = [...p.holeCards, ...game.board];
      if (hand.length < 5) continue; // Not enough cards
      const score = evaluator(hand);
      if (score > bestScore) {
        bestScore = score;
        winners = [seat];
      } else if (score === bestScore) {
        winners.push(seat);
      }
    }

    // Split pot among winners
    if (winners.length > 0) {
      const share = Math.floor(pot.amount / winners.length);
      const remainder = pot.amount - share * winners.length;
      for (const seat of winners) {
        payouts[seat] += share;
      }
      // Give remainder to first winner (closest to dealer)
      if (remainder > 0) payouts[winners[0]] += remainder;
    }
  }

  applyRake(game, payouts);
  game.phase = SETTLED;
  return payouts;
}

function applyRake(game, payouts) {
  if (game.rake > 0) {
    const totalPayout = Object.values(payouts).reduce((a, b) => a + b, 0);
    const rakeAmount = Math.floor(totalPayout * game.rake / 100);
    // Deduct rake proportionally from winners
    for (const seat in payouts) {
      if (payouts[seat] > 0) {
        const proportion = payouts[seat] / totalPayout;
        payouts[seat] -= Math.floor(rakeAmount * proportion);
      }
    }
  }
}

/**
 * Apply payouts to player chip stacks
 */
export function applyPayouts(game, payouts) {
  for (const [seat, amount] of Object.entries(payouts)) {
    game.players[Number(seat)].chips += amount;
  }
  return game;
}

/**
 * Get a summary of the current game state (safe to send to players)
 */
export function getGameState(game, forSeat = -1) {
  return {
    phase: game.phase,
    pot: game.pot,
    board: game.board,
    currentTurn: game.currentTurn,
    dealerSeat: game.dealerSeat,
    minRaise: game.minRaise,
    players: game.players.map(p => ({
      id: p.id,
      seat: p.seat,
      chips: p.chips,
      bet: p.bet,
      folded: p.folded,
      allIn: p.allIn,
      // Show hole cards at showdown/settled, otherwise only to owner
      holeCards: (game.phase === SHOWDOWN || game.phase === SETTLED || p.seat === forSeat)
        ? p.holeCards
        : (p.holeCards.length > 0 ? ['??', '??'] : []),
    })),
    validActions: game.currentTurn === forSeat ? getValidActions(game) : [],
    toCall: game.currentTurn === forSeat ? getToCall(game, forSeat) : 0,
  };
}
