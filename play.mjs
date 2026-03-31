/**
 * Terminal Poker — plays a full game in the terminal with real crypto
 * Usage:
 *   node play.mjs              # Default: SRA, 4 players, 5 hands
 *   node play.mjs --sg         # Use sg777 protocol
 *   node play.mjs --sra        # Use SRA protocol
 *   node play.mjs -n 2         # 2 players
 *   node play.mjs -h 10        # 10 hands
 *   node play.mjs --interactive # Manual play (you control player 1)
 */

import { createEngine, createMockIO } from './poker-engine.mjs';
import { createSg777Backend } from './crypto-backend-sg.mjs';
import { createSRABackend } from './crypto-backend-sra.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import {
  FOLD, CHECK, CALL, RAISE, ALL_IN,
  WAITING, PREFLOP, FLOP, TURN, RIVER, SHOWDOWN, SETTLED
} from './game.mjs';
import * as readline from 'readline';

// Parse args
const args = process.argv.slice(2);
const protocol = args.includes('--sg') ? 'sg777' : 'sra';
const numPlayers = parseInt(args[args.indexOf('-n') + 1]) || 4;
const numHands = parseInt(args[args.indexOf('-h') + 1]) || 5;
const interactive = args.includes('--interactive');

const NAMES = ['You','Alice','Bob','Charlie','Dave','Eve','Frank','Grace','Heidi'].slice(0, numPlayers);
const SUITS = { c: '\x1b[32m♣\x1b[0m', d: '\x1b[34m♦\x1b[0m', h: '\x1b[31m♥\x1b[0m', s: '\x1b[90m♠\x1b[0m' };
const HAND_NAMES = ['High Card','Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush','Royal Flush'];

function colorCard(c) {
  if (typeof c !== 'number') return c;
  const r = '23456789TJQKA'[c % 13];
  const s = ['c','d','h','s'][Math.floor(c / 13)];
  return r + SUITS[s];
}

function clearLine() { process.stdout.write('\x1b[2K\r'); }

// Track revealed cards per player for the TUI
let playerHoles = {};
let board = [];
let pot = 0;
let dealerSeat = 0;

function printTable(game, phase) {
  console.log('\n\x1b[33m' + '═'.repeat(60) + '\x1b[0m');
  console.log('\x1b[33m  VERUS POKER  |  ' + phase.toUpperCase() + '  |  Protocol: ' + protocol.toUpperCase() + '\x1b[0m');
  console.log('\x1b[33m' + '═'.repeat(60) + '\x1b[0m');

  // Board
  const boardStr = board.length > 0
    ? board.map(colorCard).join('  ')
    : '\x1b[90m[     ] [     ] [     ] [     ] [     ]\x1b[0m';
  console.log('\n  Board: ' + boardStr);
  console.log('  Pot:   \x1b[33m' + pot + '\x1b[0m');
  console.log();

  // Players
  for (const p of game.players) {
    const isDealer = p.seat === dealerSeat;
    const n = game.players.length;
    const sb = n === 2 ? dealerSeat : (dealerSeat + 1) % n;
    const bb = n === 2 ? (dealerSeat + 1) % n : (dealerSeat + 2) % n;

    let badges = '';
    if (isDealer) badges += ' \x1b[33m[D]\x1b[0m';
    if (p.seat === sb) badges += ' \x1b[34m[SB]\x1b[0m';
    if (p.seat === bb) badges += ' \x1b[31m[BB]\x1b[0m';

    const status = p.folded ? '\x1b[90mFOLDED\x1b[0m' : (p.allIn ? '\x1b[35mALL-IN\x1b[0m' : '');
    const cards = playerHoles[p.seat]
      ? playerHoles[p.seat].map(colorCard).join(' ')
      : '\x1b[90m[?][?]\x1b[0m';

    console.log('  ' + (p.id.padEnd(10)) + badges +
      '  ' + String(p.chips).padStart(6) + ' chips' +
      '  ' + cards +
      (p.bet > 0 ? '  bet:' + p.bet : '') +
      '  ' + status);
  }
  console.log();
}

