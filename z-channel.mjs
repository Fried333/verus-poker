/**
 * z-Channel — communication layer using z-transaction memos
 * Send game data as z-memos to a shared z-address.
 * Read via viewing key from mempool (instant) or chain (confirmed).
 */

import { createClient } from './verus-rpc.mjs';
import { createHash } from 'crypto';

/**
 * Create a z-channel for a poker table
 */
export function createZChannel(rpcConfig) {
  const client = createClient(rpcConfig);
  let tableZAddr = null;
  let viewingKey = null;
  let lastSeenTxids = new Set();
  let seqNum = 0;

  return {
    /**
     * Create a new table z-address (house calls this)
     */
    async createTable() {
      tableZAddr = await client.call('z_getnewaddress', []);
      viewingKey = await client.call('z_exportviewingkey', [tableZAddr]);
      return { zAddr: tableZAddr, viewingKey };
    },

    /**
     * Join a table by importing the viewing key (players call this)
     */
    async joinTable(zAddr, vk) {
      tableZAddr = zAddr;
      viewingKey = vk;
      try {
        await client.call('z_importviewingkey', [vk, 'no']);
      } catch (e) {
        // May already be imported
        if (!e.message.includes('already')) throw e;
      }
    },

    /**
     * Send a message to the table z-address
     * fromAddr: sender's t-address (identifies the sender)
     */
    async send(fromAddr, data) {
      if (!tableZAddr) throw new Error('Not connected to table');

      const msg = { ...data, seq: seqNum++, ts: Date.now() };
      const json = JSON.stringify(msg);

      if (json.length > 500) {
        throw new Error('Message too large for memo: ' + json.length + ' bytes (max ~500)');
      }

      const memoHex = Buffer.from(json).toString('hex');
      const opid = await client.call('z_sendmany', [
        fromAddr,
        [{ address: tableZAddr, amount: 0.0001, memo: memoHex }],
        0  // minconf=0 allows spending unconfirmed outputs
      ]);

      // Wait for operation to complete
      const result = await client.waitForOperation(opid, 30000);
      return { txid: result.txid, seq: msg.seq };
    },

    /**
     * Send a large message split across multiple memos
     */
    async sendLarge(fromAddr, data) {
      const json = JSON.stringify(data);
      const chunks = [];
      const chunkSize = 450; // Leave room for metadata
      const totalParts = Math.ceil(json.length / chunkSize);
      const msgId = createHash('sha256').update(json).digest('hex').substring(0, 8);

      for (let i = 0; i < totalParts; i++) {
        const chunk = json.substring(i * chunkSize, (i + 1) * chunkSize);
        chunks.push({
          _multi: true,
          _id: msgId,
          _part: i + 1,
          _total: totalParts,
          _data: chunk
        });
      }

      const txids = [];
      for (const chunk of chunks) {
        const result = await this.send(fromAddr, chunk);
        txids.push(result.txid);
      }
      return { txids, parts: totalParts };
    },

    /**
     * Read all new messages from the table z-address
     * Returns messages not yet seen, in order
     */
    async receive() {
      if (!tableZAddr) throw new Error('Not connected to table');

      const notes = await client.call('z_listunspent', [0, 9999999, false, [tableZAddr]]);
      const messages = [];

      for (const note of notes) {
        if (lastSeenTxids.has(note.txid)) continue;
        lastSeenTxids.add(note.txid);

        let memoHex = note.memo.replace(/0+$/, '');
        if (memoHex.length % 2) memoHex += '0';

        try {
          const json = Buffer.from(memoHex, 'hex').toString('utf8');
          const msg = JSON.parse(json);
          messages.push({
            ...msg,
            _txid: note.txid,
            _confirmations: note.confirmations,
            _amount: note.amount
          });
        } catch {
          // Not valid JSON — skip
        }
      }

      // Sort by sequence number
      messages.sort((a, b) => (a.seq || 0) - (b.seq || 0));
      return messages;
    },

    /**
     * Reassemble multi-part messages
     */
    reassemble(messages) {
      const multiParts = {};
      const singleMessages = [];

      for (const msg of messages) {
        if (msg._multi) {
          const id = msg._id;
          if (!multiParts[id]) multiParts[id] = {};
          multiParts[id][msg._part] = msg._data;
          multiParts[id]._total = msg._total;
        } else {
          singleMessages.push(msg);
        }
      }

      // Reassemble complete multi-part messages
      for (const [id, parts] of Object.entries(multiParts)) {
        const total = parts._total;
        let complete = true;
        let json = '';
        for (let i = 1; i <= total; i++) {
          if (!parts[i]) { complete = false; break; }
          json += parts[i];
        }
        if (complete) {
          try {
            singleMessages.push(JSON.parse(json));
          } catch { /* corrupt */ }
        }
      }

      return singleMessages;
    },

    /**
     * Poll for new messages with a callback
     */
    async poll(callback, intervalMs = 1000) {
      while (true) {
        const messages = await this.receive();
        const reassembled = this.reassemble(messages);
        for (const msg of reassembled) {
          await callback(msg);
        }
        await new Promise(r => setTimeout(r, intervalMs));
      }
    },

    getTableAddr() { return tableZAddr; },
    getViewingKey() { return viewingKey; },
    getClient() { return client; }
  };
}
