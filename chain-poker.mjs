/**
 * Chain Poker — plays poker with on-chain escrow and game state via Verus IDs
 *
 * Flow:
 * 1. House publishes table config to their VerusID contentmultimap
 * 2. Player sends buy-in TX to house address
 * 3. House verifies TX, seats player
 * 4. Game plays (in-memory for now, on-chain state later)
 * 5. House sends payout TX to winner
 *
 * Usage: node chain-poker.mjs
 */

import { createClient, VDXF_KEYS } from './verus-rpc.mjs';
import { createEngine, createMockCrypto } from './poker-engine.mjs';
import { createSg777Backend } from './crypto-backend-sg.mjs';
import { createSRABackend } from './crypto-backend-sra.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import {
  FOLD, CHECK, CALL, RAISE, ALL_IN,
  WAITING, SHOWDOWN, SETTLED
} from './game.mjs';

// Config
const RPC_CONFIG = {
  host: '127.0.0.1',
  port: 22778,
  user: 'user918810440',
  pass: 'passfde4eac81e50dd465529238848a8a77b32c8d17ebb4345c8ebe4150ca3aa9374d1'
};

const TABLE_CONFIG = {
  smallBlind: 0.01,
  bigBlind: 0.02,
  minBuyin: 0.5,
  maxBuyin: 5.0,
  rake: 0
};

// House identity — this is the dealer/cashier
const HOUSE_ID = 'poker-dealer.CHIPS@';
// Player identities
const PLAYER_IDS = ['poker-p1.CHIPS@', 'poker-p2.CHIPS@'];

const client = createClient(RPC_CONFIG);

