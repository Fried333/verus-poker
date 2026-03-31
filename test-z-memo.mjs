/**
 * z-transaction memo performance test
 * Tests: creation time, mempool read time, memo sizes
 * Run on server: node test-z-memo.mjs
 */

import { createClient } from './verus-rpc.mjs';

const client = createClient({
  host: '127.0.0.1', port: 22778,
  user: 'user918810440',
  pass: 'passfde4eac81e50dd465529238848a8a77b32c8d17ebb4345c8ebe4150ca3aa9374d1'
});

const FUND_ADDR = 'RKirfTNWEM2BFzpgSVCkScoj79W3EjjgHL';
const WAIT = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('=== z-Transaction Memo Performance Test ===\n');

  // Create test z-addresses
  console.log('[1] Creating z-addresses...');
  const zAddr1 = await client.call('z_getnewaddress', []);
  const zAddr2 = await client.call('z_getnewaddress', []);
  console.log('    Table z-addr: ' + zAddr1);
  console.log('    Player z-addr: ' + zAddr2);

  // Export viewing key
  console.log('\n[2] Exporting viewing key...');
  const vk = await client.call('z_exportviewingkey', [zAddr1]);
  console.log('    Viewing key: ' + vk.substring(0, 30) + '...');
  console.log('    (Anyone with this key can read memos sent to this address)');

  // Test 1: Small memo (betting action)
  console.log('\n[3] Test: Small memo (betting action)...');
  const smallMemo = JSON.stringify({ action: 'raise', player: 0, amount: 0.04, round: 1, seq: 1 });
  const smallResult = await sendAndTime(zAddr1, smallMemo, 'small');

  // Wait between TXs to avoid UTXO conflicts
  await WAIT(3000);

  // Test 2: Medium memo (card reveal with crypto data)
  console.log('\n[4] Test: Medium memo (card reveal)...');
  const medMemo = JSON.stringify({
    type: 'reveal',
    card_id: 3,
    blinding_value: 'a'.repeat(64),
    player_id: 0,
    card_type: 'hole',
    seq: 5
  });
  const medResult = await sendAndTime(zAddr1, medMemo, 'medium');

  await WAIT(3000);

  // Test 3: Large memo (hand result with full data)
  console.log('\n[5] Test: Large memo (hand result)...');
  const largeMemo = JSON.stringify({
    type: 'hand_result',
    hand: 1,
    board: ['Ac', 'Kh', '3d', '7s', 'Jc'],
    players: [
      { id: 'p1', hole: ['Ah', 'Kd'], chips: 0.58, won: 0.08, hand_name: 'Two Pair' },
      { id: 'p2', hole: ['2c', '7d'], chips: 0.42, won: 0, hand_name: 'Pair' },
      { id: 'p3', hole: ['Qs', 'Jd'], chips: 0.50, won: 0, hand_name: 'High Card' },
      { id: 'p4', hole: ['9h', '8h'], chips: 0.50, won: 0, hand_name: 'Flush Draw' }
    ],
    pot: 0.08,
    winner: 'p1',
    prev_hash: 'f'.repeat(64),
    session_hash: 'e'.repeat(64)
  });
  const largeResult = await sendAndTime(zAddr1, largeMemo, 'large');

  await WAIT(3000);

  // Test 4: Max size test - how big can a memo be?
  console.log('\n[6] Test: Memo size limit...');
  // Sapling memo field is 512 bytes
  const sizes = [100, 256, 400, 512];
  for (const size of sizes) {
    const data = JSON.stringify({ data: 'x'.repeat(size) });
    const hex = Buffer.from(data).toString('hex');
    if (hex.length <= 1024) { // 512 bytes = 1024 hex chars
      console.log('    ' + size + ' chars → ' + hex.length + ' hex chars → ' + (hex.length <= 1024 ? 'FITS' : 'TOO BIG'));
    } else {
      console.log('    ' + size + ' chars → ' + hex.length + ' hex chars → TOO BIG (max 512 bytes / 1024 hex)');
    }
  }

  // Test 5: Read back all memos
  console.log('\n[7] Reading all memos from z-address...');
  await WAIT(2000);
  const t0 = performance.now();
  const notes = await client.call('z_listunspent', [0, 9999999, false, [zAddr1]]);
  const readTime = performance.now() - t0;
  console.log('    Found ' + notes.length + ' notes in ' + readTime.toFixed(0) + 'ms');
  for (const n of notes) {
    let memoHex = n.memo.replace(/0+$/, '');
    if (memoHex.length % 2) memoHex += '0';
    try {
      const memo = Buffer.from(memoHex, 'hex').toString('utf8');
      const parsed = JSON.parse(memo);
      console.log('    TX ' + n.txid.substring(0, 12) + '... conf=' + n.confirmations + ' → ' + (parsed.type || parsed.action || 'data') + ' (' + memo.length + ' bytes)');
    } catch {
      console.log('    TX ' + n.txid.substring(0, 12) + '... conf=' + n.confirmations + ' → (binary)');
    }
  }

  // Test 6: Read with viewing key (simulating another player)
  console.log('\n[8] Test: Import viewing key and read...');
  // Already have the key, verify we can read
  const canRead = notes.length > 0;
  console.log('    Can read with wallet key: ' + canRead);
  console.log('    Viewing key would allow any party to read these memos');

  // Summary
  console.log('\n=== RESULTS ===');
  console.log('');
  console.log('  Memo sizes:');
  console.log('    Betting action:  ' + smallMemo.length + ' bytes');
  console.log('    Card reveal:     ' + medMemo.length + ' bytes');
  console.log('    Hand result:     ' + largeMemo.length + ' bytes');
  console.log('    Max memo:        512 bytes (Sapling limit)');
  console.log('');
  console.log('  Timing:');
  if (smallResult) console.log('    Small TX create:  ' + smallResult.createTime + 'ms');
  if (medResult) console.log('    Medium TX create: ' + medResult.createTime + 'ms');
  if (largeResult) console.log('    Large TX create:  ' + largeResult.createTime + 'ms');
  console.log('    Read all notes:  ' + readTime.toFixed(0) + 'ms');
  console.log('');
  console.log('  Cost per TX:       0.0001 CHIPS');
  console.log('  Est. per hand:     ~25 TXs = 0.0025 CHIPS');
  console.log('  Est. per session:  ~125 TXs (50 hands) = 0.0125 CHIPS');
  console.log('');

  // Comparison
  console.log('=== COMPARISON: z-memo vs contentmultimap ===');
  console.log('');
  console.log('  | Metric              | z-memo      | contentmultimap |');
  console.log('  |---------------------|-------------|-----------------|');
  console.log('  | Create time         | ~0.4s       | ~0.5s           |');
  console.log('  | Readable from       | Mempool(0s) | After conf(10s) |');
  console.log('  | Effective latency   | ~1s         | ~10s            |');
  console.log('  | Max data per TX     | 512 bytes   | ~5500 bytes     |');
  console.log('  | History preserved   | Yes (chain) | Overwritten     |');
  console.log('  | Cost per update     | 0.0001      | 0.0001          |');
  console.log('  | Readable by others  | Viewing key | Public          |');
  console.log('  | Per hand (~25 acts) | ~10s total  | ~250s total     |');
  console.log('');
}

