/**
 * Chain Game — runs the full protocol with actual Verus ID writes
 * Each game phase writes state to contentmultimap via VDXF keys.
 *
 * Usage: node chain-game.mjs [--hands N]
 */

import { createClient } from './verus-rpc.mjs';
import { playerInit, dealerShuffle, cashierShuffle, verifyGame } from './protocol.mjs';
import { createEngine } from './poker-engine.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import { FOLD, CHECK, CALL, RAISE } from './game.mjs';
import { createHash } from 'crypto';

const WAIT = ms => new Promise(r => setTimeout(r, ms));

// RPC config
const RPC = {
  host: '127.0.0.1', port: 22778,
  user: 'user918810440',
  pass: 'passfde4eac81e50dd465529238848a8a77b32c8d17ebb4345c8ebe4150ca3aa9374d1'
};

// IDs and addresses
const TABLE_ID = 'poker-table';
const DEALER_ID = 'poker-dealer';
const PARENT = 'iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP';
const DEALER_ADDR = 'RDGUMRNth3VTdBvkLRCsseHa6VajCjB949';

const PLAYERS = [
  { id: 'poker-p1', fullId: 'poker-p1.CHIPS@', addr: 'RN2hEjcQ1EcmGGfkGD4JCDNyfT571Eqz64' },
  { id: 'poker-p2', fullId: 'poker-p2.CHIPS@', addr: 'RECGjSHtaiZ92s3TUtyw3F9kqevwdJ7MtB' }
];

const NUM_CARDS = 14;
const SMALL_BLIND = 0.01;
const BIG_BLIND = 0.02;
const HANDS = parseInt(process.argv.find(a => a.startsWith('--hands='))?.split('=')[1] || '1');

const client = createClient(RPC);

// VDXF key cache
const vdxfCache = {};
async function getVdxfId(keyName) {
  if (!vdxfCache[keyName]) {
    const result = await client.call('getvdxfid', [keyName]);
    vdxfCache[keyName] = result.vdxfid;
  }
  return vdxfCache[keyName];
}

// Write data to an identity's contentmultimap
// Track last TX per identity for UTXO sequencing
const lastTx = {};

async function writeToId(idName, vdxfKeyName, data) {
  const vdxfId = await getVdxfId(vdxfKeyName);
  const hexData = Buffer.from(JSON.stringify(data)).toString('hex');

  // Wait if we recently wrote to this identity
  if (lastTx[idName]) {
    await WAIT(12000); // Wait for previous TX to confirm (~1 CHIPS block)
  }

  try {
    const txid = await client.call('updateidentity', [{
      name: idName,
      parent: PARENT,
      contentmultimap: { [vdxfId]: hexData }
    }]);
    lastTx[idName] = txid;
    return txid;
  } catch (e) {
    console.log('  [WARN] Write failed: ' + e.message);
    // Retry once after waiting
    await WAIT(12000);
    try {
      const txid = await client.call('updateidentity', [{
        name: idName,
        parent: PARENT,
        contentmultimap: { [vdxfId]: hexData }
      }]);
      lastTx[idName] = txid;
      return txid;
    } catch (e2) {
      console.log('  [WARN] Retry failed: ' + e2.message);
      return null;
    }
  }
}

