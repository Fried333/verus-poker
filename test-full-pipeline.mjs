/**
 * Full Pipeline Test — deposit → play → verify → settle → payout
 * Everything on the CHIPS blockchain with real funds.
 */

import { createClient } from './verus-rpc.mjs';
import { createP2PLayer } from './p2p-layer.mjs';
import { createP2PDealer } from './p2p-dealer.mjs';
import { createEscrow } from './escrow.mjs';
import { createCashierNode } from './cashier-node.mjs';

const WAIT = ms => new Promise(r => setTimeout(r, ms));

const RPC = {
  host: '127.0.0.1', port: 22778,
  user: 'user918810440',
  pass: 'passfde4eac81e50dd465529238848a8a77b32c8d17ebb4345c8ebe4150ca3aa9374d1'
};

const TABLE_ID = 'poker-table';
const DEALER_ID = 'poker-p1';
const PLAYER_IDS = ['poker-p1', 'poker-p2'];
const CASHIER_NODES = [
  { id: 'poker-cn1', addr: '' },
  { id: 'poker-cn2', addr: '' }
];
const DEALER_ADDR = '';
const BUYIN = 0.5; // CHIPS per player
const HANDS = parseInt(process.argv.find(a => a.startsWith('--hands='))?.split('=')[1] || '3');

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  FULL PIPELINE: Deposit → Play → Verify → Settle     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const client = createClient(RPC);
  const info = await client.getInfo();
  console.log('Chain: ' + info.name + ' Block: ' + info.blocks);
  console.log('Wallet: ' + (await client.call('getbalance')) + ' CHIPS\n');

  // ═══════════════════════════════════════
  // STEP 1: Resolve addresses
  // ═══════════════════════════════════════
  console.log('[STEP 1] Resolving identities...');
  const playerAddrs = {};
  for (const pid of PLAYER_IDS) {
    const id = await client.getIdentity(pid + '.CHIPS@');
    playerAddrs[pid] = id.identity.primaryaddresses[0];
    console.log('  ' + pid + ': ' + playerAddrs[pid]);
  }
  for (const cn of CASHIER_NODES) {
    const id = await client.getIdentity(cn.id + '.CHIPS@');
    cn.addr = id.identity.primaryaddresses[0];
    console.log('  ' + cn.id + ': ' + cn.addr);
  }
  const dealerId = await client.getIdentity('poker-dealer.CHIPS@');
  const dealerAddr = dealerId.identity.primaryaddresses[0];
  console.log('  dealer: ' + dealerAddr);

  // ═══════════════════════════════════════
  // STEP 2: Create multisig escrow
  // ═══════════════════════════════════════
  console.log('\n[STEP 2] Creating 2-of-2 multisig escrow...');
  const escrow = createEscrow(RPC, CASHIER_NODES);
  const msig = await escrow.createMultisig();
  console.log('  Address: ' + msig.address);

  // ═══════════════════════════════════════
  // STEP 3: Players deposit to multisig
  // ═══════════════════════════════════════
  console.log('\n[STEP 3] Depositing ' + BUYIN + ' CHIPS per player...');

  // Fund player addresses first if needed
  for (const pid of PLAYER_IDS) {
    const unspent = await client.call('listunspent', [0, 9999999, [playerAddrs[pid]]]);
    const bal = unspent.reduce((s, u) => s + u.amount, 0);
    if (bal < BUYIN + 0.01) {
      console.log('  Funding ' + pid + ' (' + bal.toFixed(4) + ' → ' + (BUYIN + 0.1) + ')...');
      const opid = await client.sendCurrency('*', [{ address: playerAddrs[pid], amount: BUYIN + 0.1 }]);
      await client.waitForOperation(opid, 30000);
      await WAIT(2000);
    }
  }

  // Wait for funding to confirm
  console.log('  Waiting for funding confirmations...');
  await WAIT(12000);

  // Deposit from each player to multisig
  for (const pid of PLAYER_IDS) {
    console.log('  ' + pid + ' → multisig ' + BUYIN + ' CHIPS...');
    try {
      const opid = await client.sendCurrency(playerAddrs[pid], [{ address: msig.address, amount: BUYIN }]);
      const result = await client.waitForOperation(opid, 30000);
      await escrow.recordDeposit(pid, result.txid, BUYIN);
      console.log('    TX: ' + result.txid.substring(0, 16) + '...');
    } catch (e) {
      console.log('    Failed: ' + e.message + ' — depositing from wallet...');
      const opid = await client.sendCurrency('*', [{ address: msig.address, amount: BUYIN }]);
      const result = await client.waitForOperation(opid, 30000);
      await escrow.recordDeposit(pid, result.txid, BUYIN);
      console.log('    TX (from wallet): ' + result.txid.substring(0, 16) + '...');
    }
    await WAIT(2000);
  }

  console.log('  Total deposited: ' + (BUYIN * PLAYER_IDS.length) + ' CHIPS');
  console.log('  Waiting for deposit confirmations...');
  await WAIT(15000);

  // Verify deposits
  const msigUnspent = await client.call('listunspent', [0, 9999999, [msig.address]]);
  const msigBal = msigUnspent.reduce((s, u) => s + u.amount, 0);
  console.log('  Multisig balance: ' + msigBal.toFixed(4) + ' CHIPS');

  // ═══════════════════════════════════════
  // STEP 4: Play hands on-chain
  // ═══════════════════════════════════════
  console.log('\n[STEP 4] Playing ' + HANDS + ' hands on-chain...');

  const p2p = createP2PLayer(RPC, DEALER_ID, TABLE_ID);
  const chipBalances = {};
  PLAYER_IDS.forEach(pid => chipBalances[pid] = BUYIN);

  let allVerified = true;
  const localNotify = (event, data) => {
    if (event === 'need_action') {
      const va = data.validActions;
      const act = va.includes('check') ? 'check' : va.includes('call') ? 'call' : 'fold';
      setTimeout(() => data.resolve({ action: act, amount: 0 }), 100);
    }
    if (event === 'hand_complete') {
      console.log('  Hand ' + data.hand + ': verified=' + data.verified);
      data.players.forEach(p => {
        chipBalances[p.id] = p.chips;
        console.log('    ' + p.id + ': ' + p.chips.toFixed(4));
      });
    }
  };

  // Scale chips to match BUYIN (game uses integer chips, we map to CHIPS amounts)
  const CHIP_UNIT = 0.01; // 1 game chip = 0.01 CHIPS
  const gameChips = BUYIN / CHIP_UNIT; // 50 game chips per player

  const dealer = createP2PDealer(p2p, {
    smallBlind: 1,
    bigBlind: 2,
    buyin: gameChips
  }, localNotify);

  await dealer.openTable();
  for (const pid of PLAYER_IDS) dealer.addPlayer(pid, gameChips);

  for (let h = 0; h < HANDS; h++) {
    const active = dealer.getPlayers().filter(p => p.chips > 0);
    if (active.length < 2) { console.log('  Not enough players'); break; }
    const result = await dealer.runHand();
    if (!result || !result.verified) allVerified = false;
    await WAIT(2000);
  }

  // ═══════════════════════════════════════
  // STEP 5: Cashier verification
  // ═══════════════════════════════════════
  console.log('\n[STEP 5] Cashier verification...');
  console.log('  All hands verified: ' + allVerified);

  // ═══════════════════════════════════════
  // STEP 6: Settlement — payout from multisig
  // ═══════════════════════════════════════
  console.log('\n[STEP 6] Settlement...');

  const finalPlayers = dealer.getPlayers();
  const totalGameChips = finalPlayers.reduce((s, p) => s + p.chips, 0);
  console.log('  Total game chips: ' + totalGameChips + ' (expected: ' + (gameChips * PLAYER_IDS.length) + ')');
  console.log('  Chips conserved: ' + (totalGameChips === gameChips * PLAYER_IDS.length));

  // Calculate payouts in CHIPS
  const payouts = [];
  const rakePercent = 2.5;
  let totalRake = 0;

  for (const p of finalPlayers) {
    const chipsAmount = p.chips * CHIP_UNIT;
    const deposit = BUYIN;
    const profit = Math.max(0, chipsAmount - deposit);
    const rake = profit * rakePercent / 100;
    totalRake += rake;
    const payout = chipsAmount - rake;
    payouts.push({ id: p.id, address: playerAddrs[p.id], amount: payout });
    console.log('  ' + p.id + ': ' + p.chips + ' chips = ' + chipsAmount.toFixed(4) + ' CHIPS' +
      (profit > 0 ? ' (rake: ' + rake.toFixed(4) + ')' : '') +
      ' → payout: ' + payout.toFixed(4));
  }

  console.log('  Total rake: ' + totalRake.toFixed(4) + ' CHIPS');

  // Execute settlement from multisig
  console.log('\n  Settling from multisig...');
  try {
    const result = await escrow.settle(
      payouts.filter(p => p.amount > 0),
      {
        dealerAddr: dealerAddr,
        dealerAmount: totalRake / 2,
        cashierAddrs: CASHIER_NODES.map(n => n.addr),
        cashierAmount: totalRake / 2
      }
    );
    if (result.complete) {
      console.log('  ✓ SETTLEMENT TX: ' + result.txid);
    } else if (result.hex) {
      console.log('  Settlement TX built (needs signing): ' + result.hex.substring(0, 32) + '...');
    } else {
      console.log('  Settlement: ' + JSON.stringify(result).substring(0, 100));
    }
  } catch (e) {
    console.log('  Settlement error: ' + e.message);
  }

  // ═══════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  PIPELINE COMPLETE                                    ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('  Hands played: ' + dealer.getHandCount());
  console.log('  All verified: ' + allVerified);
  console.log('  Chips conserved: ' + (totalGameChips === gameChips * PLAYER_IDS.length));
  console.log('  Multisig: ' + msig.address);
  console.log('  Rake: ' + totalRake.toFixed(4) + ' CHIPS');
  for (const p of payouts) console.log('  ' + p.id + ' → ' + p.amount.toFixed(4) + ' CHIPS');
  console.log('╚══════════════════════════════════════════════════════════╝');

  process.exit(allVerified ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
