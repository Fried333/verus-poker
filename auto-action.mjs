#!/usr/bin/env node
// Auto-action client: connects to a gui-server WebSocket, responds to action prompts
// with check/call (no raise, no fold). Used for reliability testing.
import { WebSocket } from 'ws';

const url = process.argv[2];
if (!url) { console.error('usage: auto-action.mjs ws://host:port'); process.exit(1); }

let myId = null;

function connect() {
  const ws = new WebSocket(url);
  ws.on('open', () => { console.log('[AUTO] connected to ' + url); });
  ws.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.method !== 'state') return;
      myId = msg.myId || myId;
      if (msg.actions && msg.actions.validActions && msg.actions.validActions.length > 0) {
        const valid = msg.actions.validActions;
        let action;
        if (valid.includes('check')) action = 'check';
        else if (valid.includes('call')) action = 'call';
        else if (valid.includes('fold')) action = 'fold';
        else action = valid[0];
        console.log('[AUTO ' + (myId||'?') + '] turn → ' + action + ' (valid: ' + valid.join(',') + ')');
        ws.send(JSON.stringify({ action }));
      }
    } catch (e) {}
  });
  ws.on('close', () => { console.log('[AUTO] disconnected, reconnecting in 2s'); setTimeout(connect, 2000); });
  ws.on('error', e => { console.log('[AUTO] error: ' + e.message); });
}

connect();
