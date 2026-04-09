#!/usr/bin/env node
/**
 * Test: atomic rotation with a JOINER — 1-player phase adds a 2nd player.
 * One TX: old 1-of-1 multisig (player A) + joiner B's personal UTXO →
 *         new 2-of-2 multisig funded with both players' stakes.
 *
 * Usage: node test-atomic-join.mjs
 */
import { createP2PLayer } from './p2p-layer.mjs';
import { createP2PDealer } from './p2p-dealer.mjs';
import { createPlayerBackend } from './player-backend.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

function findRPC() {
  const paths = [join(process.env.HOME, '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf')];
  for (const p of paths) {
    if (existsSync(p)) {
      const conf = readFileSync(p, 'utf8');
      const get = k => (conf.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1];
      if (get('rpcuser') && get('rpcpassword'))
        return { host: '127.0.0.1', port: parseInt(get('rpcport') || '22778'), user: get('rpcuser'), pass: get('rpcpassword') };
    }
  }
  throw new Error('CHIPS daemon config not found');
}

const WAIT = ms => new Promise(r => setTimeout(r, ms));
const ts = () => Date.now();
const rpc = findRPC();
const TABLE_ID = 'cashier1';
const PLAYER_A = 'cashier1';
const PLAYER_B = 'pc-player';

const results = [];
function record(name, status, info = {}) {
  results.push({ name, status, ...info });
  const tag = status === 'PASS' ? '\u2713' : status === 'FAIL' ? '\u2717' : '\u00b7';
  console.log('  [' + tag + '] ' + name + (info.note ? ' \u2014 ' + info.note : ''));
}

