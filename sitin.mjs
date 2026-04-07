#!/usr/bin/env node
// Send sitin message to a gui-server WebSocket
import { WebSocket } from 'ws';
const url = process.argv[2];
if (!url) { console.error('usage: sitin.mjs ws://host:port'); process.exit(1); }
const ws = new WebSocket(url);
ws.on('open', () => {
  ws.send(JSON.stringify({ action: 'sitin' }));
  setTimeout(() => { ws.close(); process.exit(0); }, 1000);
});
ws.on('error', e => { console.error('ws error:', e.message); process.exit(1); });
