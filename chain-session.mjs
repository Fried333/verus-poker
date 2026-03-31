/**
 * Chain Session Poker — multi-hand sessions with on-chain buy-in/cash-out
 *
 * Buy-in once → play many hands → cash out when leaving
 *
 * Usage: node chain-session.mjs
 */

import { createClient, VDXF_KEYS } from './verus-rpc.mjs';
import { createSession, ACTIVE, SITTING_OUT, CASHING_OUT, CASHED_OUT } from './session.mjs';
import { createEngine } from './poker-engine.mjs';
import { createSRABackend } from './crypto-backend-sra.mjs';
import { createSg777Backend } from './crypto-backend-sg.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import { FOLD, CHECK, CALL, RAISE, ALL_IN, SHOWDOWN, SETTLED } from './game.mjs';

// Config
const RPC = {
  host: '127.0.0.1', port: 22778,
  user: 'user918810440',
  pass: 'passfde4eac81e50dd465529238848a8a77b32c8d17ebb4345c8ebe4150ca3aa9374d1'
};

const TABLE = { smallBlind: 0.01, bigBlind: 0.02, rake: 0 };
const BUYIN = 0.5; // CHIPS per player
const HANDS_TO_PLAY = 5;
const PROTOCOL = process.argv.includes('--sg') ? 'sg777' : 'sra';

const HOUSE_ID = 'poker-dealer.CHIPS@';
const PLAYERS = [
  { id: 'poker-p1', fullId: 'poker-p1.CHIPS@' },
  { id: 'poker-p2', fullId: 'poker-p2.CHIPS@' }
];

const client = createClient(RPC);
const SUITS = { c: '♣', d: '♦', h: '♥', s: '♠' };
function dc(c) { return typeof c === 'number' ? '23456789TJQKA'[c % 13] + SUITS['cdhs'[~~(c / 13)]] : c; }

