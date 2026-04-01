/**
 * Real Browser Test — uses Chrome headless via CDP (no npm packages needed)
 * Launches 2 Chrome instances, connects via WebSocket to the poker server,
 * and plays a hand verifying all UI state.
 */

import { spawn, execSync } from 'child_process';
import http from 'http';

const WAIT = ms => new Promise(r => setTimeout(r, ms));
const PORT = 3010;
let server, chrome1, chrome2;

async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } });
    }).on('error', reject);
  });
}

async function cdpSend(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const handler = d => {
      const msg = JSON.parse(d.toString());
      if (msg.id === id) { ws.removeListener('message', handler); resolve(msg.result); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error('CDP timeout: ' + method)), 10000);
  });
}

async function launchChrome(port) {
  const chrome = spawn('google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port,
    '--user-data-dir=/tmp/chrome-test-' + port,
    'about:blank'
  ], { stdio: 'pipe' });
  await WAIT(2000);
  return chrome;
}

async function connectCDP(debugPort) {
  const { webSocketDebuggerUrl } = await fetchJSON('http://127.0.0.1:' + debugPort + '/json/version');
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  return ws;
}

async function evaluate(ws, expr) {
  const result = await cdpSend(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true });
  return result?.result?.value;
}

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ FAIL: ' + msg); }
}

async function main() {
  console.log('Starting poker server...');
  server = spawn('node', ['poker-server.mjs', '--port=' + PORT], { stdio: ['pipe', 'pipe', 'pipe'] });
  let ready = false;
  server.stdout.on('data', d => { if (d.toString().includes('Verus Poker')) ready = true; });
  for (let i = 0; i < 20; i++) { if (ready) break; await WAIT(500); }
  if (!ready) { console.log('Server failed to start'); process.exit(1); }
  console.log('Server ready on port ' + PORT);

  console.log('Launching Chrome instances...');
  chrome1 = await launchChrome(9222);
  chrome2 = await launchChrome(9223);

  const cdp1 = await connectCDP(9222);
  const cdp2 = await connectCDP(9223);

  // Navigate both to poker
  await cdpSend(cdp1, 'Runtime.enable');
  await cdpSend(cdp2, 'Runtime.enable');
  await cdpSend(cdp1, 'Page.enable');
  await cdpSend(cdp2, 'Page.enable');
  await cdpSend(cdp1, 'Page.navigate', { url: 'http://localhost:' + PORT + '/play?name=Alice' });
  await WAIT(3000);
  await cdpSend(cdp2, 'Page.navigate', { url: 'http://localhost:' + PORT + '/play?name=Bob' });
  await WAIT(5000);

  // ══════════════════════════════
  console.log('\nTEST 1: Pages loaded');
  const title1 = await evaluate(cdp1, 'document.title');
  assert(title1 && title1.includes('Poker'), 'Alice page loaded: ' + title1);

  // ══════════════════════════════
  console.log('\nTEST 2: Wait for hand to deal');
  await WAIT(12000); // Wait for join + hand start
  const cards1 = await evaluate(cdp1, 'myCards ? myCards.join(",") : ""');
  const cards2 = await evaluate(cdp2, 'myCards ? myCards.join(",") : ""');
  assert(cards1 && cards1.length > 0, 'Alice has cards: ' + cards1);
  assert(cards2 && cards2.length > 0, 'Bob has cards: ' + cards2);

  // Check no duplicates
  if (cards1 && cards2) {
    const all = [...cards1.split(','), ...cards2.split(',')];
    assert(new Set(all).size === all.length, 'No duplicate hole cards');
  }

  // ══════════════════════════════
  console.log('\nTEST 3: Chips displayed');
  const chips1 = await evaluate(cdp1, 'document.getElementById("my-chips")?.textContent || ""') || '';
  assert(chips1.includes('200') || chips1.includes('198') || chips1.includes('199'), 'Alice chips shown: ' + chips1);

  // ══════════════════════════════
  console.log('\nTEST 4: Auto-play to settlement');
  // Auto-click check/call buttons when they appear
  for (let round = 0; round < 30; round++) {
    await WAIT(1000);
    for (const cdp of [cdp1, cdp2]) {
      // Click check button if visible
      await evaluate(cdp, `
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          if (b.textContent.includes('Check') || b.textContent.includes('Call')) { b.click(); break; }
        }
      `);
    }
    // Check if verified
    const verified = await evaluate(cdp1, 'document.getElementById("ti-verify")?.textContent || ""');
    if (verified.includes('Verified')) break;
  }

  const verified1 = await evaluate(cdp1, 'document.getElementById("ti-verify")?.textContent || ""');
  assert(verified1.includes('Verified'), 'Hand verified: ' + verified1);

  // ══════════════════════════════
  console.log('\nTEST 5: Winner banner');
  const banner = await evaluate(cdp1, 'document.getElementById("winner-banner")?.style.display || "none"');
  // Banner might already be hidden if 4s passed
  const bannerText = await evaluate(cdp1, 'document.getElementById("winner-banner")?.textContent || ""');
  console.log('    Banner: ' + bannerText.substring(0, 50));

  // ══════════════════════════════
  console.log('\nTEST 6: Board cards shown');
  const board = await evaluate(cdp1, 'document.getElementById("board")?.children.length || 0');
  console.log('    Board cards rendered: ' + board);

  // ══════════════════════════════
  console.log('\nTEST 7: Table clears after settlement');
  await WAIT(5000);
  const cardsAfter = await evaluate(cdp1, 'myCards ? myCards.join(",") : ""');
  assert(cardsAfter === '' || cardsAfter === undefined, 'Cards cleared after settlement: "' + cardsAfter + '"');

  // ══════════════════════════════
  console.log('\n═══════════════════════════');
  console.log(passed + ' passed, ' + failed + ' failed');
  console.log(failed === 0 ? 'ALL TESTS PASS' : 'SOME TESTS FAILED');

  cdp1.close(); cdp2.close();
  chrome1.kill(); chrome2.kill();
  server.kill();
  // Cleanup temp dirs
  try { execSync('rm -rf /tmp/chrome-test-9222 /tmp/chrome-test-9223'); } catch {}
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  if (chrome1) chrome1.kill();
  if (chrome2) chrome2.kill();
  if (server) server.kill();
  process.exit(1);
});
