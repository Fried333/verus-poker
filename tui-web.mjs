#!/usr/bin/env node
/**
 * Web TUI — serves the TUI poker player in a browser
 * Spawns tui-player.mjs as a child process, streams its terminal output
 * to a browser via WebSocket. Browser input is piped back to the TUI's stdin.
 *
 * Usage: node tui-web.mjs --id=pc-player --table=poker-table --port=4000
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.substring(2).split('=');
    return [k, v || true];
  })
);
const PORT = parseInt(args.port || '4000');
const TUI_ARGS = process.argv.slice(2).filter(a => a !== '--port=' + PORT && !a.startsWith('--port='));

// ══════════════════════════════════════
// ANSI → HTML converter
// ══════════════════════════════════════
function ansiToHtml(text) {
  const colors = {
    '0': '</span>', '1': '<span style="font-weight:bold">', '2': '<span style="opacity:0.5">',
    '31': '<span style="color:#ef5350">', '32': '<span style="color:#66bb6a">',
    '33': '<span style="color:#ffd54f">', '36': '<span style="color:#4dd0e1">',
    '37': '<span style="color:#fff">'
  };
  return text
    .replace(/\x1b\[2J\x1b\[H/g, '') // strip clear screen
    .replace(/\x1b\[([0-9;]+)m/g, (_, codes) => {
      return codes.split(';').map(c => colors[c] || '').join('');
    });
}

// ══════════════════════════════════════
// HTML page
// ══════════════════════════════════════
const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>CHIPS Poker TUI</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; display: flex; justify-content: center; align-items: center; min-height: 100vh; font-family: monospace; }
  #terminal {
    background: #0d1117; color: #c9d1d9; padding: 20px; border-radius: 8px;
    font-size: 16px; line-height: 1.4; white-space: pre; min-width: 600px;
    border: 1px solid #30363d; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
  }
  #input-area {
    margin-top: 10px; display: flex; gap: 8px; align-items: center;
  }
  #input-area input {
    background: #21262d; color: #c9d1d9; border: 1px solid #30363d;
    padding: 8px 12px; font-family: monospace; font-size: 14px;
    border-radius: 4px; width: 200px; outline: none;
  }
  #input-area input:focus { border-color: #4dd0e1; }
  .btn {
    padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;
    font-family: monospace; font-size: 13px; font-weight: bold;
  }
  .btn-fold { background: #ef5350; color: #fff; }
  .btn-check { background: #66bb6a; color: #000; }
  .btn-call { background: #42a5f5; color: #fff; }
  .btn-raise { background: #ffd54f; color: #000; }
  .btn-allin { background: #ab47bc; color: #fff; }
  .btn:hover { opacity: 0.85; }
  #status { color: #666; font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<div>
  <div id="terminal">Connecting...</div>
  <div id="input-area">
    <button class="btn btn-fold" onclick="send('f')">Fold</button>
    <button class="btn btn-check" onclick="send('c')">Check/Call</button>
    <button class="btn btn-raise" onclick="sendRaise()">Raise</button>
    <input id="raise-amt" type="number" value="2" min="2" placeholder="amount">
    <button class="btn btn-allin" onclick="send('a')">All In</button>
  </div>
  <div id="status">Connecting to TUI...</div>
</div>
<script>
const term = document.getElementById('terminal');
const status = document.getElementById('status');
let ws;

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host);
  ws.onopen = () => { status.textContent = 'Connected'; };
  ws.onmessage = e => {
    term.innerHTML = e.data;
    // Auto-scroll
    term.scrollTop = term.scrollHeight;
  };
  ws.onclose = () => { status.textContent = 'Disconnected — reconnecting...'; setTimeout(connect, 2000); };
  ws.onerror = () => {};
}

function send(cmd) {
  if (ws && ws.readyState === 1) ws.send(cmd);
}

function sendRaise() {
  const amt = document.getElementById('raise-amt').value || '2';
  send('r ' + amt);
}

// Keyboard shortcut: type in terminal
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'f') send('f');
  else if (e.key === 'c') send('c');
  else if (e.key === 'a') send('a');
});

connect();
</script>
</body>
</html>`;

// ══════════════════════════════════════
// Server
// ══════════════════════════════════════
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(HTML);
});

const wss = new WebSocketServer({ server });
let tuiProcess = null;
let lastOutput = 'Starting TUI...';

function startTUI() {
  const tuiArgs = ['tui-player.mjs', ...TUI_ARGS];
  console.log('Starting TUI: node ' + tuiArgs.join(' '));

  tuiProcess = spawn('node', tuiArgs, {
    cwd: __dirname,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' }
  });

  let buffer = '';
  tuiProcess.stdout.on('data', d => {
    buffer += d.toString();
    // Split on clear screen sequences
    const screens = buffer.split('\x1b[2J\x1b[H');
    if (screens.length > 1) {
      // Keep the last complete screen
      lastOutput = ansiToHtml(screens[screens.length - 1]);
      buffer = '';
      // Send to all connected browsers
      for (const ws of wss.clients) {
        if (ws.readyState === 1) ws.send(lastOutput);
      }
    }
  });

  tuiProcess.stderr.on('data', d => {
    console.error('TUI stderr:', d.toString());
  });

  tuiProcess.on('exit', (code) => {
    console.log('TUI exited with code ' + code);
    lastOutput = '<span style="color:#ef5350">TUI process exited. Restarting in 3s...</span>';
    for (const ws of wss.clients) {
      if (ws.readyState === 1) ws.send(lastOutput);
    }
    setTimeout(startTUI, 3000);
  });
}

wss.on('connection', ws => {
  console.log('Browser connected');
  // Send current state
  ws.send(lastOutput);

  // Pipe browser input to TUI stdin
  ws.on('message', data => {
    const cmd = data.toString().trim();
    if (tuiProcess && tuiProcess.stdin.writable) {
      tuiProcess.stdin.write(cmd + '\n');
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Web TUI at http://localhost:' + PORT);
  startTUI();
});

// Cleanup
process.on('SIGINT', () => {
  if (tuiProcess) tuiProcess.kill();
  process.exit(0);
});
process.on('SIGTERM', () => {
  if (tuiProcess) tuiProcess.kill();
  process.exit(0);
});
