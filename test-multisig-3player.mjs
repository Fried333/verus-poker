#!/usr/bin/env node
/**
 * Cross-daemon 3-player phase multisig test.
 *
 * Real end-to-end test on the un-peered test daemons (local, .28, .59)
 * representing pc-player, pplayer2, pdealer2.
 *
 * Flow:
 *   1. Get each player's primary R-address pubkey from their daemon
 *   2. Compute a 2-of-3 multisig from those pubkeys
 *   3. Each daemon sends 10 CHIPS from the player's primary R-address
 *      to the multisig (parallel)
 *   4. Wait for all 3 deposits visible on local
 *   5. Compose a settlement TX (3 inputs, 3 outputs paying back to
 *      the primary R-addresses with simulated final stacks)
 *   6. Sign on local (pc-player's input)
 *   7. Pass to .28 for pplayer2's signature
 *   8. With 2-of-3, the TX should now be complete — verify and broadcast
 *   9. Verify each player's primary R-address received their settlement
 *
 * Each step is timed and reported.
 *
 * Usage: node test-multisig-3player.mjs
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

function findRPC() {
  const paths = [
    join(process.env.HOME, '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf'),
    join(process.env.HOME, '.komodo/CHIPS/CHIPS.conf'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      const conf = readFileSync(p, 'utf8');
      const get = k => (conf.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1];
      if (get('rpcuser') && get('rpcpassword')) {
        return { host: '127.0.0.1', port: parseInt(get('rpcport') || '22778'), user: get('rpcuser'), pass: get('rpcpassword') };
      }
    }
  }
  throw new Error('CHIPS daemon config not found');
}

const localRpc = findRPC();
const localAuth = 'Basic ' + Buffer.from(localRpc.user + ':' + localRpc.pass).toString('base64');

async function localCall(method, params = []) {
  const r = await fetch('http://' + localRpc.host + ':' + localRpc.port + '/', {
    method: 'POST',
    headers: { 'Authorization': localAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error('LOCAL ' + method + ': ' + j.error.message);
  return j.result;
}

function remoteCall(host, method, params = []) {
  // Use ssh to execute curl on the remote host. host is "28" or "59".
  const remoteHost = host === '28' ? '46.225.132.28' : '89.125.50.59';
  const cmd = `ssh -p 2400 -o ConnectTimeout=10 root@${remoteHost} 'CONF=~/.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf; U=$(grep "^rpcuser=" $CONF | cut -d= -f2); P=$(grep "^rpcpassword=" $CONF | cut -d= -f2); PORT=$(grep "^rpcport=" $CONF | cut -d= -f2); curl -s --user "$U:$P" --data-binary ${JSON.stringify(JSON.stringify({method, params})).replace(/'/g, "'\\''")} http://127.0.0.1:$PORT/'`;
  const out = execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const j = JSON.parse(out);
  if (j.error) throw new Error(`REMOTE ${host} ${method}: ${j.error.message}`);
  return j.result;
}

const WAIT = ms => new Promise(r => setTimeout(r, ms));

function round8(n) {
  return Math.round(n * 1e8) / 1e8;
}

function ts() {
  return new Date().toISOString().split('T')[1].slice(0, 12);
}

// Normalize getaddressutxos output to match listunspent shape
async function getUtxosAt(addr, fromCall = localCall) {
  const raw = await fromCall('getaddressutxos', [{ addresses: [addr] }]);
  return raw.map(u => ({
    txid: u.txid,
    vout: u.outputIndex,
    amount: u.satoshis / 1e8,
    address: u.address,
    height: u.height,
  }));
}

function getUtxosAtSync(addr, host) {
  const raw = remoteCall(host, 'getaddressutxos', [{ addresses: [addr] }]);
  return raw.map(u => ({
    txid: u.txid,
    vout: u.outputIndex,
    amount: u.satoshis / 1e8,
    address: u.address,
    height: u.height,
  }));
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

async function main() {
  console.log('═'.repeat(70));
  console.log('3-player phase multisig end-to-end test');
  console.log('═'.repeat(70));

  // ── Step 1: Discover pubkeys for each primary address ──
  log('Step 1: discovering primary R-addresses + pubkeys');

  const pcInfo = await localCall('getidentity', ['pc-player.CHIPS@']);
  const pcAddr = pcInfo.identity.primaryaddresses[0];
  const pcVal = await localCall('validateaddress', [pcAddr]);
  const pcPubkey = pcVal.pubkey;
  log(`  pc-player (local): ${pcAddr} pk=${pcPubkey.slice(0, 16)}...`);

  const ppInfo = remoteCall('28', 'getidentity', ['pplayer2.CHIPS@']);
  const ppAddr = ppInfo.identity.primaryaddresses[0];
  const ppVal = remoteCall('28', 'validateaddress', [ppAddr]);
  const ppPubkey = ppVal.pubkey;
  log(`  pplayer2 (.28):    ${ppAddr} pk=${ppPubkey.slice(0, 16)}...`);

  const pdInfo = remoteCall('59', 'getidentity', ['pdealer2.CHIPS@']);
  const pdAddr = pdInfo.identity.primaryaddresses[0];
  const pdVal = remoteCall('59', 'validateaddress', [pdAddr]);
  const pdPubkey = pdVal.pubkey;
  log(`  pdealer2 (.59):    ${pdAddr} pk=${pdPubkey.slice(0, 16)}...`);

  // Verify each daemon has the corresponding key (ismine = true)
  if (!pcVal.ismine) throw new Error('local does not own pc-player primary key');
  if (!ppVal.ismine) throw new Error('.28 does not own pplayer2 primary key');
  if (!pdVal.ismine) throw new Error('.59 does not own pdealer2 primary key');
  log('  all 3 keys verified as owned by their respective daemons ✓');

  // ── Step 2: Compute 2-of-3 multisig (pubkeys ordered: pc, pp, pd) ──
  log('Step 2: computing 2-of-3 multisig address');

  const t2 = Date.now();
  const ms = await localCall('createmultisig', [2, [pcPubkey, ppPubkey, pdPubkey]]);
  log(`  multisig: ${ms.address}  (${Date.now() - t2}ms)`);
  log(`  redeemScript: ${ms.redeemScript.slice(0, 32)}...`);

  // Add the multisig to each daemon's wallet so it can see deposits
  await localCall('addmultisigaddress', [2, [pcPubkey, ppPubkey, pdPubkey]]);
  remoteCall('28', 'addmultisigaddress', [2, [pcPubkey, ppPubkey, pdPubkey]]);
  remoteCall('59', 'addmultisigaddress', [2, [pcPubkey, ppPubkey, pdPubkey]]);
  log('  multisig address added to all 3 wallets ✓');

  // ── Step 3: Each player deposits 10 CHIPS from their primary address ──
  log('Step 3: each player deposits 10 CHIPS to the multisig');

  // We use sendtoaddress for simplicity. The wallet will pick UTXOs from
  // the wallet automatically. To verify the deposits come from the player's
  // primary R-address, we'd need to use createrawtransaction explicitly,
  // but for the test this is sufficient — the deposits are still attributable
  // by checking the source TX inputs after the fact.

  const t3 = Date.now();
  const depositPromises = [
    (async () => {
      const tx = await localCall('sendtoaddress', [ms.address, 10]);
      log(`  pc-player deposited 10 CHIPS → ${tx.slice(0, 16)} (${Date.now() - t3}ms)`);
      return { player: 'pc-player', tx };
    })(),
    (async () => {
      const tx = remoteCall('28', 'sendtoaddress', [ms.address, 10]);
      log(`  pplayer2 deposited 10 CHIPS → ${tx.slice(0, 16)} (${Date.now() - t3}ms)`);
      return { player: 'pplayer2', tx };
    })(),
    (async () => {
      const tx = remoteCall('59', 'sendtoaddress', [ms.address, 10]);
      log(`  pdealer2 deposited 10 CHIPS → ${tx.slice(0, 16)} (${Date.now() - t3}ms)`);
      return { player: 'pdealer2', tx };
    })(),
  ];
  const deposits = await Promise.all(depositPromises);
  const tDeposit = Date.now() - t3;
  log(`  all 3 deposits broadcast (${tDeposit}ms)`);

  // ── Step 4: Wait for all 3 deposits to be visible on local ──
  log('Step 4: waiting for all 3 deposits visible on local');

  const t4 = Date.now();
  let utxos = [];
  while (Date.now() - t4 < 60000) {
    utxos = await getUtxosAt(ms.address);
    if (utxos.length >= 3) break;
    await WAIT(500);
  }
  if (utxos.length < 3) throw new Error(`Only ${utxos.length}/3 deposits visible on local after 60s`);
  log(`  all 3 deposits visible at multisig (${Date.now() - t4}ms after broadcast batch)`);
  const totalBalance = utxos.reduce((s, u) => s + u.amount, 0);
  log(`  total multisig balance: ${totalBalance} CHIPS`);

  // ── Step 5: Wait for cross-daemon visibility (each daemon sees all 3) ──
  log('Step 5: cross-daemon visibility check');

  for (const [host, label] of [['28', 'pplayer2'], ['59', 'pdealer2']]) {
    const t5 = Date.now();
    let remoteUtxos = [];
    while (Date.now() - t5 < 60000) {
      try {
        remoteUtxos = getUtxosAtSync(ms.address, host);
        if (remoteUtxos.length >= 3) break;
      } catch (e) {}
      await WAIT(1000);
    }
    if (remoteUtxos.length < 3) {
      log(`  ⚠ ${label} (.${host}) only sees ${remoteUtxos.length}/3 after 60s`);
    } else {
      log(`  ✓ ${label} (.${host}) sees all 3 deposits (${Date.now() - t5}ms)`);
    }
  }

  // ── Step 6: Compose settlement TX ──
  log('Step 6: composing settlement (simulating final stacks)');
  // Simulate: pc-player won (got 50% of pot), pplayer2 lost (got 25%), pdealer2 lost (got 25%)
  // Use actual multisig balance, not assumed 30
  const fee = 0.0001;
  const pcShare = round8(totalBalance * 0.5 - fee / 3);
  const ppShare = round8(totalBalance * 0.25 - fee / 3);
  const pdShare = round8(totalBalance - pcShare - ppShare - fee);
  log(`  proposed payouts: pc=${pcShare} pp=${ppShare} pd=${pdShare} (sum=${round8(pcShare + ppShare + pdShare)})`);
  log(`  multisig balance:  ${totalBalance} (sum + fee should equal balance)`);

  const inputs = utxos.map(u => ({ txid: u.txid, vout: u.vout }));
  const outputs = { [pcAddr]: pcShare, [ppAddr]: ppShare, [pdAddr]: pdShare };

  const t6 = Date.now();
  const rawTx = await localCall('createrawtransaction', [inputs, outputs]);
  log(`  unsigned raw TX created (${Date.now() - t6}ms, ${rawTx.length / 2} bytes)`);

  // ── Step 7: Sign on local with pc-player's key ──
  log('Step 7: signing on local (1 of 3 sigs)');

  const t7 = Date.now();
  const localSigned = await localCall('signrawtransaction', [rawTx]);
  log(`  local signed (${Date.now() - t7}ms), complete=${localSigned.complete}`);
  if (localSigned.complete) {
    log('  NOTE: local has all 3 keys in its wallet — we need to verify cross-daemon signing.');
    log('  Continuing with the local-complete TX for now to validate the flow.');
  }

  // ── Step 7b: Try cross-daemon partial signing ──
  // To properly test cross-daemon signing, we need to ensure local does NOT
  // have all 3 keys. Let's check what's in local's wallet.
  const localOwnsPp = (await localCall('validateaddress', [ppAddr])).ismine;
  const localOwnsPd = (await localCall('validateaddress', [pdAddr])).ismine;
  log(`  local owns pplayer2 key: ${localOwnsPp}`);
  log(`  local owns pdealer2 key: ${localOwnsPd}`);

  if (localOwnsPp && localOwnsPd) {
    log('  ⚠ local has all 3 keys — true cross-daemon signing not testable here.');
    log('  Falling back to validate the local-complete signature is broadcastable.');
  } else {
    // Cross-daemon signing flow
    log('Step 7c: passing partial sig to .28 for pplayer2 signature');
    const t7c = Date.now();
    const signed28 = remoteCall('28', 'signrawtransaction', [localSigned.hex]);
    log(`  .28 signed (${Date.now() - t7c}ms), complete=${signed28.complete}`);
    if (!signed28.complete && !localOwnsPd) {
      log('Step 7d: passing partial sig to .59 for pdealer2 signature');
      const t7d = Date.now();
      const signed59 = remoteCall('59', 'signrawtransaction', [signed28.hex]);
      log(`  .59 signed (${Date.now() - t7d}ms), complete=${signed59.complete}`);
      localSigned.hex = signed59.hex;
      localSigned.complete = signed59.complete;
    } else {
      localSigned.hex = signed28.hex;
      localSigned.complete = signed28.complete;
    }
  }

  if (!localSigned.complete) {
    throw new Error('Could not gather threshold signatures');
  }

  // ── Step 8: Broadcast settlement ──
  log('Step 8: broadcasting settlement');
  const t8 = Date.now();
  const settleTxid = await localCall('sendrawtransaction', [localSigned.hex]);
  log(`  broadcast in ${Date.now() - t8}ms — txid=${settleTxid}`);

  // ── Step 9: Verify each player received their payout ──
  log('Step 9: verifying each player received their settlement');

  const t9 = Date.now();
  // Local pc-player
  let pcGot = 0;
  while (Date.now() - t9 < 60000) {
    const u = await getUtxosAt(pcAddr);
    pcGot = u.filter(x => x.txid === settleTxid).reduce((s, x) => s + x.amount, 0);
    if (pcGot > 0) break;
    await WAIT(1000);
  }
  log(`  pc-player received ${pcGot} CHIPS (expected ${pcShare}) — ${pcGot === pcShare ? 'PASS' : 'FAIL'}`);

  // .28 pplayer2
  const t9b = Date.now();
  let ppGot = 0;
  while (Date.now() - t9b < 60000) {
    const u = getUtxosAtSync(ppAddr, '28');
    ppGot = u.filter(x => x.txid === settleTxid).reduce((s, x) => s + x.amount, 0);
    if (ppGot > 0) break;
    await WAIT(1000);
  }
  log(`  pplayer2 received ${ppGot} CHIPS (expected ${ppShare}) — ${ppGot === ppShare ? 'PASS' : 'FAIL'}`);

  // .59 pdealer2
  const t9c = Date.now();
  let pdGot = 0;
  while (Date.now() - t9c < 60000) {
    const u = getUtxosAtSync(pdAddr, '59');
    pdGot = u.filter(x => x.txid === settleTxid).reduce((s, x) => s + x.amount, 0);
    if (pdGot > 0) break;
    await WAIT(1000);
  }
  log(`  pdealer2 received ${pdGot} CHIPS (expected ${pdShare}) — ${pdGot === pdShare ? 'PASS' : 'FAIL'}`);

  console.log('\n' + '═'.repeat(70));
  console.log('TEST COMPLETE');
  console.log('═'.repeat(70));
}

main().catch(e => { console.error('FATAL:', e.message); if (e.stack) console.error(e.stack); process.exit(1); });
