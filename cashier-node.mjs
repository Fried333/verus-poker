/**
 * Cashier Node — runs independently, watches for games, verifies, signs settlements
 *
 * Responsibilities:
 * 1. Watch table ID for shuffle requests
 * 2. Run Stage III (cashier shuffle + blind + SSS distribution)
 * 3. After each hand, verify the full game trace
 * 4. Vote to approve/slash settlement
 * 5. Sign multisig payout if approved
 *
 * Usage: node cashier-node.mjs --id poker-cn1 --addr RGK7nWZ...
 */

import { createClient } from './verus-rpc.mjs';
import { cashierShuffle, verifyGame } from './protocol.mjs';
import { createHash } from 'crypto';

const WAIT = ms => new Promise(r => setTimeout(r, ms));

const RPC = {
  host: '127.0.0.1', port: 22778,
  user: 'user918810440',
  pass: 'passfde4eac81e50dd465529238848a8a77b32c8d17ebb4345c8ebe4150ca3aa9374d1'
};

const PARENT = 'iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP';

/**
 * Create a cashier node
 */
export function createCashierNode(config) {
  const {
    nodeId,          // e.g. 'poker-cn1'
    nodeAddr,        // Cashier node's t-address
    tableId = 'poker-table',
    sssThreshold = 2,
    pollInterval = 5000,
  } = config;

  const client = createClient(RPC);
  let running = true;
  let lastProcessedHand = 0;
  const verificationLog = [];

  // VDXF key cache
  const vdxfCache = {};
  async function getVdxfId(keyName) {
    if (!vdxfCache[keyName]) {
      const result = await client.call('getvdxfid', [keyName]);
      vdxfCache[keyName] = result.vdxfid;
    }
    return vdxfCache[keyName];
  }

  async function writeToId(idName, vdxfKeyName, data) {
    const vdxfId = await getVdxfId(vdxfKeyName);
    const hexData = Buffer.from(JSON.stringify(data)).toString('hex');
    try {
      return await client.call('updateidentity', [{
        name: idName,
        parent: PARENT,
        contentmultimap: { [vdxfId]: hexData }
      }]);
    } catch (e) {
      console.log('[' + nodeId + '] Write failed: ' + e.message);
      return null;
    }
  }

  async function readFromId(idFullName, vdxfKeyName) {
    try {
      const result = await client.call('getidentitycontent', [idFullName, 0, -1]);
      const cmm = result?.identity?.contentmultimap || {};
      const vdxfId = await getVdxfId(vdxfKeyName);
      const values = cmm[vdxfId];
      if (!values) return null;
      const hexStr = Array.isArray(values) ? values[values.length - 1] : values;
      const rawHex = typeof hexStr === 'object' ? Object.values(hexStr)[0] : hexStr;
      return JSON.parse(Buffer.from(rawHex, 'hex').toString('utf8'));
    } catch {
      return null;
    }
  }

  return {
    /**
     * Process a shuffle request — Stage III of the protocol
     */
    async processShuffle(dealerBlindedDecks, numPlayers, numCards) {
      console.log('[' + nodeId + '] Processing Stage III shuffle...');

      const result = cashierShuffle(dealerBlindedDecks, numPlayers, numCards, sssThreshold);

      console.log('[' + nodeId + '] Shuffle complete. Commitment: ' +
        result.cashierCommitment.substring(0, 16) + '...');

      // Write cashier data to our node ID
      const cashierUpdate = {
        node: nodeId,
        commitment: result.cashierCommitment,
        timestamp: Date.now()
      };
      const tx = await writeToId(nodeId, 'vrsc::poker.cashier.shuffle', cashierUpdate);
      console.log('[' + nodeId + '] Wrote shuffle result. TX: ' + (tx ? tx.substring(0, 16) + '...' : 'failed'));

      return result;
    },

    /**
     * Verify a completed hand — Algorithm 4
     */
    async verifyHand(playerData, dealerData, cashierData, numCards, handNum) {
      console.log('[' + nodeId + '] Verifying hand ' + handNum + '...');

      const result = verifyGame(playerData, dealerData, cashierData, numCards);

      const vote = {
        node: nodeId,
        hand: handNum,
        verified: result.valid,
        errors: result.errors,
        vote: result.valid ? 'PAY' : 'SLASH',
        timestamp: Date.now()
      };

      // Write vote to our node ID
      const tx = await writeToId(nodeId, 'vrsc::poker.cashier.vote', vote);
      console.log('[' + nodeId + '] Vote: ' + vote.vote +
        (result.valid ? '' : ' (errors: ' + result.errors.join(', ') + ')') +
        ' TX: ' + (tx ? tx.substring(0, 16) + '...' : 'failed'));

      verificationLog.push(vote);
      return vote;
    },

    /**
     * Watch for games and process automatically
     */
    async watch() {
      console.log('[' + nodeId + '] Watching table ' + tableId + ' for games...');

      while (running) {
        try {
          // Check for new game state
          const gameState = await readFromId(tableId + '.CHIPS@', 'vrsc::poker.game.state');

          if (gameState && gameState.hand > lastProcessedHand) {
            console.log('[' + nodeId + '] New game detected: hand ' + gameState.hand);
            lastProcessedHand = gameState.hand;

            // Check for dealer shuffle data
            const dealerData = await readFromId(tableId + '.CHIPS@', 'vrsc::poker.deck.dealer');
            if (dealerData && dealerData.state === 'DECK_SHUFFLED_DEALER') {
              console.log('[' + nodeId + '] Dealer shuffle found, processing Stage III...');
              // In production: read actual dealer blinded decks and run cashierShuffle
              // For now just acknowledge
            }

            // Check for settlement request
            const settlement = await readFromId(tableId + '.CHIPS@', 'vrsc::poker.settlement');
            if (settlement && settlement.hand === gameState.hand) {
              console.log('[' + nodeId + '] Settlement request for hand ' + settlement.hand);
              // Verify and vote
              if (settlement.verified) {
                const vote = {
                  node: nodeId,
                  hand: settlement.hand,
                  vote: 'PAY',
                  timestamp: Date.now()
                };
                await writeToId(nodeId, 'vrsc::poker.cashier.vote', vote);
                console.log('[' + nodeId + '] Voted PAY for hand ' + settlement.hand);
              }
            }
          }
        } catch (e) {
          // Silently retry
        }

        await WAIT(pollInterval);
      }
    },

    /**
     * Stop watching
     */
    stop() { running = false; },

    /**
     * Get verification history
     */
    getLog() { return verificationLog; },

    /**
     * Get node info
     */
    getInfo() { return { nodeId, nodeAddr, processedHands: lastProcessedHand }; }
  };
}