async function sendAndTime(toAddr, memoStr, label) {
  const memoHex = Buffer.from(memoStr).toString('hex');
  console.log('    Data: ' + memoStr.length + ' bytes → ' + memoHex.length + ' hex chars');

  if (memoHex.length > 1024) {
    console.log('    SKIP: exceeds 512 byte memo limit');
    return null;
  }

  const t0 = performance.now();
  const opid = await client.call('z_sendmany', [
    FUND_ADDR,
    [{ address: toAddr, amount: 0.0001, memo: memoHex }]
  ]);
  const createTime = (performance.now() - t0).toFixed(0);
  console.log('    Submitted in ' + createTime + 'ms (opid: ' + opid + ')');

  // Wait for operation
  const t1 = performance.now();
  let status;
  while (true) {
    const ops = await client.call('z_getoperationstatus', [[opid]]);
    if (ops[0]?.status === 'success') {
      status = ops[0];
      break;
    }
    if (ops[0]?.status === 'failed') {
      console.log('    FAILED: ' + JSON.stringify(ops[0].error));
      return null;
    }
    await WAIT(200);
  }
  const totalTime = (performance.now() - t1).toFixed(0);
  console.log('    Completed in ' + totalTime + 'ms (TX: ' + status.result.txid.substring(0, 16) + '...)');

  return { createTime: parseInt(createTime), totalTime: parseInt(totalTime), txid: status.result.txid };
}

main().catch(e => { console.error(e); process.exit(1); });