async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║  VERUS POKER — Session Mode (' + PROTOCOL + ')');
  console.log('╚════════════════════════════════════════════╝');

  // 1. Connect and verify
  console.log('\n[1] Connecting...');
  const info = await client.getInfo();
  console.log('    CHIPS block ' + info.blocks);

  const houseIdentity = await client.getIdentity(HOUSE_ID);
  const houseAddr = houseIdentity.identity.primaryaddresses[0];
  console.log('    House: ' + HOUSE_ID + ' → ' + houseAddr);

  // 2. Create session
  console.log('\n[2] Creating session...');
  const session = createSession(RPC, HOUSE_ID, houseAddr);

  // 3. Buy-in for each player
  console.log('\n[3] Player buy-ins (' + BUYIN + ' CHIPS each)...');
  for (const p of PLAYERS) {
    const identity = await client.getIdentity(p.fullId);
    const addr = identity.identity.primaryaddresses[0];
    const bal = await client.call('z_getbalance', [addr]);
    console.log('    ' + p.id + ': ' + addr + ' (balance: ' + bal + ')');

    if (bal < BUYIN) {
      console.log('    Insufficient funds! Need ' + BUYIN + ', have ' + bal);
      console.log('    Funding from house...');
      const opid = await client.sendCurrency(houseAddr, [{ address: addr, amount: BUYIN }]);
      await client.waitForOperation(opid, 30000);
      console.log('    Funded. Waiting for confirmation...');
      await new Promise(r => setTimeout(r, 12000));
    }

    // Send buy-in from player to house
    console.log('    ' + p.id + ' sending ' + BUYIN + ' to house...');
    const opid = await client.sendCurrency(addr, [{ address: houseAddr, amount: BUYIN }]);
    const result = await client.waitForOperation(opid, 30000);
    console.log('    Buy-in TX: ' + result.txid);

    // Register in session (use direct for speed since we just verified the TX)
    session.buyinDirect(p.id, addr, BUYIN);
    console.log('    ' + p.id + ' seated with ' + BUYIN + ' CHIPS');
  }

  // 4. Play hands
  console.log('\n[4] Playing ' + HANDS_TO_PLAY + ' hands...');

  let engine = null;
  const playerHoles = {};
  let board = [];

  for (let hand = 1; hand <= HANDS_TO_PLAY; hand++) {
    const activePlayers = session.getActivePlayers();
    if (activePlayers.length < 2) {
      console.log('    Not enough active players. Ending session.');
      break;
    }

    console.log('\n    ─── Hand ' + hand + '/' + HANDS_TO_PLAY + ' ───');

    // Create fresh engine for each hand with current chip counts
    const io = createGameIO(playerHoles, board);
    engine = createEngine(TABLE, io);
    for (const p of activePlayers) {
      engine.addPlayer(p.id, p.chips);
    }
    board = [];

    // Create crypto backend
    const crypto = PROTOCOL === 'sg777'
      ? createSg777Backend(activePlayers.length)
      : createSRABackend(activePlayers.length);

    await engine.playHand(crypto);

    // Update session with new chip counts
    const chipResults = engine.game.players.map(p => ({ id: p.id, chips: p.chips }));
    session.updateChips(chipResults);

    // Process end of hand (sit-outs, disconnects)
    const toCashOut = session.processEndOfHand();
    for (const co of toCashOut) {
      console.log('    Cashing out ' + co.id + ': ' + co.amount + ' CHIPS');
    }

    // Print chip counts
    const status = session.getStatus();
    console.log('    Active: ' + status.active + '  Chips: ' +
      activePlayers.map(p => {
        const sp = session.getPlayer(p.id);
        return p.id + ':' + sp.chips.toFixed(4);
      }).join('  '));

    // Simulate: player 1 leaves after hand 3
    if (hand === 3 && HANDS_TO_PLAY > 3) {
      console.log('\n    >>> ' + PLAYERS[0].id + ' requests to leave <<<');
      session.requestLeave(PLAYERS[0].id);
    }
  }

  // 5. Close table — cash out everyone
  console.log('\n[5] Closing table — cashing out all players...');
  const cashOuts = await session.closeTable();
  for (const co of cashOuts) {
    if (co.ok && co.amount > 0) {
      console.log('    ' + co.id + ': paid ' + co.amount + ' CHIPS (TX: ' + co.txid + ')');
    } else if (co.amount === 0) {
      console.log('    ' + co.id + ': busted (0 CHIPS)');
    } else {
      console.log('    ' + co.id + ': FAILED - ' + co.error);
    }
  }

  // 6. Record session to chain
  console.log('\n[6] Recording session on-chain...');
  try {
    const summary = session.getSummary();
    const sessionData = {
      type: 'poker_session',
      table: HOUSE_ID,
      protocol: PROTOCOL,
      hands_played: HANDS_TO_PLAY,
      players: summary.map(p => ({
        id: p.id,
        buyin: p.buyIn,
        cashout: parseFloat(p.cashOut.toFixed(8)),
        profit: parseFloat((p.cashOut - p.buyIn).toFixed(8)),
        hands: p.handsPlayed
      })),
      timestamp: Date.now()
    };

    const hexData = Buffer.from(JSON.stringify(sessionData)).toString('hex');
    const vdxf = await client.call('getvdxfid', [VDXF_KEYS.SETTLEMENT]);

    await client.call('updateidentity', [{
      name: 'poker-dealer',
      parent: 'iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP',
      contentmultimap: { [vdxf.vdxfid]: hexData }
    }]);
    console.log('    Session recorded!');
    console.log('    ' + JSON.stringify(sessionData, null, 2));
  } catch (e) {
    console.log('    Failed: ' + e.message);
  }

  // 7. Summary
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║  SESSION COMPLETE                           ║');
  console.log('╚════════════════════════════════════════════╝');
  const summary = session.getSummary();
  for (const p of summary) {
    const diff = p.cashOut - p.buyIn;
    const sign = diff >= 0 ? '+' : '';
    console.log('  ' + p.id.padEnd(12) + 'In: ' + p.buyIn.toFixed(4) +
      '  Out: ' + p.cashOut.toFixed(4) +
      '  ' + sign + diff.toFixed(4) +
      '  (' + p.handsPlayed + ' hands)');
  }
  console.log();
}

function createGameIO(playerHoles, board) {
  return {
    broadcast(event, data) {
      if (event === 'hand_start') console.log('    Dealer: seat ' + data.dealer);
      if (event === 'community_cards') {
        board.push(...(data.cards || []));
        console.log('    Board: ' + board.map(dc).join(' '));
      }
      if (event === 'action') {
        console.log('    ' + data.player + ': ' + data.action + (data.amount ? ' ' + data.amount : ''));
      }
      if (event === 'showdown') {
        board.length = 0;
        board.push(...(data.board || []));
        console.log('    *** SHOWDOWN ***');
        for (const [, info] of Object.entries(data.hands || {})) {
          const cards = (info.cards || []).map(dc).join(' ');
          console.log('    ' + info.id + ': ' + cards + ' (' + info.handName + ')' +
            (info.won ? ' WINS ' + info.payout : ''));
        }
      }
    },
    sendTo(playerId, event, data) {
      if (event === 'hole_cards') {
        console.log('    ' + playerId + ': ' + data.cards.map(dc).join(' '));
      }
    },
    async waitForAction(playerId, validActions, timeout) {
      const r = Math.random();
      const minR = 0.02;
      if (validActions.includes(CHECK)) return r < 0.65 ? { action: CHECK } : { action: RAISE, amount: minR };
      if (validActions.includes(CALL)) return r < 0.5 ? { action: CALL } : (r < 0.7 ? { action: RAISE, amount: minR } : { action: FOLD });
      return { action: FOLD };
    },
    broadcastState() {},
    log(msg) { if (msg.includes('Hand Complete')) console.log('    ' + msg); }
  };
}

main().catch(e => { console.error(e); process.exit(1); });