async function askAction(validActions, toCall, minRaise) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const actionMap = { f: FOLD, c: CHECK, l: CALL, r: RAISE, a: ALL_IN };

  let prompt = '  Your action: ';
  if (validActions.includes(FOLD)) prompt += '[F]old ';
  if (validActions.includes(CHECK)) prompt += '[C]heck ';
  if (validActions.includes(CALL)) prompt += 'Cal[L] ' + toCall + ' ';
  if (validActions.includes(RAISE)) prompt += '[R]aise (min ' + minRaise + ') ';
  if (validActions.includes(ALL_IN)) prompt += '[A]ll-in ';

  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      const key = answer.trim().toLowerCase()[0];
      if (key === 'r') {
        const amount = parseInt(answer.trim().split(/\s+/)[1]) || minRaise;
        resolve({ action: RAISE, amount });
      } else {
        resolve({ action: actionMap[key] || FOLD });
      }
    });
  });
}

function botAction(validActions, toCall, minRaise = 4) {
  const r = Math.random();
  if (validActions.includes(CHECK)) {
    return r < 0.6 ? { action: CHECK } : (r < 0.85 ? { action: RAISE, amount: minRaise } : { action: FOLD });
  }
  if (validActions.includes(CALL)) {
    return r < 0.45 ? { action: CALL } : (r < 0.65 ? { action: RAISE, amount: Math.max(minRaise, toCall) } : { action: FOLD });
  }
  return { action: FOLD };
}