async function main() {
  console.log('='.repeat(70));
  console.log('Test: atomic rotation with JOINER (1→2 players)');
  console.log('='.repeat(70));

  const p2pDealer = createP2PLayer(rpc, TABLE_ID, TABLE_ID);
  const dealer = createP2PDealer(p2pDealer, { smallBlind: 0.001, bigBlind: 0.002, buyin: 0.1, cashiers: [] }, () => {});
  const playerA = createPlayerBackend(createP2PLayer(rpc, PLAYER_A, TABLE_ID), PLAYER_A, TABLE_ID, { phaseMultisig: true });
  const playerB = createPlayerBackend(createP2PLayer(rpc, PLAYER_B, TABLE_ID), PLAYER_B, TABLE_ID, { phaseMultisig: true });

  const info = await p2pDealer.client.call('getinfo', []);
  console.log('Chain: ' + info.name + ' block ' + info.blocks);

  // Setup: phase with ONLY player A (1-of-1)
  console.log('\n--- Setup: 1-player phase (A only) ---');
  await dealer.openTable();
  await WAIT(2000);
  await playerA.sitIn(0);
  await WAIT(5000);

  const KEYS = { JOIN_REQUEST: 'chips.vrsc::poker.sg777z.p_join_request' };
  const joinA = await p2pDealer.read(PLAYER_A, KEYS.JOIN_REQUEST);
  if (!joinA?.payAddr) { console.log('FATAL: missing A payAddr'); process.exit(1); }

  const rosterA = [{ id: PLAYER_A, payAddr: joinA.payAddr, pubkey: joinA.pubkey, expectedDeposit: 0.1 }];
  const phase = await dealer.openPhase(rosterA, 1);
  dealer.addPlayer(PLAYER_A, 0.1);

  const mA = await playerA.readPhaseManifest(phase.phase);
  await playerA.depositToPhase(mA, joinA.payAddr);
  const conf = await dealer.waitForPhaseDeposits(120000);
  if (!conf) { console.log('FATAL: deposits timeout'); process.exit(1); }
  record('1-player phase opened + deposited', 'PASS', { note: phase.phase });

  // Now player B wants to join
  console.log('\n--- Atomic rotation: B joins (1→2) ---');
  await playerB.sitIn(1);
  await WAIT(5000);
  const joinB = await p2pDealer.read(PLAYER_B, KEYS.JOIN_REQUEST);
  if (!joinB?.payAddr) { console.log('FATAL: missing B payAddr'); process.exit(1); }

  // Build new roster (A continues + B joins)
  const newRoster = [
    { id: PLAYER_A, payAddr: joinA.payAddr, pubkey: joinA.pubkey, expectedDeposit: 0 },
    { id: PLAYER_B, payAddr: joinB.payAddr, pubkey: joinB.pubkey, expectedDeposit: 0.1 },
  ];

  // Build joiner intent for B: read B's UTXOs and select enough
  const bUtxos = await p2pDealer.getAddressUtxos(joinB.payAddr);
  const bSorted = [...bUtxos].filter(u => u.amount > 0).sort((a, b) => b.amount - a.amount);
  let bSelected = []; let bAcc = 0;
  for (const u of bSorted) { bSelected.push(u); bAcc += u.amount; if (bAcc >= 0.1001) break; }
  if (bAcc < 0.1001) { console.log('FATAL: B insufficient funds:', bAcc); process.exit(1); }

  const joinerIntents = [{
    id: PLAYER_B, payAddr: joinB.payAddr,
    utxos: bSelected, depositAmount: 0.1
  }];

  const t0 = ts();
  console.log('  t0=0ms  compose atomic rotation with joiner');

  const proposal = await dealer.composeAtomicRotation(newRoster, 2, joinerIntents);
  const t1 = ts();
  console.log('  t1=' + (t1 - t0) + 'ms  proposal published');
  record('proposal published', proposal ? 'PASS' : 'FAIL', { note: 'type=' + proposal?.type });

  // Player B (joiner) signs FIRST — their P2PKH inputs
  await playerB.autoRespondToCashouts([phase.phase]);
  const t2 = ts();
  console.log('  t2=' + (t2 - t0) + 'ms  joiner B signed');

  // Player A (continuing, old signer) signs on top — multisig input
  await playerA.autoRespondToCashouts([phase.phase]);
  const t3 = ts();
  console.log('  t3=' + (t3 - t0) + 'ms  old signer A signed');

  // Finalize
  const result = await dealer.finalizeCashout(60000);
  const t4 = ts();
  console.log('  t4=' + (t4 - t0) + 'ms  settlement broadcast');

  record('settlement broadcast', result.ok ? 'PASS' : 'FAIL', { note: result.txid?.slice(0, 16) || result.reason });

  if (result.ok) {
    dealer.activateAtomicPhase();
    record('new 2-player phase activated', 'PASS');

    await WAIT(3000);
    const tx = await p2pDealer.client.call('getrawtransaction', [result.txid, 1]);
    console.log('\n  Settlement TX outputs:');
    for (const v of tx.vout) {
      const addrs = v.scriptPubKey?.addresses || [];
      console.log('    vout ' + v.n + ': ' + v.value + ' → ' + addrs.join(', '));
    }

    // New multisig should have A's 0.1 + B's 0.1 = 0.2 (minus fee)
    const msOut = tx.vout.find(v => (v.scriptPubKey?.addresses || []).includes(proposal.newMultisigAddr));
    record('new multisig funded (A+B combined)', msOut ? 'PASS' : 'FAIL', { note: msOut ? msOut.value + ' CHIPS' : 'no output' });

    // Check B's change output exists (if any)
    const bChange = tx.vout.find(v => (v.scriptPubKey?.addresses || []).includes(joinB.payAddr));
    if (bChange) console.log('  B change: ' + bChange.value + ' CHIPS');

    console.log('\n  Total rotation: ' + (t4 - t0) + 'ms (' + ((t4 - t0) / 1000).toFixed(1) + 's)');
  }

  console.log('\n' + '='.repeat(70));
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  console.log('PASS: ' + pass + '   FAIL: ' + fail);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });
