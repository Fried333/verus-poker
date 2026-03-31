/**
 * End-to-end test: host + 2 clients communicating via z-memos on CHIPS chain
 * Run on server: node test-z-poker.mjs
 */

import { createHost } from './poker-host.mjs';
import { createPokerClient } from './poker-client.mjs';

const RPC = {
  host: '127.0.0.1', port: 22778,
  user: 'user918810440',
  pass: 'passfde4eac81e50dd465529238848a8a77b32c8d17ebb4345c8ebe4150ca3aa9374d1'
};

const HOUSE_ADDR = 'RDGUMRNth3VTdBvkLRCsseHa6VajCjB949';
const P1_ADDR = 'RN2hEjcQ1EcmGGfkGD4JCDNyfT571Eqz64';
const P2_ADDR = 'RECGjSHtaiZ92s3TUtyw3F9kqevwdJ7MtB';

async function main() {
  console.log('=== Verus Poker: z-memo End-to-End Test ===\n');

  // Start host
  const host = await createHost({
    rpcConfig: RPC,
    houseId: 'poker-dealer.CHIPS@',
    houseAddr: HOUSE_ADDR,
    smallBlind: 0.01,
    bigBlind: 0.02,
    minBuyin: 0.5,
    maxPlayers: 2,
    protocol: 'sra',
    handsToPlay: 2,
  });

  // Get table info from host
  const channel = host.getChannel();
  const tableZAddr = channel.getTableAddr();
  const viewingKey = channel.getViewingKey();

  console.log('\nTable z-addr: ' + tableZAddr);
  console.log('Viewing key: ' + viewingKey.substring(0, 40) + '...\n');

  // Start clients (they auto-join and auto-play)
  const client1 = await createPokerClient({
    rpcConfig: RPC,
    playerId: 'poker-p1',
    playerAddr: P1_ADDR,
    tableZAddr,
    viewingKey,
    buyinAmount: 0.5,
    interactive: false
  });

  const client2 = await createPokerClient({
    rpcConfig: RPC,
    playerId: 'poker-p2',
    playerAddr: P2_ADDR,
    tableZAddr,
    viewingKey,
    buyinAmount: 0.5,
    interactive: false
  });

  // Run all concurrently
  console.log('\nStarting game...\n');

  await Promise.all([
    host.run(),
    client1.run(),
    client2.run()
  ]);

  console.log('\n=== Test Complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
