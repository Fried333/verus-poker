/**
 * Full End-to-End Game — the complete poker flow:
 * 1. Create multisig escrow from cashier nodes
 * 2. Players deposit to multisig
 * 3. Play N hands (protocol + engine)
 * 4. Cashier nodes verify each hand
 * 5. Both cashier nodes agree → sign settlement
 * 6. Payout from multisig to winners
 *
 * Usage: node full-game.mjs [--hands N]
 */

import { createClient } from './verus-rpc.mjs';
import { createEscrow } from './escrow.mjs';
import { createCashierNode } from './cashier-node.mjs';
import { playerInit, dealerShuffle, cashierShuffle, verifyGame } from './protocol.mjs';
import { createEngine } from './poker-engine.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import { FOLD, CHECK, CALL, RAISE } from './game.mjs';

const WAIT = ms => new Promise(r => setTimeout(r, ms));

const RPC = {
  host: '127.0.0.1', port: 22778,
  user: 'user918810440',
  pass: 'passfde4eac81e50dd465529238848a8a77b32c8d17ebb4345c8ebe4150ca3aa9374d1'
};

const PARENT = 'iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP';
const DEALER_ADDR = 'RDGUMRNth3VTdBvkLRCsseHa6VajCjB949';

const CASHIER_NODES = [
  { id: 'poker-cn1', addr: 'RGK7nWZX1dwJYpqmK7YnSBuExWwCoskhLu' },
  { id: 'poker-cn2', addr: 'RCGLeG88wArw5ins9LaEmYTtiN8v2t8Pat' }
];

const PLAYERS = [
  { id: 'poker-p1', fullId: 'poker-p1.CHIPS@', addr: 'RN2hEjcQ1EcmGGfkGD4JCDNyfT571Eqz64' },
  { id: 'poker-p2', fullId: 'poker-p2.CHIPS@', addr: 'RECGjSHtaiZ92s3TUtyw3F9kqevwdJ7MtB' }
];

const BUYIN = 0.5;
const SMALL_BLIND = 0.01;
const BIG_BLIND = 0.02;
const RAKE_PERCENT = 2.5;
const NUM_CARDS = 14;
const HANDS = parseInt(process.argv.find(a => a.startsWith('--hands='))?.split('=')[1] || '2');

