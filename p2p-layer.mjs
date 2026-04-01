/**
 * P2P Layer — blockchain communication for decentralized poker
 * Matches the original C code architecture:
 * - Players write to their own VerusID
 * - Dealer/Cashier write to the Table VerusID
 * - Deck data split per-player (separate VDXF keys)
 * - Game ID appended to keys for multi-game isolation
 */

import { createClient, VDXF_KEYS, gameKey, playerDeckKey } from './verus-rpc.mjs';

const POLL_INTERVAL = 1500;
const WRITE_GAP = 1000; // Min ms between writes (initial delay before checking)

/**
 * Serialize BigInt values for on-chain storage
 */
function serialize(obj) {
  return JSON.parse(JSON.stringify(obj, (k, v) =>
    typeof v === 'bigint' ? '0x' + v.toString(16) : v
  ));
}

function deserialize(obj) {
  if (!obj) return obj;
  return JSON.parse(JSON.stringify(obj), (k, v) => {
    if (typeof v === 'string' && v.startsWith('0x') && v.length > 4) {
      try { return BigInt(v); } catch { return v; }
    }
    return v;
  });
}

export function createP2PLayer(rpcConfig, myId, tableId) {
  const client = createClient(rpcConfig);
  const lastWrite = new Map(); // identity → timestamp of last write

  const lastTxId = new Map(); // identity → last txid written

  async function waitForTxSpendable(txid, maxWait = 30000) {
    // Wait for TX to be in mempool (spendable) — don't need block confirmation
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        await client.getTransaction(txid);
        return true; // TX exists = spendable from mempool
      } catch (e) {
        // TX not found yet — wait
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  async function write(identityId, vdxfKey, data) {
    const idName = identityId.replace('.CHIPS@', '');
    const serialized = serialize(data);

    // Wait for previous write to THIS identity to confirm
    const prevTx = lastTxId.get(idName);
    if (prevTx) {
      await waitForTxSpendable(prevTx);
    }

    try {
      const txid = await client.writeToIdentity(idName, vdxfKey, serialized);
      lastTxId.set(idName, txid);
      lastWrite.set(idName, Date.now());
      console.log('[P2P] Written to ' + idName + ' tx=' + txid.substring(0, 12));
      return txid;
    } catch (e) {
      if (e.message.includes('inputs-spent') || e.message.includes('conflict')) {
        console.log('[P2P] UTXO conflict on ' + idName + ' — waiting...');
        if (prevTx) await waitForTxSpendable(prevTx);
        await new Promise(r => setTimeout(r, 1000)); // Extra 1s for propagation
        const txid = await client.writeToIdentity(idName, vdxfKey, serialized);
        lastTxId.set(idName, txid);
        lastWrite.set(idName, Date.now());
        return txid;
      }
      throw e;
    }
  }

  // Cache VDXF ID lookups
  const vdxfCache = new Map();
  async function resolveVdxfId(keyName) {
    if (vdxfCache.has(keyName)) return vdxfCache.get(keyName);
    const r = await client.getVdxfId(keyName);
    vdxfCache.set(keyName, r.vdxfid);
    return r.vdxfid;
  }

  let recentBlockStart = 0; // Set after first getinfo call

  async function read(identityId, vdxfKey) {
    try {
      const fullName = identityId.includes('.') ? identityId : identityId + '.CHIPS@';
      // Read from recent blocks only — avoids scanning thousands of old entries
      // First call gets current block height, subsequent calls use it
      if (recentBlockStart === 0) {
        try {
          const info = await client.getInfo();
          recentBlockStart = Math.max(0, info.blocks - 200); // Last ~33 minutes
        } catch (e) { recentBlockStart = 0; }
      }
      let content = await client.call('getidentitycontent', [
        fullName, recentBlockStart, -1
      ]);
      let cmm = content.contentmultimap || content.identity?.contentmultimap;
      // If no data in recent range, try reading all (for identities with few entries)
      if (!cmm || Object.keys(cmm).length === 0) {
        content = await client.call('getidentitycontent', [fullName, 0, -1]);
        cmm = content.contentmultimap || content.identity?.contentmultimap;
      }
      if (!cmm) return null;

      // Resolve VDXF key name to i-address and look it up in the result
      const keyId = await resolveVdxfId(vdxfKey);
      const keyData = cmm[keyId];
      if (!keyData) return null;

      // Data can be a hex string or an array of entries
      let hexData;
      if (typeof keyData === 'string') {
        hexData = keyData;
      } else if (Array.isArray(keyData) && keyData.length > 0) {
        const last = keyData[keyData.length - 1];
        hexData = typeof last === 'string' ? last : Object.values(last)[0];
      }
      if (typeof hexData === 'string') {
        return deserialize(JSON.parse(Buffer.from(hexData, 'hex').toString('utf8')));
      }
      return null;
    } catch (e) { return null; }
  }

  async function poll(identityId, vdxfKey, lastKnown, timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const data = await read(identityId, vdxfKey);
      if (data && JSON.stringify(data) !== JSON.stringify(lastKnown)) return data;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
    return null;
  }

  return {
    client, myId, tableId,

    // ═══════════════════════════════════════
    // PLAYER writes to PLAYER'S OWN ID
    // ═══════════════════════════════════════

    /** Player writes their shuffled deck to own ID */
    async writePlayerDeck(gameId, deckData) {
      const key = gameKey(VDXF_KEYS.PLAYER_DECK, gameId);
      console.log('[P2P] ' + myId + ' → own ID: player_deck');
      return write(myId, key, deckData);
    },

    /** Player writes betting action to own ID */
    async writeAction(gameId, action) {
      const key = gameKey(VDXF_KEYS.PLAYER_ACTION, gameId);
      console.log('[P2P] ' + myId + ' → own ID: action=' + action.action);
      return write(myId, key, { ...action, player: myId, timestamp: Date.now() });
    },

    /** Player writes decoded card to own ID */
    async writeDecodedCard(gameId, cardData) {
      const key = gameKey(VDXF_KEYS.DECODED_CARD, gameId);
      return write(myId, key, cardData);
    },

    /** Player writes showdown cards to own ID */
    async writeShowdownCards(gameId, cards) {
      const key = gameKey(VDXF_KEYS.SHOWDOWN_CARDS, gameId);
      return write(myId, key, cards);
    },

    /** Player writes join request to own ID */
    async writeJoin(tableId, buyinTxid) {
      console.log('[P2P] ' + myId + ' → own ID: join request');
      return write(myId, VDXF_KEYS.PLAYER_JOIN, {
        table: tableId, txid: buyinTxid || 'virtual',
        player: myId, timestamp: Date.now()
      });
    },

    // ═══════════════════════════════════════
    // DEALER writes to TABLE ID
    // ═══════════════════════════════════════

    /** Dealer writes table config */
    async writeTableInfo(gameId, config) {
      const key = gameKey(VDXF_KEYS.TABLE_INFO, gameId);
      console.log('[P2P] Dealer → Table: table_info');
      return write(tableId, key, config);
    },

    /** Dealer writes player roster */
    async writePlayerInfo(gameId, players) {
      const key = gameKey(VDXF_KEYS.PLAYER_INFO, gameId);
      return write(tableId, key, players);
    },

    /** Dealer writes game state/phase */
    async writeGameState(gameId, state) {
      const key = gameKey(VDXF_KEYS.GAME_INFO, gameId);
      return write(tableId, key, { ...state, timestamp: Date.now() });
    },

    /** Dealer writes betting state (whose turn, pot, actions) */
    async writeBettingState(gameId, bettingState) {
      const key = gameKey(VDXF_KEYS.BETTING_STATE, gameId);
      return write(tableId, key, bettingState);
    },

    /** Dealer writes their own deck */
    async writeDealerDeck(gameId, deckData) {
      const key = gameKey(VDXF_KEYS.DEALER_DECK, gameId);
      console.log('[P2P] Dealer → Table: dealer_deck');
      return write(tableId, key, deckData);
    },

    /** Dealer writes per-player shuffled deck (split to stay under 5KB) */
    async writeDealerPlayerDeck(gameId, playerNum, deckData) {
      const key = gameKey(playerDeckKey(VDXF_KEYS.DEALER_P_DECK, playerNum), gameId);
      console.log('[P2P] Dealer → Table: dealer_p' + playerNum + '_deck');
      return write(tableId, key, deckData);
    },

    /** Dealer writes board cards */
    async writeBoardCards(gameId, boardData) {
      const key = gameKey(VDXF_KEYS.BOARD_CARDS, gameId);
      return write(tableId, key, boardData);
    },

    /** Dealer writes settlement */
    async writeSettlement(gameId, settlementData) {
      const key = gameKey(VDXF_KEYS.SETTLEMENT, gameId);
      console.log('[P2P] Dealer → Table: settlement');
      return write(tableId, key, settlementData);
    },

    // ═══════════════════════════════════════
    // CASHIER writes to TABLE ID
    // ═══════════════════════════════════════

    /** Cashier writes their own deck */
    async writeCashierDeck(gameId, deckData) {
      const key = gameKey(VDXF_KEYS.BLINDER_DECK, gameId);
      console.log('[P2P] Cashier → Table: blinder_deck');
      return write(tableId, key, deckData);
    },

    /** Cashier writes per-player shuffled deck */
    async writeCashierPlayerDeck(gameId, playerNum, deckData) {
      const key = gameKey(playerDeckKey(VDXF_KEYS.BLINDER_P_DECK, playerNum), gameId);
      console.log('[P2P] Cashier → Table: blinder_p' + playerNum + '_deck');
      return write(tableId, key, deckData);
    },

    /** Cashier writes blinding values for card reveals */
    async writeCardBV(gameId, bvData) {
      const key = gameKey(VDXF_KEYS.CARD_BV, gameId);
      return write(tableId, key, bvData);
    },

    // ═══════════════════════════════════════
    // READ from any identity
    // ═══════════════════════════════════════

    /** Read player's deck from their ID */
    async readPlayerDeck(playerId, gameId) {
      return read(playerId, gameKey(VDXF_KEYS.PLAYER_DECK, gameId));
    },

    /** Read player's action from their ID */
    async readAction(playerId, gameId) {
      return read(playerId, gameKey(VDXF_KEYS.PLAYER_ACTION, gameId));
    },

    /** Read player's join request from their ID */
    async readJoin(playerId) {
      return read(playerId, VDXF_KEYS.PLAYER_JOIN);
    },

    /** Read game state from table ID */
    async readGameState(gameId) {
      return read(tableId, gameKey(VDXF_KEYS.GAME_INFO, gameId));
    },

    /** Read betting state from table ID */
    async readBettingState(gameId) {
      return read(tableId, gameKey(VDXF_KEYS.BETTING_STATE, gameId));
    },

    /** Read dealer's per-player deck from table ID */
    async readDealerPlayerDeck(playerNum, gameId) {
      return read(tableId, gameKey(playerDeckKey(VDXF_KEYS.DEALER_P_DECK, playerNum), gameId));
    },

    /** Read cashier's per-player deck from table ID */
    async readCashierPlayerDeck(playerNum, gameId) {
      return read(tableId, gameKey(playerDeckKey(VDXF_KEYS.BLINDER_P_DECK, playerNum), gameId));
    },

    /** Read card blinding values from table ID */
    async readCardBV(gameId) {
      return read(tableId, gameKey(VDXF_KEYS.CARD_BV, gameId));
    },

    /** Read board cards from table ID */
    async readBoardCards(gameId) {
      return read(tableId, gameKey(VDXF_KEYS.BOARD_CARDS, gameId));
    },

    // ═══════════════════════════════════════
    // POLL (blocking read until change)
    // ═══════════════════════════════════════

    async pollPlayerDeck(playerId, gameId, lastKnown, timeout) {
      return poll(playerId, gameKey(VDXF_KEYS.PLAYER_DECK, gameId), lastKnown, timeout);
    },

    async pollAction(playerId, gameId, lastKnown, timeout) {
      return poll(playerId, gameKey(VDXF_KEYS.PLAYER_ACTION, gameId), lastKnown, timeout);
    },

    async pollGameState(gameId, lastKnown, timeout) {
      return poll(tableId, gameKey(VDXF_KEYS.GAME_INFO, gameId), lastKnown, timeout);
    },

    async pollBettingState(gameId, lastKnown, timeout) {
      return poll(tableId, gameKey(VDXF_KEYS.BETTING_STATE, gameId), lastKnown, timeout);
    },

    async pollCardBV(gameId, lastKnown, timeout) {
      return poll(tableId, gameKey(VDXF_KEYS.CARD_BV, gameId), lastKnown, timeout);
    },

    // Utility
    serialize, deserialize, read, write, poll
  };
}
