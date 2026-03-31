/**
 * Live game test — connects 4 WebSocket clients to the server,
 * plays hands automatically, reports all issues.
 * Zero dependencies — uses Node's built-in WebSocket (Node 22+) or ws package on server.
 *
 * Run locally against server: node test-live-game.mjs
 */

import { WebSocket } from 'ws';

const URL = 'ws://127.0.0.1:3000';
const PLAYERS = ['Alice', 'Bob', 'Charlie', 'Dave'];
const WAIT = ms => new Promise(r => setTimeout(r, ms));

const issues = [];
let handsCompleted = 0;

function issue(msg) { issues.push(msg); console.log('  BUG: ' + msg); }

class PokerClient {
  constructor(name) {
    this.name = name;
    this.seat = -1;
    this.cards = [];
    this.board = [];
    this.chips = 0;
    this.pot = 0;
    this.validPoss = [];
    this.toCall = 0;
    this.activeSeat = -1;
    this.phase = 'waiting';
    this.players = [];
    this.dealerSeat = -1;
    this.messages = [];
    this.resolve = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ action: 'join', name: this.name }));
        resolve();
      });
      this.ws.on('message', data => this.onMessage(JSON.parse(data.toString())));
      this.ws.on('error', reject);
    });
  }

  onMessage(m) {
    this.messages.push(m);
    switch (m.method) {
      case 'info': this.seat = m.playerid; break;
      case 'table_info': this.chips = m.balance || 200; break;
      case 'seats': this.players = m.seats || []; break;
      case 'dealer': this.dealerSeat = m.playerid; break;
      case 'deal':
        if (m.deal.holecards) this.cards = m.deal.holecards;
        if (m.deal.board) this.board = m.deal.board;
        break;
      case 'betting':
        if (m.action === 'round_betting') {
          this.activeSeat = m.playerid;
          this.pot = m.pot || this.pot;
          if (m.playerid === this.seat) {
            this.validPoss = m.possibilities || [];
            this.toCall = m.toCall || 0;
          }
          if (m.player_funds) {
            m.player_funds.forEach((f, i) => { if (this.players[i]) this.players[i].chips = f; });
          }
          // Notify waiting action
          if (m.playerid === this.seat && this.resolve) {
            this.resolve();
            this.resolve = null;
          }
        }
        if (['fold','check','call','raise','allin'].includes(m.action)) {
          this.activeSeat = -1;
          this.validPoss = [];
        }
        break;
      case 'finalInfo':
        this.phase = 'showdown';
        this.board = m.showInfo?.boardCardInfo || this.board;
        break;
    }
  }

  waitForTurn(timeout = 30000) {
    if (this.validPoss.length > 0 && this.activeSeat === this.seat) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.resolve = resolve;
      setTimeout(() => { this.resolve = null; resolve(); }, timeout);
    });
  }

  act(action, amount = 0) {
    const possMap = { fold: 0, check: 1, call: 2, raise: 3, allin: 7 };
    this.ws.send(JSON.stringify({
      method: 'betting',
      possibilities: [possMap[action]],
      bet_amount: amount
    }));
    this.validPoss = [];
  }

  close() { this.ws.close(); }
}