async function main() {
  console.log('\x1b[36m╔══════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[36m║         VERUS POKER - Terminal           ║\x1b[0m');
  console.log('\x1b[36m║  Protocol: ' + protocol.padEnd(10) + '  Players: ' + numPlayers + '          ║\x1b[0m');
  console.log('\x1b[36m║  Hands: ' + String(numHands).padEnd(13) + (interactive ? 'Interactive' : 'Auto        ') + '  ║\x1b[0m');
  console.log('\x1b[36m╚══════════════════════════════════════════╝\x1b[0m');

  const io = {
    broadcast(event, data) {
      if (event === 'hand_start') {
        dealerSeat = data.dealer;
        playerHoles = {};
        board = [];
      }
      if (event === 'blinds_posted') pot = data.pot || 0;
      if (event === 'community_cards') {
        board = data.board || board;
        pot = data.pot || pot;
        printTable(engine.game, data.phase || 'board');
      }
      if (event === 'turn') pot = data.pot || pot;
      if (event === 'action') {
        pot = data.pot || pot;
        console.log('  \x1b[90m' + data.player + ': ' + data.action + (data.amount ? ' ' + data.amount : '') + '\x1b[0m');
      }
      if (event === 'showdown') {
        board = data.board || board;
        console.log('\n  \x1b[33m*** SHOWDOWN ***\x1b[0m');
        for (const [seat, info] of Object.entries(data.hands || {})) {
          const cards = (info.cards || []).map(colorCard).join(' ');
          const score = evaluateHand([...info.cards, ...board]);
          const rank = Math.floor(score / 1e10);
          const won = data.payouts[seat] > 0;
          console.log('  ' + info.id + ': ' + cards + '  ' + HAND_NAMES[rank] +
            (won ? '  \x1b[32m*** WINS ' + data.payouts[seat] + ' ***\x1b[0m' : ''));
        }
      }
    },
    sendTo(playerId, event, data) {
      if (event === 'hole_cards') {
        const seat = engine.game.players.find(p => p.id === playerId)?.seat;
        if (seat !== undefined) playerHoles[seat] = data.cards;
      }
    },
    async waitForAction(playerId, validActions, timeout) {
      const seat = engine.game.players.find(p => p.id === playerId)?.seat;
      const toCall = engine.game.players[seat]?.bet || 0;
      const maxBet = Math.max(...engine.game.players.map(p => p.bet));
      const callAmt = maxBet - (engine.game.players[seat]?.bet || 0);

      printTable(engine.game, engine.game.phase);

      if (interactive && playerId === NAMES[0]) {
        return askAction(validActions, callAmt, engine.game.minRaise);
      }
      // Bot delay for readability
      await new Promise(r => setTimeout(r, interactive ? 500 : 50));
      return botAction(validActions, callAmt, engine.game.minRaise);
    },
    broadcastState() {},
    log(msg) { if (!msg.includes('===')) console.log('  \x1b[90m' + msg + '\x1b[0m'); }
  };

  const engine = createEngine({ smallBlind: 1, bigBlind: 2, rake: 0 }, io);
  for (const name of NAMES) engine.addPlayer(name, 200);

  // Create crypto backend
  const crypto = protocol === 'sg777'
    ? createSg777Backend(numPlayers)
    : createSRABackend(numPlayers);

  console.log('\n  Crypto: \x1b[36m' + crypto.name + '\x1b[0m');
  console.log('  Players: ' + NAMES.join(', '));

  const issues = [];
  const startChips = engine.game.players.reduce((s, p) => s + p.chips, 0);

  for (let h = 0; h < numHands; h++) {
    console.log('\n\x1b[36m━━━ Hand ' + (h + 1) + '/' + numHands + ' ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');

    const t0 = performance.now();
    await engine.playHand(crypto);
    const elapsed = (performance.now() - t0).toFixed(0);

    // Verify chips conserved
    const total = engine.game.players.reduce((s, p) => s + p.chips, 0);
    if (total !== startChips) {
      issues.push('Hand ' + (h + 1) + ': chips ' + total + ' != ' + startChips);
    }

    // Verify board has 5 cards if showdown with multiple players
    const nonFolded = engine.game.players.filter(p => !p.folded);
    if (nonFolded.length > 1 && engine.game.board.length !== 5) {
      issues.push('Hand ' + (h + 1) + ': board has ' + engine.game.board.length + ' cards at showdown');
    }
    if (nonFolded.length <= 1 && engine.game.board.length > 0) {
      issues.push('Hand ' + (h + 1) + ': board dealt when everyone folded');
    }

    // Verify all dealt cards are unique
    const allCards = [...engine.game.board];
    for (const p of engine.game.players) allCards.push(...p.holeCards);
    if (new Set(allCards).size !== allCards.length) {
      issues.push('Hand ' + (h + 1) + ': duplicate cards');
    }

    // Verify all cards are valid
    for (const c of allCards) {
      if (c < 0 || c >= 52) issues.push('Hand ' + (h + 1) + ': invalid card ' + c);
    }

    console.log('\n  \x1b[90mTime: ' + elapsed + 'ms  Chips: ' +
      engine.game.players.map(p => p.id + ':' + p.chips).join(' ') + '\x1b[0m');

    // Remove busted players for next hand check
    const busted = engine.game.players.filter(p => p.chips <= 0);
    if (busted.length > 0) {
      console.log('  \x1b[31mBusted: ' + busted.map(p => p.id).join(', ') + '\x1b[0m');
    }
  }

  // Final report
  console.log('\n\x1b[36m' + '═'.repeat(60) + '\x1b[0m');
  console.log('\x1b[36m  RESULTS\x1b[0m');
  console.log('\x1b[36m' + '═'.repeat(60) + '\x1b[0m');
  console.log('  Protocol:     ' + protocol);
  console.log('  Players:      ' + numPlayers);
  console.log('  Hands played: ' + numHands);
  console.log('  Chips start:  ' + startChips);
  console.log('  Chips end:    ' + engine.game.players.reduce((s, p) => s + p.chips, 0));
  console.log();
  for (const p of engine.game.players) {
    const diff = p.chips - 200;
    const color = diff > 0 ? '\x1b[32m+' : (diff < 0 ? '\x1b[31m' : '\x1b[90m');
    console.log('  ' + p.id.padEnd(10) + String(p.chips).padStart(6) + ' chips  ' + color + diff + '\x1b[0m');
  }
  console.log();
  console.log('  Issues: ' + issues.length);
  if (issues.length === 0) {
    console.log('  \x1b[32mALL CLEAR — No bugs found!\x1b[0m');
  } else {
    for (const i of issues) console.log('  \x1b[31mBUG: ' + i + '\x1b[0m');
  }
  console.log();
}

main().catch(e => { console.error(e); process.exit(1); });
