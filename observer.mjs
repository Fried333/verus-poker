#!/usr/bin/env node
/**
 * Chain Observer — polls poker-table identity and logs when each VDXF key changes
 * Run on a THIRD node to see propagation timing independently.
 *
 * Usage: node observer.mjs --rpcuser=X --rpcpass=Y [--rpcport=22778]
 */
import { request } from 'http';

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.substring(2).split('=');
    return [k, v || true];
  })
);

const RPC = {
  host: '127.0.0.1',
  port: parseInt(args.rpcport || '22778'),
  user: args.rpcuser || '',
  pass: args.rpcpass || ''
};

const T0 = Date.now();
const ts = () => ((Date.now() - T0) / 1000).toFixed(2);

async function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '1.0', id: 1, method, params });
    const auth = Buffer.from(RPC.user + ':' + RPC.pass).toString('base64');
    const req = request({ hostname: RPC.host, port: RPC.port, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { const j = JSON.parse(d); if (j.error) reject(new Error(j.error.message)); else resolve(j.result); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

async function resolveKey(keyName) {
  const r = await rpc('getvdxfid', [keyName]);
  return r.vdxfid;
}

console.log('OBSERVER starting on ' + RPC.host + ':' + RPC.port);
const info = await rpc('getinfo');
console.log('Block: ' + info.blocks + '\n');

console.log(ts().padStart(8) + 's | OBSERVER | KEY                    | VALUE SUMMARY');
console.log('─────────┼──────────┼────────────────────────┼─────────────────────────────────');

// Keys to watch
const keyNames = [
  'chips.vrsc::poker.sg777z.t_table_info',
  'chips.vrsc::poker.sg777z.t_betting_state',
  'chips.vrsc::poker.sg777z.t_board_cards',
  'chips.vrsc::poker.sg777z.t_settlement_info',
  'chips.vrsc::poker.sg777z.card_bv',
];

// Resolve all key IDs
const keyIds = {};
for (const kn of keyNames) {
  keyIds[kn] = await resolveKey(kn);
}

// Track last seen value per key
const lastSeen = {};

async function poll() {
  try {
    const blocks = (await rpc('getinfo')).blocks;
    // Read ALL keys at once from getidentitycontent
    const r = await rpc('getidentitycontent', ['poker-table.CHIPS@', Math.max(0, blocks - 20), -1]);
    const cmm = r?.identity?.contentmultimap;
    if (!cmm) return;

    for (const [keyName, keyId] of Object.entries(keyIds)) {
      const val = cmm[keyId];
      if (!val) continue;

      // Get last entry
      const last = Array.isArray(val) ? val[val.length - 1] : val;
      const hex = typeof last === 'string' ? last : (typeof last === 'object' ? Object.values(last)[0] : null);
      if (!hex || typeof hex !== 'string') continue;

      const json = JSON.stringify(hex).substring(0, 20); // fingerprint
      if (lastSeen[keyName] === json) continue; // unchanged
      lastSeen[keyName] = json;

      // Parse the data
      let data;
      try { data = JSON.parse(Buffer.from(hex, 'hex').toString('utf8')); } catch { continue; }

      // Format summary based on key type
      const short = keyName.split('.').pop();
      let summary = '';
      if (short === 't_table_info') summary = 'session=' + (data.session||'?') + ' handId=' + (data.currentHandId||'none');
      else if (short === 't_betting_state' || keyName.includes('betting')) summary = 'turn=' + (data.turn||'?') + ' phase=' + (data.phase||'?') + ' pot=' + (data.pot||0);
      else if (short === 't_board_cards' || keyName.includes('board')) summary = (data.phase||'?') + ': ' + (data.board||[]).join(' ');
      else if (short === 't_settlement_info' || keyName.includes('settlement')) summary = 'verified=' + data.verified + ' hand=' + data.hand;
      else if (keyName.includes('card_bv')) summary = 'player=' + (data.player||'?') + ' cards=' + (data.cards||[]).join(' ');
      else summary = JSON.stringify(data).substring(0, 60);

      console.log(ts().padStart(8) + 's | OBSERVER | ' + short.padEnd(22) + ' | ' + summary);
    }

    // Also check hand-specific keys if we know the handId
    if (lastSeen._handId) {
      const hid = lastSeen._handId;
      // Check board_cards and settlement (single key per hand)
      for (const base of ['t_board_cards', 't_settlement_info']) {
        const fullKey = 'chips.vrsc::poker.sg777z.' + base + '.' + hid;
        try {
          const kid = await resolveKey(fullKey);
          const val = cmm[kid];
          if (!val) continue;
          const last = Array.isArray(val) ? val[val.length - 1] : val;
          const hex = typeof last === 'string' ? last : (typeof last === 'object' ? Object.values(last)[0] : null);
          if (!hex) continue;
          const fp = JSON.stringify(hex).substring(0, 20);
          const trackKey = base + '.' + hid;
          if (lastSeen[trackKey] === fp) continue;
          lastSeen[trackKey] = fp;
          let data;
          try { data = JSON.parse(Buffer.from(hex, 'hex').toString('utf8')); } catch { continue; }
          let summary = '';
          if (base === 't_board_cards') summary = (data.phase||'?') + ': ' + (data.board||[]).join(' ');
          else if (base === 't_settlement_info') summary = 'verified=' + data.verified + ' hand=' + data.hand;
          console.log(ts().padStart(8) + 's | OBSERVER | ' + (base+'.'+hid.substring(0,8)).padEnd(22) + ' | ' + summary);
        } catch {}
      }
      // Check sequential betting_state keys (s0, s1, s2, ...)
      if (!lastSeen._bsSeq) lastSeen._bsSeq = {};
      if (!lastSeen._bsSeq[hid]) lastSeen._bsSeq[hid] = -1;
      for (let seq = lastSeen._bsSeq[hid] + 1; seq < lastSeen._bsSeq[hid] + 20; seq++) {
        const fullKey = 'chips.vrsc::poker.sg777z.t_betting_state.' + hid + '.s' + seq;
        try {
          const kid = await resolveKey(fullKey);
          const val = cmm[kid];
          if (!val) break; // No more sequential keys
          const last = Array.isArray(val) ? val[val.length - 1] : val;
          const hex = typeof last === 'string' ? last : (typeof last === 'object' ? Object.values(last)[0] : null);
          if (!hex) break;
          let data;
          try { data = JSON.parse(Buffer.from(hex, 'hex').toString('utf8')); } catch { break; }
          lastSeen._bsSeq[hid] = seq;
          const summary = 'seq=' + seq + ' turn=' + (data.turn||'?') + ' phase=' + (data.phase||'?') + ' pot=' + (data.pot||0);
          console.log(ts().padStart(8) + 's | OBSERVER | ' + ('BS.s'+seq).padEnd(22) + ' | ' + summary);
        } catch { break; }
      }
    }

    // Track handId for hand-specific polling
    const tiKey = keyIds['chips.vrsc::poker.sg777z.t_table_info'];
    if (cmm[tiKey]) {
      const last = Array.isArray(cmm[tiKey]) ? cmm[tiKey][cmm[tiKey].length-1] : cmm[tiKey];
      const hex = typeof last === 'string' ? last : Object.values(last)[0];
      try {
        const d = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
        if (d.currentHandId) lastSeen._handId = d.currentHandId;
      } catch {}
    }
  } catch (e) {
    console.log(ts().padStart(8) + 's | OBSERVER | ERROR | ' + e.message);
  }
}

// Poll every 1s
while (true) {
  await poll();
  await new Promise(r => setTimeout(r, 1000));
}