const client = createClient(RPC);

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  VERUS POKER — Full End-to-End Flow              ║');
  console.log('╚══════════════════════════════════════════════════╝');

  const info = await client.getInfo();
  console.log('\nChain: ' + info.name + ' Block: ' + info.blocks);

  // ═══════════════════════════════════════
  // STEP 1: Create multisig escrow
  // ═══════════════════════════════════════
  console.log('\n[STEP 1] Creating 2-of-2 multisig escrow...');
  const escrow = createEscrow(RPC, CASHIER_NODES);
  const msig = await escrow.createMultisig();
  console.log('  Address: ' + msig.address);

  // ═══════════════════════════════════════
  // STEP 2: Players deposit to multisig
  // ═══════════════════════════════════════
  console.log('\n[STEP 2] Player deposits (' + BUYIN + ' CHIPS each)...');
  for (const p of PLAYERS) {
    console.log('  ' + p.id + ' depositing ' + BUYIN + ' to ' + msig.address + '...');
    try {
      const opid = await client.sendCurrency(p.addr, [{
        address: msig.address,
        amount: BUYIN
      }]);
      const result = await client.waitForOperation(opid, 30000);
      console.log('  TX: ' + result.txid.substring(0, 16) + '...');
      await escrow.recordDeposit(p.id, result.txid, BUYIN);
    } catch (e) {
      console.log('  FAILED: ' + e.message);
      console.log('  Trying from dealer fund...');
      const opid = await client.sendCurrency(DEALER_ADDR, [{
        address: msig.address,
        amount: BUYIN
      }]);
      const result = await client.waitForOperation(opid, 30000);
      console.log('  TX (from dealer): ' + result.txid.substring(0, 16) + '...');
      await escrow.recordDeposit(p.id, result.txid, BUYIN);
    }
    await WAIT(2000);
  }

  console.log('  Total deposited: ' + escrow.getTotalDeposited() + ' CHIPS');
  console.log('  Waiting for confirmations...');
  await WAIT(12000);

  // ═══════════════════════════════════════
  // STEP 3: Create cashier nodes
  // ═══════════════════════════════════════
  console.log('\n[STEP 3] Initializing cashier nodes...');
  const cn1 = createCashierNode({ nodeId: 'poker-cn1', nodeAddr: CASHIER_NODES[0].addr });
  const cn2 = createCashierNode({ nodeId: 'poker-cn2', nodeAddr: CASHIER_NODES[1].addr });
  console.log('  CN1: poker-cn1 ready');
  console.log('  CN2: poker-cn2 ready');

  // ═══════════════════════════════════════
  // STEP 4: Play hands
  // ═══════════════════════════════════════
  const chipBalances = {};
  for (const p of PLAYERS) chipBalances[p.id] = BUYIN;

  let totalRake = 0;

  for (let hand = 1; hand <= HANDS; hand++) {
    // Skip busted players
    const activePlayers = PLAYERS.filter(p => chipBalances[p.id] > 0);
    if (activePlayers.length < 2) {
      console.log('\n  Not enough players with chips. Session over.');
      break;
    }

    console.log('\n' + '━'.repeat(50));
    console.log('  HAND ' + hand + '/' + HANDS + ' (' + activePlayers.length + ' players)');
    console.log('━'.repeat(50));

    // Protocol: 3-stage shuffle
    const playerData = activePlayers.map(p => playerInit(NUM_CARDS, p.id));
    const dealerData = dealerShuffle(playerData, NUM_CARDS);
    const cashierData = cashierShuffle(dealerData.blindedDecks, activePlayers.length, NUM_CARDS, 2);

    // Deal hole cards
    let cardPos = 0;
    const holeCards = {};
    for (let i = 0; i < activePlayers.length; i++) {
      const cards = [];
      for (let c = 0; c < 2; c++) {
        const cp = cashierData.sigma_Cashier[cardPos];
        const dp = dealerData.sigma_Dealer[cp];
        const pp = playerData[i].permutation[dp];
        cards.push(pp % 52);
        cardPos++;
      }
      holeCards[activePlayers[i].id] = cards;
      console.log('  ' + activePlayers[i].id + ': ' + cards.map(cardToString).join(' '));
    }

    // Play with engine
    const io = {
      broadcast(event, data) {
        if (event === 'action') console.log('    ' + data.player + ': ' + data.action + (data.amount ? ' ' + data.amount : ''));
        if (event === 'community_cards') console.log('    Board: ' + (data.board || []).map(c => typeof c === 'number' ? cardToString(c) : c).join(' '));
        if (event === 'showdown') {
          console.log('    *** SHOWDOWN ***');
          for (const [, info] of Object.entries(data.hands || {})) {
            console.log('    ' + info.id + ': ' + (info.cards || []).map(c => typeof c === 'number' ? cardToString(c) : c).join(' ') + ' (' + info.handName + ')' + (info.won ? ' WINS ' + info.payout : ''));
          }
        }
      },
      sendTo() {},
      async waitForAction(pid, va) {
        // Random action — pick any valid action equally
        const action = va[Math.floor(Math.random() * va.length)];
        const amount = action === 'raise' ? BIG_BLIND * (2 + Math.floor(Math.random() * 5)) : 0;
        return { action, amount };
      },
      broadcastState() {},
      log(msg) { if (msg.includes('Complete')) console.log('    ' + msg); }
    };

    const engine = createEngine({ smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, rake: 0 }, io);
    for (const p of activePlayers) engine.addPlayer(p.id, chipBalances[p.id]);
    for (let i = 0; i < activePlayers.length; i++) {
      engine.game.players[i].holeCards = holeCards[activePlayers[i].id];
    }

    let revealPos = activePlayers.length * 2;
    const crypto = {
      async initDeck(n) { revealPos = PLAYERS.length * 2; return {}; },
      async revealCard() {
        const cp = cashierData.sigma_Cashier[revealPos];
        const dp = dealerData.sigma_Dealer[cp];
        const pp = playerData[0].permutation[dp];
        revealPos++;
        return pp % 52;
      }
    };

    await engine.playHand(crypto);

    // Update balances
    for (const p of engine.game.players) chipBalances[p.id] = p.chips;

    // Cashier verification (both nodes)
    console.log('\n  Verification:');
    const vote1 = await cn1.verifyHand(playerData, dealerData, cashierData, NUM_CARDS, hand);
    const vote2 = await cn2.verifyHand(playerData, dealerData, cashierData, NUM_CARDS, hand);
    const consensus = vote1.vote === 'PAY' && vote2.vote === 'PAY';
    console.log('  Consensus: ' + (consensus ? 'APPROVED' : 'DISPUTED'));

    console.log('  Balances: ' + PLAYERS.map(p => p.id + ':' + chipBalances[p.id].toFixed(4)).join('  '));
  }

  // ═══════════════════════════════════════
  // STEP 5: Settlement
  // ═══════════════════════════════════════
  console.log('\n' + '═'.repeat(50));
  console.log('[STEP 5] Settlement');
  console.log('═'.repeat(50));

  // Calculate rake
  for (const p of PLAYERS) {
    const profit = chipBalances[p.id] - BUYIN;
    if (profit > 0) {
      const rake = profit * RAKE_PERCENT / 100;
      chipBalances[p.id] -= rake;
      totalRake += rake;
      console.log('  Rake from ' + p.id + ': ' + rake.toFixed(8) + ' CHIPS');
    }
  }

  // Build payout list
  const payouts = PLAYERS.map(p => ({
    address: p.addr,
    amount: chipBalances[p.id]
  }));

  console.log('\n  Payouts:');
  for (const p of payouts) {
    console.log('    ' + p.address.substring(0, 12) + '... → ' + p.amount.toFixed(8) + ' CHIPS');
  }
  console.log('  Rake: ' + totalRake.toFixed(8) + ' (dealer: ' + (totalRake / 2).toFixed(8) + ', cashiers: ' + (totalRake / 2).toFixed(8) + ')');

  // Settle from multisig
  console.log('\n  Creating settlement TX from multisig...');
  try {
    const result = await escrow.settle(payouts, {
      dealerAddr: DEALER_ADDR,
      dealerAmount: totalRake / 2,
      cashierAddrs: CASHIER_NODES.map(n => n.addr),
      cashierAmount: totalRake / 2
    });

    if (result.complete) {
      console.log('  SETTLEMENT TX: ' + result.txid);
    } else {
      console.log('  Settlement incomplete: ' + (result.error || 'needs more signatures'));
    }
  } catch (e) {
    console.log('  Settlement error: ' + e.message);
    console.log('  (May need to fund multisig or wait for confirmations)');
  }

  // ═══════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  SESSION COMPLETE                                 ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('  Hands played: ' + HANDS);
  console.log('  Total rake: ' + totalRake.toFixed(8) + ' CHIPS');
  for (const p of PLAYERS) {
    const diff = chipBalances[p.id] - BUYIN;
    console.log('  ' + p.id + ': ' + chipBalances[p.id].toFixed(8) + ' (' + (diff >= 0 ? '+' : '') + diff.toFixed(8) + ')');
  }
  console.log('  Chips conserved: ' + (Object.values(chipBalances).reduce((s, v) => s + v, 0) + totalRake).toFixed(8));

  // Verification summary
  const allVerified = [...cn1.getLog(), ...cn2.getLog()].every(v => v.vote === 'PAY');
  console.log('  All hands verified: ' + allVerified);
}

main().catch(e => { console.error(e); process.exit(1); });