async function runTest() {
  console.log('Connecting 4 players to ' + URL + '...\n');

  const clients = [];
  for (const name of PLAYERS) {
    const c = new PokerClient(name);
    await c.connect();
    clients.push(c);
    console.log('  ' + name + ' connected');
    await WAIT(300);
  }

  await WAIT(3000); // Wait for all joins

  // Verify all seated
  for (const c of clients) {
    if (c.seat < 0) issue(c.name + ' never got a seat');
  }

  // Play 5 hands
  for (let hand = 0; hand < 5; hand++) {
    console.log('\n--- Hand ' + (hand + 1) + ' ---');
    await WAIT(4000); // Wait for deal

    // Check hole cards
    let playersWithCards = 0;
    for (const c of clients) {
      if (c.cards.length === 2) {
        playersWithCards++;
        // Verify cards are valid strings like "Ah", "2c"
        for (const card of c.cards) {
          if (typeof card !== 'string' || card.length < 2) {
            issue('Hand ' + (hand+1) + ': ' + c.name + ' got invalid card: ' + card);
          }
        }
      }
    }
    if (playersWithCards === 0) {
      issue('Hand ' + (hand+1) + ': No player received hole cards');
      await WAIT(8000);
      continue;
    }
    console.log('  ' + playersWithCards + ' players dealt cards');

    // Check no duplicate hole cards
    const allCards = [];
    for (const c of clients) allCards.push(...c.cards);
    if (new Set(allCards).size !== allCards.length) {
      issue('Hand ' + (hand+1) + ': Duplicate hole cards dealt: ' + allCards.join(', '));
    }

    // Play betting rounds
    let actions = 0;
    for (let round = 0; round < 30; round++) {
      let acted = false;
      for (const c of clients) {
        if (c.validPoss.length > 0 && c.activeSeat === c.seat) {
          // Pick action
          const poss = c.validPoss;
          const possMap = { 0: 'fold', 1: 'check', 2: 'call', 3: 'raise', 7: 'allin' };
          const available = poss.map(p => possMap[p]).filter(Boolean);

          // Checks
          if (available.includes('check') && available.includes('call')) {
            issue('Hand ' + (hand+1) + ': ' + c.name + ' has both Check AND Call');
          }
          if (!available.includes('check') && !available.includes('call') && !available.includes('fold')) {
            issue('Hand ' + (hand+1) + ': ' + c.name + ' has no basic action (check/call/fold)');
          }
          if (c.toCall === 0 && available.includes('call') && !available.includes('check')) {
            issue('Hand ' + (hand+1) + ': ' + c.name + ' must Call 0 instead of Check');
          }

          // Smart play
          let action;
          const r = Math.random();
          if (available.includes('check')) {
            action = r < 0.7 ? 'check' : (r < 0.9 ? 'raise' : 'fold');
          } else if (available.includes('call')) {
            action = r < 0.5 ? 'call' : (r < 0.7 ? 'raise' : 'fold');
          } else {
            action = 'fold';
          }
          if (!available.includes(action)) action = available[0];

          console.log('  ' + c.name + ': ' + action + (action === 'call' ? ' ' + c.toCall : ''));
          c.act(action, action === 'raise' ? 4 : 0);
          actions++;
          acted = true;
          await WAIT(500);
          break;
        }
      }
      if (!acted) {
        // Check if hand ended
        const anyShowdown = clients.some(c => c.phase === 'showdown');
        if (anyShowdown) {
          handsCompleted++;
          console.log('  Hand complete (showdown)');
          break;
        }
        // Check if won by folds
        const foldMsgs = clients[0].messages.filter(m => m.method === 'betting' && m.action === 'fold');
        if (foldMsgs.length >= clients.length - 1) {
          handsCompleted++;
          console.log('  Hand complete (folds)');
          break;
        }
        await WAIT(1000);
      }
      if (actions > 25) {
        issue('Hand ' + (hand+1) + ': Too many actions (' + actions + ') — possible infinite loop');
        break;
      }
    }

    // Verify board at showdown
    const c0 = clients[0];
    if (c0.phase === 'showdown') {
      const boardCount = c0.board.filter(c => c && c !== null).length;
      const activePlayers = c0.players.filter(p => p.playing !== 0).length;
      if (activePlayers > 1 && boardCount < 5) {
        issue('Hand ' + (hand+1) + ': Showdown with ' + boardCount + ' board cards (need 5)');
      }
      if (activePlayers <= 1 && boardCount > 0) {
        issue('Hand ' + (hand+1) + ': Board dealt when only 1 player (everyone folded)');
      }
      console.log('  Board: ' + c0.board.filter(Boolean).join(' ') + ' (' + boardCount + ' cards)');
    }

    // Verify chips conserved
    const totalChips = c0.players.reduce((s, p) => s + (p.chips || 0), 0);
    if (totalChips !== 800 && totalChips !== 0) {
      issue('Hand ' + (hand+1) + ': Chips not conserved: ' + totalChips + ' (expected 800)');
    }

    // Check for 0-chip players still in game
    for (const p of c0.players) {
      if (p.chips === 0 && !p.empty && p.playing !== 0) {
        issue('Hand ' + (hand+1) + ': ' + p.name + ' has 0 chips but still playing');
      }
    }

    // Reset for next hand
    for (const c of clients) {
      c.cards = [];
      c.phase = 'waiting';
      c.validPoss = [];
      c.messages = [];
    }

    await WAIT(6000); // Wait for next hand
  }

  // Close
  for (const c of clients) c.close();

  // Report
  console.log('\n' + '='.repeat(50));
  console.log('Hands completed: ' + handsCompleted + '/5');
  console.log('Issues found: ' + issues.length);
  if (issues.length === 0) {
    console.log('  ALL CLEAR - No issues found!');
  } else {
    for (const i of issues) console.log('  ' + i);
  }
  process.exit(issues.length > 0 ? 1 : 0);
}

runTest().catch(e => { console.error(e); process.exit(1); });