// Card display
const SUITS = { c: '♣', d: '♦', h: '♥', s: '♠' };
function displayCard(c) {
  if (typeof c !== 'number') return c;
  const r = '23456789TJQKA'[c % 13];
  const s = ['c','d','h','s'][Math.floor(c / 13)];
  return r + SUITS[s];
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   VERUS POKER — On-Chain Integration     ║');
  console.log('╚══════════════════════════════════════════╝');

  // Step 1: Verify daemon connection
  console.log('\n[1] Connecting to CHIPS daemon...');
  try {
    const info = await client.getInfo();
    console.log('    Chain: ' + info.name + '  Block: ' + info.blocks);
  } catch (e) {
    console.error('    FAILED: ' + e.message);
    process.exit(1);
  }

  // Step 2: Verify house identity
  console.log('\n[2] Verifying house identity: ' + HOUSE_ID);
  try {
    const id = await client.getIdentity(HOUSE_ID);
    console.log('    Address: ' + id.identity.primaryaddresses[0]);
    const canSign = await client.canSignFor(HOUSE_ID);
    console.log('    Can sign: ' + canSign);
    if (!canSign) {
      console.error('    ERROR: Cannot sign for house identity!');
      process.exit(1);
    }
  } catch (e) {
    console.error('    FAILED: ' + e.message);
    process.exit(1);
  }

  // Step 3: Check house balance
  console.log('\n[3] Checking house balance...');
  const balance = await client.getBalance();
  console.log('    Wallet balance: ' + balance + ' CHIPS');
  if (balance < 1) {
    console.error('    WARNING: Low balance for payouts');
  }

  // Step 4: Publish table config to house VerusID
  console.log('\n[4] Publishing table to ' + HOUSE_ID + '...');
  try {
    const tableData = {
      game: 'texas_holdem',
      blinds: [TABLE_CONFIG.smallBlind, TABLE_CONFIG.bigBlind],
      min_buyin: TABLE_CONFIG.minBuyin,
      max_buyin: TABLE_CONFIG.maxBuyin,
      rake: TABLE_CONFIG.rake,
      status: 'open',
      players: 0,
      max_players: 2,
      timestamp: Date.now()
    };

    // Write table config to house identity contentmultimap
    const hexData = Buffer.from(JSON.stringify(tableData)).toString('hex');
    const vdxfResult = await client.call('getvdxfid', [VDXF_KEYS.TABLE_CONFIG]);
    const vdxfId = vdxfResult.vdxfid;

    console.log('    VDXF ID for table config: ' + vdxfId);
    console.log('    Table data: ' + JSON.stringify(tableData));

    // Update the house identity with table config
    await client.call('updateidentity', [{
      name: 'poker-dealer',
      parent: 'iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP',
      contentmultimap: {
        [vdxfId]: hexData
      }
    }]);
    console.log('    Table published to chain!');
  } catch (e) {
    console.error('    Failed to publish: ' + e.message);
    console.log('    Continuing without on-chain table listing...');
  }

  // Step 5: Verify player identities
  console.log('\n[5] Verifying player identities...');
  for (const pid of PLAYER_IDS) {
    try {
      const id = await client.getIdentity(pid);
      const addr = id.identity.primaryaddresses[0];
      const bal = await client.call('z_getbalance', [addr]);
      console.log('    ' + pid + ' -> ' + addr + ' (' + bal + ' CHIPS)');
    } catch (e) {
      console.error('    ' + pid + ': ' + e.message);
    }
  }

  // Step 6: Play a hand with on-chain settlement
  console.log('\n[6] Playing a poker hand...');
  console.log('    Using SRA crypto (2-party, no blinder needed)');

  const io = createGameIO();
  const engine = createEngine(TABLE_CONFIG, io);
  engine.addPlayer('poker-p1', TABLE_CONFIG.minBuyin);
  engine.addPlayer('poker-p2', TABLE_CONFIG.minBuyin);

  const crypto = createSRABackend(2);
  await engine.playHand(crypto);

  // Step 7: Settle on-chain
  console.log('\n[7] On-chain settlement...');
  const game = engine.game;
  for (const p of game.players) {
    if (p.chips > TABLE_CONFIG.minBuyin) {
      const winnings = parseFloat((p.chips - TABLE_CONFIG.minBuyin).toFixed(8));
      console.log('    Winner: ' + p.id + ' earned ' + winnings + ' CHIPS');

      // Get winner's address
      try {
        const id = await client.getIdentity(p.id + '.CHIPS@');
        const winnerAddr = id.identity.primaryaddresses[0];
        console.log('    Sending ' + winnings + ' CHIPS to ' + winnerAddr);

        // Send payout from house
        const houseId = await client.getIdentity(HOUSE_ID);
        const houseAddr = houseId.identity.primaryaddresses[0];

        const opid = await client.sendCurrency(houseAddr, [{
          address: winnerAddr,
          amount: winnings
        }]);
        console.log('    Payout TX submitted: ' + opid);

        // Wait for confirmation
        const result = await client.waitForOperation(opid, 30000);
        console.log('    Payout confirmed: ' + result.txid);
      } catch (e) {
        console.error('    Payout failed: ' + e.message);
      }
    } else if (p.chips < TABLE_CONFIG.minBuyin) {
      console.log('    Loser: ' + p.id + ' lost ' + (TABLE_CONFIG.minBuyin - p.chips) + ' CHIPS');
    }
  }

  // Step 8: Write game result to chain
  console.log('\n[8] Recording game result on-chain...');
  try {
    const gameResult = {
      players: game.players.map(p => ({
        id: p.id,
        result: p.chips - TABLE_CONFIG.minBuyin,
        hand: p.holeCards.map(cardToString)
      })),
      board: game.board.map(cardToString),
      timestamp: Date.now()
    };

    const hexData = Buffer.from(JSON.stringify(gameResult)).toString('hex');
    const vdxfResult = await client.call('getvdxfid', [VDXF_KEYS.SETTLEMENT]);
    const vdxfId = vdxfResult.vdxfid;

    await client.call('updateidentity', [{
      name: 'poker-dealer',
      parent: 'iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP',
      contentmultimap: {
        [vdxfId]: hexData
      }
    }]);
    console.log('    Game result recorded on-chain!');
    console.log('    ' + JSON.stringify(gameResult));
  } catch (e) {
    console.error('    Failed to record: ' + e.message);
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   COMPLETE                                ║');
  console.log('╚══════════════════════════════════════════╝');
}

function createGameIO() {
  return {
    broadcast(event, data) {
      if (event === 'hand_start') console.log('    Dealer: seat ' + data.dealer);
      if (event === 'community_cards') {
        console.log('    Board: ' + (data.board || []).map(displayCard).join(' '));
      }
      if (event === 'action') {
        console.log('    ' + data.player + ': ' + data.action + (data.amount ? ' ' + data.amount : ''));
      }
      if (event === 'showdown') {
        console.log('\n    *** SHOWDOWN ***');
        for (const [seat, info] of Object.entries(data.hands || {})) {
          const cards = (info.cards || []).map(displayCard).join(' ');
          console.log('    ' + info.id + ': ' + cards + ' (' + info.handName + ')' +
            (info.won ? ' ** WINS ' + info.payout + ' **' : ''));
        }
      }
    },
    sendTo(playerId, event, data) {
      if (event === 'hole_cards') {
        console.log('    ' + playerId + ' dealt: ' + data.cards.map(displayCard).join(' '));
      }
    },
    async waitForAction(playerId, validActions, timeout) {
      // Auto-play bot for testing
      const r = Math.random();
      if (validActions.includes('check')) return { action: r < 0.7 ? 'check' : 'raise', amount: TABLE_CONFIG.bigBlind * 2 };
      if (validActions.includes('call')) return { action: r < 0.5 ? 'call' : 'fold' };
      return { action: 'fold' };
    },
    broadcastState() {},
    log(msg) { if (!msg.includes('===') && !msg.includes('Shuffling')) console.log('    ' + msg); }
  };
}

main().catch(e => { console.error(e); process.exit(1); });
