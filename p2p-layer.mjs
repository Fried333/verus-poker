/**
 * P2P Layer — blockchain communication for decentralized poker
 * Matches the original C code architecture:
 * - Players write to their own VerusID
 * - Dealer/Cashier write to the Table VerusID
 * - Deck data split per-player (separate VDXF keys)
 * - Game ID appended to keys for multi-game isolation
 */

import { createClient, VDXF_KEYS, gameKey, playerDeckKey } from './verus-rpc.mjs';

const POLL_INTERVAL = 1000;
const WRITE_GAP = 1200; // Min ms between writes to same identity

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
    // Wait for TX to be in mempool (spendable locally)
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        await client.getTransaction(txid);
        return true;
      } catch (e) {}
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  async function write(identityId, vdxfKey, data) {
    const idName = identityId.replace('.CHIPS@', '');
    const serialized = serialize(data);

    // Wait for previous write to THIS identity to be in mempool
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
        await new Promise(r => setTimeout(r, 1000));
        const txid = await client.writeToIdentity(idName, vdxfKey, serialized);
        lastTxId.set(idName, txid);
        lastWrite.set(idName, Date.now());
        return txid;
      }
      throw e;
    }
  }

  /**
   * Batch write — multiple VDXF keys in ONE updateidentity TX
   * entries: [{ key: 'chips.vrsc::poker.sg777z.xxx', data: {...} }, ...]
   */
  async function writeBatch(identityId, entries) {
    const idName = identityId.replace('.CHIPS@', '');

    // Wait for previous write to THIS identity
    const prevTx = lastTxId.get(idName);
    if (prevTx) {
      await waitForTxSpendable(prevTx);
    }

    // Resolve parent
    let parent;
    try {
      const fullName = identityId.includes('.') ? identityId : identityId + '.CHIPS@';
      const idInfo = await client.getIdentity(fullName);
      parent = idInfo.identity?.parent;
    } catch (e) {}

    // Build contentmultimap with ALL keys
    const cmm = {};
    for (const entry of entries) {
      const vdxfId = await resolveVdxfId(entry.key);
      const hexData = Buffer.from(JSON.stringify(serialize(entry.data))).toString('hex');
      cmm[vdxfId] = hexData;
    }

    const updateParams = { name: idName, contentmultimap: cmm };
    if (parent) updateParams.parent = parent;

    try {
      const txid = await client.call('updateidentity', [updateParams]);
      lastTxId.set(idName, txid);
      lastWrite.set(idName, Date.now());
      console.log('[P2P] Batch written to ' + idName + ' (' + entries.length + ' keys) tx=' + txid.substring(0, 12));
      return txid;
    } catch (e) {
      if (e.message.includes('inputs-spent') || e.message.includes('conflict')) {
        console.log('[P2P] UTXO conflict on batch ' + idName + ' — retrying...');
        if (prevTx) await waitForTxSpendable(prevTx);
        await new Promise(r => setTimeout(r, 1000));
        const txid = await client.call('updateidentity', [updateParams]);
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

  function extractHex(val) {
    // Extract hex data from a contentmultimap value, taking LAST (newest) element
    const last = Array.isArray(val) ? val[val.length - 1] : val;
    return typeof last === 'string' ? last : (typeof last === 'object' && last !== null ? Object.values(last)[0] : null);
  }

  function parseHex(hex) {
    if (!hex || typeof hex !== 'string') return null;
    try { return JSON.parse(Buffer.from(hex, 'hex').toString('utf8')); } catch { return null; }
  }

  // Cache block height (refreshed every 10s)
  let cachedBlocks = 0;
  let blocksRefreshedAt = 0;
  async function getBlocks() {
    if (Date.now() - blocksRefreshedAt < 10000 && cachedBlocks > 0) return cachedBlocks;
    try { const info = await client.getInfo(); cachedBlocks = info.blocks; blocksRefreshedAt = Date.now(); } catch {}
    return cachedBlocks;
  }

  async function read(identityId, vdxfKey) {
    try {
      const fullName = identityId.includes('.') ? identityId : identityId + '.CHIPS@';
      const keyId = await resolveVdxfId(vdxfKey);
      const blocks = await getBlocks();

      // Pass VDXF key directly to getidentitycontent — filters server-side, much faster
      // Params: [identity, heightstart, heightend, txproofs, txproofheight, vdxfkey]
      const r = await client.call('getidentitycontent', [fullName, Math.max(0, blocks - 50), -1, false, 0, keyId]);
      const cmm = r?.identity?.contentmultimap;
      if (cmm && cmm[keyId]) {
        const parsed = parseHex(extractHex(cmm[keyId]));
        if (parsed) return deserialize(parsed);
      }

      // Fallback: getidentity (only shows latest TX's key, but fast)
      const id = await client.getIdentity(fullName);
      const cmm2 = id?.identity?.contentmultimap;
      if (cmm2 && cmm2[keyId]) {
        const parsed = parseHex(extractHex(cmm2[keyId]));
        if (parsed) return deserialize(parsed);
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
    client, myId, tableId, writeBatch,

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