// Read data from identity contentmultimap
async function readFromId(idName, vdxfKeyName) {
  try {
    const result = await client.call('getidentitycontent', [
      idName + '.CHIPS@', 0, -1
    ]);
    const cmm = result?.identity?.contentmultimap || result?.contentmultimap || {};
    const vdxfId = await getVdxfId(vdxfKeyName);
    const values = cmm[vdxfId];
    if (!values) return null;
    // Decode hex
    const hexStr = Array.isArray(values) ? values[values.length - 1] : values;
    const rawHex = typeof hexStr === 'object' ? Object.values(hexStr)[0] : hexStr;
    return JSON.parse(Buffer.from(rawHex, 'hex').toString('utf8'));
  } catch {
    return null;
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  VERUS POKER — Full Protocol On-Chain          ║');
  console.log('╚════════════════════════════════════════════════╝');

  // Verify connection
  const info = await client.getInfo();
  console.log('\nChain: ' + info.name + ' Block: ' + info.blocks);

  // Verify identities
  for (const p of [{ id: DEALER_ID, full: 'poker-dealer.CHIPS@' }, ...PLAYERS.map(p => ({ id: p.id, full: p.fullId }))]) {
    try {
      const identity = await client.getIdentity(p.full);
      console.log('  ' + p.id + ': ' + identity.identity.primaryaddresses[0]);
    } catch (e) {
      console.log('  ' + p.id + ': NOT FOUND - ' + e.message);
    }
  }

  // Generate game ID
  const gameId = createHash('sha256').update(Date.now().toString() + Math.random().toString()).digest('hex').substring(0, 16);
  console.log('\nGame ID: ' + gameId);

  // Track chips
  const chipBalances = {};
  for (const p of PLAYERS) chipBalances[p.id] = 0.5; // Virtual buy-in

  for (let hand = 1; hand <= HANDS; hand++) {
    console.log('\n' + '━'.repeat(50));
    console.log('  HAND ' + hand + '/' + HANDS);
    console.log('━'.repeat(50));

    // ──── PHASE 1: Write game start to table ID ────
    console.log('\n[1] Game start → table ID...');
    const startData = {
      game_id: gameId,
      hand: hand,
      state: 'PLAYERS_JOINED',
      players: PLAYERS.map(p => p.id),
      blinds: [SMALL_BLIND, BIG_BLIND],
      timestamp: Date.now()
    };
    const tx1 = await writeToId(TABLE_ID, 'vrsc::poker.game.state', startData);
    console.log('  TX: ' + (tx1 ? tx1.substring(0, 16) + '...' : 'failed'));

    // ──── PHASE 2: Player deck init → player IDs ────
    console.log('\n[2] Player deck init...');
    const playerData = [];
    for (let i = 0; i < PLAYERS.length; i++) {
      const pd = playerInit(NUM_CARDS, PLAYERS[i].id);
      playerData.push(pd);

      // Write public deck data to player's ID
      const deckData = {
        game_id: gameId,
        hand: hand,
        public_key: pd.publicKey.toString(16).substring(0, 32),
        commitment: pd.commitment,
        deck_size: NUM_CARDS
      };
      const tx = await writeToId(PLAYERS[i].id, 'vrsc::poker.deck.player', deckData);
      console.log('  ' + PLAYERS[i].id + ' deck → TX: ' + (tx ? tx.substring(0, 16) + '...' : 'failed'));
      await WAIT(1000); // Don't flood
    }

    // ──── PHASE 3: Dealer shuffle → table ID ────
    console.log('\n[3] Dealer shuffle and blind...');
    const dealerData = dealerShuffle(playerData, NUM_CARDS);
    const dealerUpdate = {
      game_id: gameId,
      hand: hand,
      state: 'DECK_SHUFFLED_DEALER',
      commitment: dealerData.dealerCommitment,
      e_points: dealerData.E.map(e => e.toString(16).substring(0, 32)),
      timestamp: Date.now()
    };
    const tx3 = await writeToId(TABLE_ID, 'vrsc::poker.deck.dealer', dealerUpdate);
    console.log('  TX: ' + (tx3 ? tx3.substring(0, 16) + '...' : 'failed'));

    // ──── PHASE 4: Cashier shuffle → table ID ────
    console.log('\n[4] Cashier shuffle, blind, SSS...');
    const cashierData = cashierShuffle(dealerData.blindedDecks, PLAYERS.length, NUM_CARDS, 2);
    const cashierUpdate = {
      game_id: gameId,
      hand: hand,
      state: 'DECK_SHUFFLED_CASHIER',
      commitment: cashierData.cashierCommitment,
      timestamp: Date.now()
    };
    const tx4 = await writeToId(TABLE_ID, 'vrsc::poker.deck.cashier', cashierUpdate);
    console.log('  TX: ' + (tx4 ? tx4.substring(0, 16) + '...' : 'failed'));

    // ──── PHASE 5: Deal and play ────
    console.log('\n[5] Dealing and playing...');

    // Map cards through permutations
    let cardPos = 0;
    const holeCards = {};
    for (let i = 0; i < PLAYERS.length; i++) {
      const cards = [];
      for (let c = 0; c < 2; c++) {
        const cp = cashierData.sigma_Cashier[cardPos];
        const dp = dealerData.sigma_Dealer[cp];
        const pp = playerData[i].permutation[dp];
        cards.push(pp % 52);
        cardPos++;
      }
      holeCards[PLAYERS[i].id] = cards;
      console.log('  ' + PLAYERS[i].id + ': ' + cards.map(cardToString).join(' '));
    }

    // Play hand with engine
    const actions = [];
    const io = {
      broadcast(event, data) {
        if (event === 'action') {
          actions.push({ player: data.player, action: data.action, amount: data.amount });
          console.log('    ' + data.player + ': ' + data.action + (data.amount ? ' ' + data.amount : ''));
        }
        if (event === 'community_cards') {
          console.log('    Board: ' + (data.board || []).map(c => typeof c === 'number' ? cardToString(c) : c).join(' '));
        }
        if (event === 'showdown') {
          console.log('    *** SHOWDOWN ***');
          for (const [, info] of Object.entries(data.hands || {})) {
            const cards = (info.cards || []).map(c => typeof c === 'number' ? cardToString(c) : c).join(' ');
            console.log('    ' + info.id + ': ' + cards + ' (' + info.handName + ')' +
              (info.won ? ' WINS ' + info.payout : ''));
          }
        }
      },
      sendTo() {},
      async waitForAction(playerId, validActions) {
        const r = Math.random();
        if (validActions.includes('check')) return r < 0.6 ? { action: 'check' } : { action: 'fold' };
        if (validActions.includes('call')) return r < 0.5 ? { action: 'call' } : { action: 'fold' };
        return { action: 'fold' };
      },
      broadcastState() {},
      log(msg) { if (msg.includes('Complete')) console.log('    ' + msg); }
    };

    const engine = createEngine({ smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, rake: 0 }, io);
    for (const p of PLAYERS) engine.addPlayer(p.id, chipBalances[p.id]);

    // Set hole cards
    for (let i = 0; i < PLAYERS.length; i++) {
      engine.game.players[i].holeCards = holeCards[PLAYERS[i].id];
    }

    // Simple crypto that returns pre-dealt cards
    let revealPos = PLAYERS.length * 2; // Start after hole cards
    const crypto = {
      async initDeck(n) { revealPos = PLAYERS.length * 2; return {}; },
      async revealCard(pos) {
        const cp = cashierData.sigma_Cashier[revealPos];
        const dp = dealerData.sigma_Dealer[cp];
        const pp = playerData[0].permutation[dp];
        revealPos++;
        return pp % 52;
      }
    };

    await engine.playHand(crypto);

    // Update balances
    for (const p of engine.game.players) {
      chipBalances[p.id] = p.chips;
    }

    // ──── PHASE 6: Write actions to table ID ────
    console.log('\n[6] Recording actions on-chain...');
    const actionsData = {
      game_id: gameId,
      hand: hand,
      actions: actions,
      board: engine.game.board.map(cardToString),
      timestamp: Date.now()
    };
    const tx6 = await writeToId(TABLE_ID, 'vrsc::poker.player.action', actionsData);
    console.log('  TX: ' + (tx6 ? tx6.substring(0, 16) + '...' : 'failed'));

    // ──── PHASE 7: Verification ────
    console.log('\n[7] Verification...');
    const verification = verifyGame(playerData, dealerData, cashierData, NUM_CARDS);
    console.log('  Result: ' + (verification.valid ? 'PASSED' : 'FAILED: ' + verification.errors.join(', ')));

    // ──── PHASE 8: Settlement record ────
    console.log('\n[8] Settlement record...');
    const settlement = {
      game_id: gameId,
      hand: hand,
      verified: verification.valid,
      results: engine.game.players.map(p => ({
        id: p.id,
        chips: parseFloat(p.chips.toFixed(8)),
        hole_cards: p.holeCards.map(cardToString),
        folded: p.folded
      })),
      board: engine.game.board.map(cardToString),
      timestamp: Date.now()
    };
    const tx8 = await writeToId(TABLE_ID, 'vrsc::poker.settlement', settlement);
    console.log('  TX: ' + (tx8 ? tx8.substring(0, 16) + '...' : 'failed'));

    // Summary
    console.log('\n  Balances: ' + PLAYERS.map(p => p.id + ':' + chipBalances[p.id].toFixed(4)).join('  '));
    console.log('  Total: ' + Object.values(chipBalances).reduce((s, v) => s + v, 0).toFixed(4));

    if (hand < HANDS) await WAIT(2000);
  }

  // ──── Final: Read back from chain ────
  console.log('\n' + '═'.repeat(50));
  console.log('Reading back from chain...');
  const settlement = await readFromId(TABLE_ID, 'vrsc::poker.settlement');
  if (settlement) {
    console.log('  Settlement on-chain:');
    console.log('    Game: ' + settlement.game_id);
    console.log('    Verified: ' + settlement.verified);
    for (const r of settlement.results || []) {
      console.log('    ' + r.id + ': ' + r.chips + ' chips (' + r.hole_cards.join(' ') + ')' + (r.folded ? ' FOLDED' : ''));
    }
    console.log('    Board: ' + (settlement.board || []).join(' '));
  } else {
    console.log('  Could not read settlement (may need block confirmation)');
  }

  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║  SESSION COMPLETE                               ║');
  console.log('╚════════════════════════════════════════════════╝');
}

main().catch(e => { console.error(e); process.exit(1); });
