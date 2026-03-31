/**
 * Test P2P Poker — full hand on CHIPS blockchain
 * Runs dealer + players from same wallet (demo mode).
 * All game data written to VerusID contentmultimap.
 *
 * Usage: node test-p2p.mjs [--hands N]
 */

import { createP2PLayer } from './p2p-layer.mjs';
import { createP2PDealer } from './p2p-dealer.mjs';
import { createClient } from './verus-rpc.mjs';

const WAIT = ms => new Promise(r => setTimeout(r, ms));

const RPC = {
  host: '127.0.0.1', port: 22778,
  user: 'user918810440',
  pass: 'passfde4eac81e50dd465529238848a8a77b32c8d17ebb4345c8ebe4150ca3aa9374d1'
};

const TABLE_ID = 'poker-table';
const PLAYER_1 = 'poker-p1';
const PLAYER_2 = 'poker-p2';
const HANDS = parseInt(process.argv.find(a => a.startsWith('--hands='))?.split('=')[1] || '1');

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  P2P Poker — On-Chain End-to-End Test            ║');
  console.log('╚══════════════════════════════════════════════════╝');

  const client = createClient(RPC);
  try {
    const info = await client.getInfo();
    console.log('Chain: ' + info.name + ' Block: ' + info.blocks);
    const bal = await client.call('getbalance');
    console.log('Wallet: ' + bal + ' CHIPS');
  } catch (e) {
    console.log('ERROR: ' + e.message);
    process.exit(1);
  }

  // Create P2P layer
  const p2p = createP2PLayer(RPC, PLAYER_1, TABLE_ID);

  // Auto-play callback
  const localNotify = (event, data) => {
    if (event === 'need_action') {
      const va = data.validActions;
      const act = va.includes('check') ? 'check' : va.includes('call') ? 'call' : 'fold';
      setTimeout(() => data.resolve({ action: act, amount: 0 }), 100);
    }
    if (event === 'hand_complete') {
      console.log('\n  Hand ' + data.hand + ': verified=' + data.verified);
      data.players.forEach(p => console.log('    ' + p.id + ': ' + p.chips + ' chips'));
    }
  };

  // Create dealer
  const dealer = createP2PDealer(p2p, { smallBlind: 1, bigBlind: 2, buyin: 200 }, localNotify);

  // Open table
  console.log('\n[1] Opening table...');
  await dealer.openTable();

  // Add players
  dealer.addSelf(200);
  dealer.addPlayer(PLAYER_2, 200);
  console.log('Players seated');

  // Play hands
  console.log('\n[2] Playing ' + HANDS + ' hand(s) on-chain...\n');
  let allVerified = true;
  const startTime = Date.now();

  for (let h = 0; h < HANDS; h++) {
    const result = await dealer.runHand();
    if (!result || !result.verified) allVerified = false;
    await WAIT(2000);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Summary
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  RESULTS                                         ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('  Hands: ' + dealer.getHandCount());
  console.log('  Verified: ' + allVerified);
  const total = dealer.getPlayers().reduce((s, p) => s + p.chips, 0);
  console.log('  Chips: ' + total + ' (expected ' + (2 * 200) + ')');
  console.log('  Conserved: ' + (total === 400));
  console.log('  Time: ' + elapsed + 's');
  dealer.getPlayers().forEach(p => console.log('  ' + p.id + ': ' + p.chips));
  console.log('╚══════════════════════════════════════════════════╝');

  process.exit(allVerified && total === 400 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