// ────────────────────────────────────────
// Standalone test — run both cashier nodes
// ────────────────────────────────────────
if (process.argv[1]?.includes('cashier-node')) {
  (async () => {
    console.log('╔════════════════════════════════════════╗');
    console.log('║  Cashier Node Test (2 nodes)            ║');
    console.log('╚════════════════════════════════════════╝');

    const client = createClient(RPC);
    const info = await client.getInfo();
    console.log('Chain: ' + info.name + ' Block: ' + info.blocks + '\n');

    // Create 2 cashier nodes
    const cn1 = createCashierNode({
      nodeId: 'poker-cn1',
      nodeAddr: 'RGK7nWZX1dwJYpqmK7YnSBuExWwCoskhLu'
    });

    const cn2 = createCashierNode({
      nodeId: 'poker-cn2',
      nodeAddr: 'RCGLeG88wArw5ins9LaEmYTtiN8v2t8Pat'
    });

    // Simulate a shuffle request
    const { playerInit, dealerShuffle } = await import('./protocol.mjs');
    const numCards = 14;
    const numPlayers = 2;

    console.log('=== Simulating Protocol ===\n');

    // Player init
    const players = [];
    for (let i = 0; i < numPlayers; i++) {
      players.push(playerInit(numCards, 'player-' + i));
    }
    console.log('Players initialized\n');

    // Dealer shuffle
    const dealer = dealerShuffle(players, numCards);
    console.log('Dealer shuffled\n');

    // Both cashier nodes process Stage III independently
    console.log('--- Cashier Node 1 ---');
    const cashier1 = await cn1.processShuffle(dealer.blindedDecks, numPlayers, numCards);

    await WAIT(12000); // Wait for UTXO

    console.log('\n--- Cashier Node 2 ---');
    const cashier2 = await cn2.processShuffle(dealer.blindedDecks, numPlayers, numCards);

    // Both verify
    console.log('\n--- Verification ---');

    await WAIT(12000);

    const vote1 = await cn1.verifyHand(players, dealer, cashier1, numCards, 1);

    await WAIT(12000);

    const vote2 = await cn2.verifyHand(players, dealer, cashier2, numCards, 1);

    // Check consensus
    console.log('\n=== Settlement Consensus ===');
    console.log('Node 1: ' + vote1.vote);
    console.log('Node 2: ' + vote2.vote);

    const bothApprove = vote1.vote === 'PAY' && vote2.vote === 'PAY';
    console.log('Consensus: ' + (bothApprove ? '2-of-2 APPROVED → SETTLE' : 'DISPUTED'));

    console.log('\nDone.');
  })();
}
