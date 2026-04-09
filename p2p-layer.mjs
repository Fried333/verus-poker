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

  // ──────────────────────────────────────────────
  // Per-identity write mutex — strictly serializes
  // every write(idName)/writeBatch(idName) so concurrent
  // callers can't race on the same UTXO.
  // ──────────────────────────────────────────────
  const writeChains = new Map(); // idName → Promise (tail of the queue)
  function withIdentityLock(idName, fn) {
    const prev = writeChains.get(idName) || Promise.resolve();
    const next = prev.then(fn, fn); // run regardless of prev result
    // Store but allow GC: replace tail when this completes
    const tail = next.catch(() => {}).finally(() => {
      if (writeChains.get(idName) === tail) writeChains.delete(idName);
    });
    writeChains.set(idName, tail);
    return next;
  }

  async function write(identityId, vdxfKey, data) {
    const idName = identityId.replace('.CHIPS@', '');
    return withIdentityLock(idName, async () => {
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
          // Retry up to 5 times with increasing delays
          for (let retry = 0; retry < 5; retry++) {
            console.log('[P2P] UTXO conflict on ' + idName + ' — retry ' + (retry + 1) + '/5');
            if (prevTx) await waitForTxSpendable(prevTx);
            await new Promise(r => setTimeout(r, 1500 + retry * 500));
            try {
              const txid = await client.writeToIdentity(idName, vdxfKey, serialized);
              lastTxId.set(idName, txid);
              lastWrite.set(idName, Date.now());
              return txid;
            } catch (e2) {
              if (!e2.message.includes('inputs-spent') && !e2.message.includes('conflict')) throw e2;
            }
          }
          throw new Error('UTXO conflict persisted after 5 retries on ' + idName);
        }
        throw e;
      }
    });
  }

  /**
   * Batch write — multiple VDXF keys in ONE updateidentity TX
   * entries: [{ key: 'chips.vrsc::poker.sg777z.xxx', data: {...} }, ...]
   */
  async function writeBatch(identityId, entries) {
    const idName = identityId.replace('.CHIPS@', '');
    return withIdentityLock(idName, async () => {
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
      console.log('[P2P-DEBUG] writeBatch params: name=' + idName + ' parent=' + (parent || 'NONE') + ' keys=' + Object.keys(cmm).length);

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
    });
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

      // PRIMARY: getidentitycontent with heightend=-1 (includes mempool, 0.5s cross-node)
      // Params: [identity, heightstart, heightend, txproofs, txproofheight, vdxfkey]
      const r = await client.call('getidentitycontent', [fullName, 0, -1, false, 0, keyId]);
      const cmm = r?.identity?.contentmultimap;
      if (cmm && cmm[keyId]) {
        const parsed = parseHex(extractHex(cmm[keyId]));
        if (parsed) return deserialize(parsed);
      }

      // Fallback: getidentity — shows latest TX's keys only
      const id = await client.getIdentity(fullName);
      const cmm2 = id?.identity?.contentmultimap;
      if (cmm2 && cmm2[keyId]) {
        const parsed = parseHex(extractHex(cmm2[keyId]));
        if (parsed) return deserialize(parsed);
      }
      return null;
    } catch (e) { return null; }
  }

  async function poll(identityId, vdxfKey, lastKnown, timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const data = await read(identityId, vdxfKey);
      if (data && JSON.stringify(data) !== JSON.stringify(lastKnown)) return data;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
    return null;
  }

  // ──────────────────────────────────────────────
  // Multisig primitives — for phase-multisig funding
  // (additive — does not affect existing code paths)
  // ──────────────────────────────────────────────

  function round8(n) {
    return Math.round(n * 1e8) / 1e8;
  }

  // Compute (and add to wallet) a multisig address from pubkeys + threshold.
  // Returns { address, redeemScript }.
  async function computeMultisigAddress(pubkeys, threshold) {
    if (!Array.isArray(pubkeys) || pubkeys.length < threshold) {
      throw new Error('invalid pubkeys/threshold');
    }
    const ms = await client.call('createmultisig', [threshold, pubkeys]);
    // Also add to local wallet so signrawtransaction knows about it
    try {
      await client.call('addmultisigaddress', [threshold, pubkeys]);
    } catch (e) {
      // May already be added — not fatal
    }
    return { address: ms.address, redeemScript: ms.redeemScript };
  }

  // Get all UTXOs at a given address using the address index (works for any
  // address, including multisig addresses not in the local wallet).
  // Returns: [{ txid, vout, amount, address, script, height }, ...]
  async function getAddressUtxos(addr) {
    const raw = await client.call('getaddressutxos', [{ addresses: [addr] }]);
    return (raw || []).map(u => ({
      txid: u.txid,
      vout: u.outputIndex,
      amount: u.satoshis / 1e8,
      satoshis: u.satoshis,
      address: u.address,
      script: u.script,
      height: u.height,
      isspendable: u.isspendable,
    }));
  }

  // Get total balance at an address (sum of UTXO amounts).
  async function getAddressBalance(addr) {
    const utxos = await getAddressUtxos(addr);
    return utxos.reduce((s, u) => s + u.amount, 0);
  }

  // Wait until at least `expectedCount` UTXOs are visible at `addr` or timeout.
  async function waitForAddressUtxos(addr, expectedCount, timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const utxos = await getAddressUtxos(addr);
      if (utxos.length >= expectedCount) return utxos;
      await new Promise(r => setTimeout(r, 1000));
    }
    return await getAddressUtxos(addr);
  }

  // Compose an unsigned settlement TX that spends specific UTXOs (or ALL if
  // no list given) at the multisig address and creates one output per payout.
  //
  // payouts: [{ address, amount }, ...]
  // explicitUtxos: optional [{ txid, vout, amount }, ...] — if provided, only
  //   these UTXOs are spent; otherwise all UTXOs at msAddr are spent.
  //   This lets the dealer spend only attributed deposits, leaving orphan
  //   UTXOs (e.g., from old test runs or unexpected sources) at the multisig
  //   address for separate recovery.
  //
  // Returns: unsigned hex string.
  async function composeSettlementTx(msAddr, payouts, fee = 0.0001, explicitUtxos = null) {
    const utxos = explicitUtxos || await getAddressUtxos(msAddr);
    if (utxos.length === 0) throw new Error('no UTXOs at ' + msAddr);

    const totalIn = utxos.reduce((s, u) => s + u.amount, 0);
    const totalOut = payouts.reduce((s, p) => s + p.amount, 0);
    const computedFee = round8(totalIn - totalOut);
    if (computedFee < 0) throw new Error(`outputs (${totalOut}) exceed inputs (${totalIn})`);
    if (Math.abs(computedFee - fee) > 0.00000001) {
      console.log('[P2P] composeSettlement: caller fee=' + fee + ' actual fee=' + computedFee);
    }

    const inputs = utxos.map(u => ({ txid: u.txid, vout: u.vout }));
    const outputs = {};
    for (const p of payouts) {
      if (outputs[p.address]) throw new Error('duplicate output address: ' + p.address);
      outputs[p.address] = round8(p.amount);
    }

    return await client.call('createrawtransaction', [inputs, outputs]);
  }

  /**
   * Compose an atomic rotation TX that settles the old multisig AND funds
   * the new multisig in a single transaction.
   *
   * INPUTS:  old multisig UTXOs (M-of-N) + optional new joiner P2PKH UTXOs
   * OUTPUTS: leaver payouts (R-addrs) + new multisig funding
   *
   * Returns: unsigned hex string.
   */
  async function composeAtomicRotationTx({
    oldMultisigUtxos,   // [{txid, vout, amount}]
    leaverPayouts,      // [{address, amount}] — leaving players get paid out
    newMultisigAddr,    // string — the new M'-of-N' address
    newMultisigAmount,  // number — total going into the new multisig
    joinerUtxos,        // [{txid, vout, amount}] — new joiner's P2PKH UTXOs (may be [])
    joinerChange,       // [{address, amount}] — change back to joiners (may be [])
    fee,                // number
  }) {
    const allInputs = [
      ...oldMultisigUtxos.map(u => ({ txid: u.txid, vout: u.vout })),
      ...joinerUtxos.map(u => ({ txid: u.txid, vout: u.vout })),
    ];
    const totalIn = round8(
      oldMultisigUtxos.reduce((s, u) => s + u.amount, 0) +
      joinerUtxos.reduce((s, u) => s + u.amount, 0)
    );
    const totalOut = round8(
      leaverPayouts.reduce((s, p) => s + p.amount, 0) +
      newMultisigAmount +
      joinerChange.reduce((s, c) => s + c.amount, 0)
    );
    const computedFee = round8(totalIn - totalOut);
    if (computedFee < 0) throw new Error('atomic rotation: outputs (' + totalOut + ') exceed inputs (' + totalIn + ')');
    if (Math.abs(computedFee - fee) > 0.001) {
      console.log('[P2P] atomicRotation: expected fee=' + fee + ' actual fee=' + computedFee);
    }

    const outputs = {};
    for (const p of leaverPayouts) {
      if (p.amount <= 0) continue; // skip 0-chip leavers
      outputs[p.address] = round8(p.amount);
    }
    outputs[newMultisigAddr] = round8(newMultisigAmount);
    for (const c of joinerChange) {
      if (c.amount <= 0) continue;
      if (outputs[c.address]) outputs[c.address] = round8(outputs[c.address] + c.amount);
      else outputs[c.address] = round8(c.amount);
    }

    return await client.call('createrawtransaction', [allInputs, outputs]);
  }

  // Sign a multisig TX with the local wallet's available keys.
  // Returns { hex, complete, errors? }.
  // - If `prevTxs` is provided, uses signrawtransaction with explicit prevtxs
  //   (useful when the wallet doesn't have full UTXO history).
  async function signSettlementTx(unsignedHex, prevTxs = null) {
    const params = prevTxs ? [unsignedHex, prevTxs] : [unsignedHex];
    return await client.call('signrawtransaction', params);
  }

  // Combine partial signatures into a single TX.
  //
  // Verus does NOT have combinerawtransaction, so cross-daemon signing must
  // be SEQUENTIAL: each signer signs on top of the previous one's partial.
  //
  // This function works in two modes:
  //
  // 1. Local-wallet mode (all keys in one wallet): pass any partial (or even
  //    an unsigned template) and signrawtransaction will add all available
  //    signatures from the local wallet in one call.
  //
  // 2. Sequential-merge mode (multiple partials each adding one signature):
  //    pass the partials in signing order. The function returns the partial
  //    that has the most signatures already (typically the last one in
  //    the chain). For true distributed signing, you'd want to start with
  //    the unsigned template and have each signer sequentially sign and
  //    publish, with the next signer reading the previous one's published
  //    partial.
  //
  // Returns { hex, complete }.
  async function combinePartials(partialHexes) {
    if (!Array.isArray(partialHexes) || partialHexes.length === 0) {
      throw new Error('no partials to combine');
    }

    // Try each partial in order — the most-signed one will succeed first
    let bestComplete = null;
    let bestPartial = partialHexes[0];

    for (const hex of partialHexes) {
      try {
        const result = await client.call('signrawtransaction', [hex]);
        if (result.complete) {
          // This partial (after local wallet signed) is complete — return it
          return result;
        }
        bestPartial = result.hex;
      } catch (e) {
        // skip invalid partials
      }
    }

    // None were complete on their own. Return the best partial we have.
    // (Production cross-daemon flow: caller passes this partial to the next
    // signer, who signs it and publishes the new version.)
    return { hex: bestPartial, complete: false };
  }

  // Broadcast a fully-signed TX. Returns the txid.
  async function broadcastSettlement(signedHex) {
    return await client.call('sendrawtransaction', [signedHex]);
  }

  // Lock specific UTXOs so the wallet's coin selector won't pick them.
  async function lockUtxos(utxos) {
    if (!Array.isArray(utxos) || utxos.length === 0) return;
    const list = utxos.map(u => ({ txid: u.txid, vout: u.vout }));
    return await client.call('lockunspent', [false, list]);
  }

  // Unlock previously-locked UTXOs.
  async function unlockUtxos(utxos) {
    if (!Array.isArray(utxos) || utxos.length === 0) return;
    const list = utxos.map(u => ({ txid: u.txid, vout: u.vout }));
    return await client.call('lockunspent', [true, list]);
  }

  // Decode an unsigned (or signed) raw transaction. Returns the decoded structure.
  async function decodeRawTx(hex) {
    return await client.call('decoderawtransaction', [hex]);
  }

  // Validate an address and get its pubkey (only works if the wallet owns it).
  async function getAddressPubkey(addr) {
    const v = await client.call('validateaddress', [addr]);
    if (!v.pubkey) throw new Error('no pubkey available for ' + addr + ' (not in wallet?)');
    return v.pubkey;
  }

  return {
    client, myId, tableId, writeBatch,

    // ═══════════════════════════════════════
    // MULTISIG primitives (phase-multisig funding)
    // ═══════════════════════════════════════
    computeMultisigAddress,
    getAddressUtxos,
    getAddressBalance,
    waitForAddressUtxos,
    composeSettlementTx,
    composeAtomicRotationTx,
    signSettlementTx,
    combinePartials,
    broadcastSettlement,
    lockUtxos,
    unlockUtxos,
    decodeRawTx,
    getAddressPubkey,


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
