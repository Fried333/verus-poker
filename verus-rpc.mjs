/**
 * Verus RPC Client — zero dependencies
 * Talks to verusd via JSON-RPC over HTTP.
 * Handles identity operations, contentmultimap, and fund management.
 */

import { request } from 'http';

/**
 * Create a Verus RPC client
 */
export function createClient(config = {}) {
  const host = config.host || '127.0.0.1';
  const port = config.port || 22778;
  const user = config.user || '';
  const pass = config.pass || '';
  const chain = config.chain || null; // e.g., 'chips' for -chain=chips

  let idCounter = 0;

  async function call(method, params = []) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        jsonrpc: '1.0',
        id: ++idCounter,
        method,
        params
      });

      const auth = Buffer.from(`${user}:${pass}`).toString('base64');

      const req = request({
        hostname: host,
        port,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${auth}`,
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              reject(new Error(`RPC error ${json.error.code}: ${json.error.message}`));
            } else {
              resolve(json.result);
            }
          } catch (e) {
            reject(new Error(`Failed to parse RPC response: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  return {
    call,

    // ============================================================
    // Blockchain basics
    // ============================================================
    getInfo: () => call('getinfo'),
    getBlockCount: () => call('getblockcount'),
    getBalance: (addr) => addr ? call('z_getbalance', [addr]) : call('getbalance'),

    // ============================================================
    // Identity operations
    // ============================================================

    /**
     * Get identity by name or i-address
     */
    getIdentity: (nameOrId) => call('getidentity', [nameOrId]),

    /**
     * Get identity content (contentmultimap data)
     * heightStart: scan from this block height
     * heightEnd: scan to this block height (0 = latest)
     * vdxfKey: optional specific key to filter
     */
    getIdentityContent: (nameOrId, heightStart = 0, heightEnd = 0, txproofs = false, txproofheight = 0, vdxfKey = '') =>
      call('getidentitycontent', [nameOrId, heightStart, heightEnd, txproofs, txproofheight, vdxfKey]),

    /**
     * Update identity — sets/appends contentmultimap data
     */
    updateIdentity: (identity) => call('updateidentity', [identity]),

    /**
     * Check if wallet can sign for an identity
     */
    canSignFor: async (nameOrId) => {
      try {
        const result = await call('signmessage', [nameOrId, 'test']);
        return true;
      } catch (e) {
        return false;
      }
    },

    /**
     * List identities in the wallet
     */
    listIdentities: () => call('listidentities'),

    // ============================================================
    // Contentmultimap helpers
    // ============================================================

    /**
     * Write data to an identity's contentmultimap under a VDXF key.
     * Data is hex-encoded JSON.
     */
    writeToIdentity: async (identityName, vdxfKey, data) => {
      const hexData = Buffer.from(JSON.stringify(data)).toString('hex');
      const vdxfId = await call('getvdxfid', [vdxfKey]);

      // Resolve parent for PBaaS chain IDs
      const idName = identityName.replace('.CHIPS@', '').replace('.chips@', '');
      let parent;
      try {
        const fullName = identityName.includes('.') ? identityName : identityName + '.CHIPS@';
        const idInfo = await call('getidentity', [fullName]);
        parent = idInfo.identity?.parent;
      } catch (e) {}

      const updateParams = { name: idName, contentmultimap: { [vdxfId.vdxfid]: hexData } };
      if (parent) updateParams.parent = parent;

      return call('updateidentity', [updateParams]);
    },

    /**
     * Read data from an identity's contentmultimap.
     * Returns parsed JSON or null.
     */
    readFromIdentity: async (identityName, vdxfKey, fromHeight = 0) => {
      try {
        const fullName = identityName.includes('.') ? identityName : identityName + '.CHIPS@';
        const vdxfId = await call('getvdxfid', [vdxfKey]);
        const content = await call('getidentitycontent', [
          fullName, fromHeight, 0, false, 0, vdxfId.vdxfid
        ]);
        if (!content || !content.contentmultimap) return null;
        // Parse the first matching entry
        const entries = Object.values(content.contentmultimap);
        if (entries.length === 0) return null;
        const firstEntry = entries[0];
        if (Array.isArray(firstEntry) && firstEntry.length > 0) {
          const hexData = Object.values(firstEntry[0])[0];
          if (typeof hexData === 'string') {
            return JSON.parse(Buffer.from(hexData, 'hex').toString('utf8'));
          }
        }
        return content.contentmultimap;
      } catch (e) {
        return null;
      }
    },

    // ============================================================
    // Fund operations
    // ============================================================

    /**
     * Send currency (for payin, payout, escrow)
     */
    sendCurrency: (fromAddr, outputs) =>
      call('sendcurrency', [fromAddr, outputs]),

    /**
     * Get operation status (sendcurrency is async)
     */
    getOperationStatus: (opids) =>
      call('z_getoperationstatus', [opids]),

    /**
     * Wait for an operation to complete
     */
    waitForOperation: async (opid, timeoutMs = 60000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const statuses = await call('z_getoperationstatus', [[opid]]);
        if (statuses && statuses[0]) {
          if (statuses[0].status === 'success') return statuses[0].result;
          if (statuses[0].status === 'failed') throw new Error(`Operation failed: ${JSON.stringify(statuses[0].error)}`);
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      throw new Error('Operation timed out');
    },

    /**
     * Send and wait for completion
     */
    sendAndWait: async (fromAddr, outputs) => {
      const opid = await call('sendcurrency', [fromAddr, outputs]);
      return await client.waitForOperation(opid);
    },

    // ============================================================
    // VDXF helpers
    // ============================================================

    /**
     * Get VDXF ID for a key name
     */
    getVdxfId: (keyName) => call('getvdxfid', [keyName]),

    // ============================================================
    // Transaction monitoring
    // ============================================================

    /**
     * Get transaction details
     */
    getTransaction: (txid) => call('gettransaction', [txid]),

    /**
     * List unspent outputs for addresses
     */
    listUnspent: (minConf = 1, maxConf = 9999999, addresses = []) =>
      call('listunspent', [minConf, maxConf, addresses]),
  };
}

// ============================================================
// Poker-specific VDXF key conventions
// ============================================================
// VDXF key namespace matching the original C code (chips.vrsc::poker.sg777z.*)
// Game ID is appended at runtime: key + '.' + gameId
export const VDXF_KEYS = {
  // Table ID writes (by Dealer)
  TABLE_INFO:     'chips.vrsc::poker.sg777z.t_table_info',
  PLAYER_INFO:    'chips.vrsc::poker.sg777z.t_player_info',
  GAME_INFO:      'chips.vrsc::poker.sg777z.t_game_info',
  GAME_IDS:       'chips.vrsc::poker.sg777z.t_game_ids',
  BETTING_STATE:  'chips.vrsc::poker.sg777z.t_betting_state',
  BOARD_CARDS:    'chips.vrsc::poker.sg777z.t_board_cards',
  SETTLEMENT:     'chips.vrsc::poker.sg777z.t_settlement_info',

  // Dealer deck per player (written to Table ID by Dealer)
  DEALER_DECK:    'chips.vrsc::poker.sg777z.t_d_deck',
  DEALER_P_DECK:  'chips.vrsc::poker.sg777z.t_d_p',  // append player number: t_d_p1_deck, t_d_p2_deck

  // Cashier deck per player (written to Table ID by Cashier)
  BLINDER_DECK:   'chips.vrsc::poker.sg777z.t_b_deck',
  BLINDER_P_DECK: 'chips.vrsc::poker.sg777z.t_b_p',  // append player number: t_b_p1_deck, t_b_p2_deck
  CARD_BV:        'chips.vrsc::poker.sg777z.card_bv',

  // Player ID writes (by Player to their own ID)
  PLAYER_DECK:    'chips.vrsc::poker.sg777z.player_deck',
  PLAYER_ACTION:  'chips.vrsc::poker.sg777z.p_betting_action',
  DECODED_CARD:   'chips.vrsc::poker.sg777z.p_decoded_card',
  SHOWDOWN_CARDS: 'chips.vrsc::poker.sg777z.p_showdown_cards',
  PLAYER_JOIN:    'chips.vrsc::poker.sg777z.p_join_request',
  GAME_HISTORY:   'chips.vrsc::poker.sg777z.p_game_history',

  // Registry
  DEALERS:        'chips.vrsc::poker.sg777z.dealers',
  CASHIERS:       'chips.vrsc::poker.sg777z.cashiers',
};

// Helper: get a game-specific VDXF key
export function gameKey(baseKey, gameId) {
  return baseKey + '.' + gameId;
}

// Helper: get per-player deck key (t_d_p1_deck, t_d_p2_deck, etc.)
export function playerDeckKey(baseKey, playerNum) {
  return baseKey + playerNum + '_deck';
}

// ============================================================
// High-level poker operations
// ============================================================

/**
 * Publish a table listing to the house's VerusID
 */
export async function publishTable(client, houseId, tableConfig) {
  return client.writeToIdentity(houseId, VDXF_KEYS.TABLE_CONFIG, tableConfig);
}

/**
 * Read a table listing from a house's VerusID
 */
export async function readTable(client, houseId) {
  return client.readFromIdentity(houseId, VDXF_KEYS.TABLE_CONFIG);
}

/**
 * Write game state to the table ID
 */
export async function writeGameState(client, tableId, gameState) {
  return client.writeToIdentity(tableId, VDXF_KEYS.GAME_STATE, gameState);
}

/**
 * Read game state from the table ID
 */
export async function readGameState(client, tableId) {
  return client.readFromIdentity(tableId, VDXF_KEYS.GAME_STATE);
}

/**
 * Player submits an action (fold/check/call/raise)
 */
export async function submitAction(client, playerId, action) {
  return client.writeToIdentity(playerId, VDXF_KEYS.PLAYER_ACTION, action);
}

/**
 * Read a player's action
 */
export async function readAction(client, playerId) {
  return client.readFromIdentity(playerId, VDXF_KEYS.PLAYER_ACTION);
}

/**
 * Player requests to join a table
 */
export async function requestJoin(client, playerId, tableId, buyinTxid) {
  return client.writeToIdentity(playerId, VDXF_KEYS.PLAYER_JOIN, {
    table: tableId,
    txid: buyinTxid,
    timestamp: Date.now()
  });
}

/**
 * Poll for game state changes (simple polling loop)
 */
export async function pollForChange(client, identityId, vdxfKey, lastKnown, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await client.readFromIdentity(identityId, vdxfKey);
    if (data && JSON.stringify(data) !== JSON.stringify(lastKnown)) {
      return data;
    }
    await new Promise(r => setTimeout(r, 2000)); // Poll every 2 seconds
  }
  return null; // Timeout
}
