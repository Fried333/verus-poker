#!/usr/bin/env node
/**
 * Playwright GUI test with Node.js WebSocket bot for remote player.
 * - Local GUI via Playwright (pc-player)
 * - Remote player via Node.js WebSocket (pplayer2 on .28)
 */

import { chromium } from 'playwright';
import WebSocket from 'ws';

const LOCAL_URL = 'http://localhost:3000';
const REMOTE_WS = 'ws://46.225.132.28:3001';
const REMOTE_NAME = 'pplayer2';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════
// Remote bot — connects via WebSocket, auto check/call
// ══════════════════════════════════════
function startRemoteBot() {
  return new Promise((resolve) => {
    let botActions = 0;
    let acted = false;  // Guard: only act once per turn
    let lastHandCount = 0;
    const ws = new WebSocket(REMOTE_WS);

    ws.on('open', () => {
      console.log('[BOT] Connected to .28');
      ws.send(JSON.stringify({ action: 'join', name: REMOTE_NAME }));
      resolve({ ws, getActions: () => botActions });
    });

    ws.on('message', data => {
      try {
        const m = JSON.parse(data.toString());

        // Reset acted flag when hand changes or turn changes away
        if (m.method === 'fullstate') {
          if (m.handCount && m.handCount !== lastHandCount) {
            acted = false;
            lastHandCount = m.handCount;
          }
          // If no actions for us, reset so we can act next time
          if (!m.actions || (m.actions.possibilities || m.actions.validActions || []).length === 0) {
            acted = false;
          }
        }

        // Handle fullstate — check for action buttons (act ONCE)
        if (m.method === 'fullstate' && m.actions && !acted) {
          const va = m.actions.possibilities || m.actions.validActions || [];
          let action;
          if (va.includes(1) || va.includes('check')) action = 'check';
          else if (va.includes(2) || va.includes('call')) action = 'call';
          else if (va.includes(0) || va.includes('fold')) action = 'fold';
          if (action) {
            acted = true;
            ws.send(JSON.stringify({ action }));
            botActions++;
            console.log('[BOT] ' + action + ' (#' + botActions + ')');
          }
        }

        // Handle old-style betting turn (act ONCE)
        if (m.method === 'betting' && m.action === 'round_betting' && m.turnPlayer === REMOTE_NAME && !acted) {
          const poss = m.possibilities || [];
          let action;
          if (poss.includes(1) || poss.includes('check')) action = 'check';
          else if (poss.includes(2) || poss.includes('call')) action = 'call';
          else if (poss.includes(0) || poss.includes('fold')) action = 'fold';
          if (action) {
            acted = true;
            ws.send(JSON.stringify({ action }));
            botActions++;
            console.log('[BOT] ' + action + ' (#' + botActions + ')');
          }
        }

        // When it's no longer our turn (action was processed), allow acting again on next turn
        if (m.method === 'betting' && m.action !== 'round_betting') {
          acted = false;
        }
      } catch {}
    });

    ws.on('error', e => console.log('[BOT] Error: ' + e.message));
    ws.on('close', () => console.log('[BOT] Disconnected'));
  });
}

// ══════════════════════════════════════
// Main test
// ══════════════════════════════════════
async function test() {
  console.log('=== GUI Test: Playwright + WebSocket Bot ===\n');

  // Start remote bot
  console.log('[1] Starting remote bot for ' + REMOTE_NAME + '...');
  const bot = await startRemoteBot();
  await sleep(3000);

  // Open local GUI
  console.log('[2] Opening local GUI...');
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto(LOCAL_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });

  let handsPlayed = 0, localActions = 0;

  // Wait for seats
  console.log('[3] Waiting for seats to render...');
  for (let i = 0; i < 120; i++) {
    const seats = await page.$$eval('.seat', s => s.length).catch(() => 0);
    if (seats >= 2) {
      console.log('  Seats: ' + seats + ' (after ' + i + 's)');
      break;
    }
    if (i % 15 === 0) console.log('  Waiting... (' + i + 's)');
    await sleep(1000);
  }

  await page.screenshot({ path: '/tmp/gui-test-initial.png' });

  // Play hands
  console.log('\n[4] Playing hands...\n');

  for (let hand = 0; hand < 10; hand++) {
    console.log('--- Hand ' + (hand + 1) + ' ---');

    let handDone = false;
    for (let tick = 0; tick < 120 && !handDone; tick++) {
      // Check local for buttons
      const btns = await page.$$eval('#controls button', b => b.map(x => x.textContent.trim())).catch(() => []);
      if (btns.length > 0) {
        // Click check > call > fold
        const check = await page.$('button.btn-check');
        const call = await page.$('button.btn-call');
        const fold = await page.$('button.btn-fold');
        let action = '';
        if (check) { await check.click(); action = 'Check'; }
        else if (call) { await call.click(); action = 'Call'; }
        else if (fold) { await fold.click(); action = 'Fold'; }
        if (action) {
          localActions++;
          console.log('  [local] ' + action + ' (' + btns.join(', ') + ')');
        }
        await sleep(2000);
        continue;
      }

      // Check if hand ended
      const ended = await page.evaluate(() => {
        const banner = document.getElementById('winner-banner');
        const wait = document.querySelector('.wait-text');
        const wt = wait ? wait.textContent : '';
        return (banner && banner.style.display !== 'none') || wt.includes('verified') || wt.includes('next');
      }).catch(() => false);

      if (ended) {
        handDone = true;
        handsPlayed++;
        console.log('  Hand ' + (hand + 1) + ' done!');
        await page.screenshot({ path: '/tmp/gui-test-h' + (hand+1) + '.png' });
      }

      await sleep(2000);
    }

    if (!handDone) {
      console.log('  Timed out');
      await page.screenshot({ path: '/tmp/gui-test-h' + (hand+1) + '-timeout.png' });
      break;
    }

    // Wait for next hand
    await sleep(8000);
  }

  // Final — verify status shows on ALL players
  console.log('\n[5] Status verification...');

  // Check local GUI status
  const localStatus = await page.evaluate(() => {
    const controls = document.getElementById('controls');
    const actionLog = document.getElementById('action-log');
    const handInfo = document.getElementById('hand-info');
    const potDisplay = document.getElementById('pot-display');
    const tiHand = document.getElementById('ti-hand');
    const tiVerify = document.getElementById('ti-verify');
    const banner = document.getElementById('winner-banner');
    return {
      controls: controls?.textContent?.trim() || '',
      logEntries: actionLog ? [...actionLog.querySelectorAll('div')].map(d => d.textContent) : [],
      phase: handInfo?.textContent || '',
      pot: potDisplay?.textContent || '',
      handInfo: tiHand?.textContent || '',
      verify: tiVerify?.textContent || '',
      bannerVisible: banner?.style.display !== 'none',
      seats: [...document.querySelectorAll('.seat')].length,
      boardCards: [...document.querySelectorAll('.board-card')].length,
    };
  }).catch(() => ({}));

  console.log('  [LOCAL GUI]');
  console.log('    Status bar: ' + localStatus.controls);
  console.log('    Phase: ' + localStatus.phase);
  console.log('    Pot: ' + localStatus.pot);
  console.log('    Hand: ' + localStatus.handInfo);
  console.log('    Verify: ' + localStatus.verify);
  console.log('    Seats: ' + localStatus.seats);
  console.log('    Board cards: ' + localStatus.boardCards);
  console.log('    Action log entries: ' + (localStatus.logEntries?.length || 0));

  // Check remote player status (what pplayer2 sees)
  const remoteStatus = await new Promise(resolve => {
    // The bot's WS should be receiving fullstate — let's capture the last one
    resolve({ note: 'Bot receives fullstate with message, phase, pot, actions' });
  });

  // Show last 10 action log entries
  console.log('\n  Action log (last 10):');
  (localStatus.logEntries || []).slice(-10).forEach(e => console.log('    ' + e));

  // Verify key status items
  const checks = [
    ['Action log has entries', (localStatus.logEntries?.length || 0) > 0],
    ['Action log has opponent actions', (localStatus.logEntries || []).some(e => e.includes('pplayer2'))],
    ['Action log has own actions', (localStatus.logEntries || []).some(e => e.includes('pc-player'))],
    ['Action log has board cards', (localStatus.logEntries || []).some(e => e.includes('flop') || e.includes('turn') || e.includes('river'))],
    ['Action log has hand separators', (localStatus.logEntries || []).some(e => e.startsWith('---'))],
    ['Action log has winner', (localStatus.logEntries || []).some(e => e.includes('wins'))],
    ['Action log has verification', (localStatus.logEntries || []).some(e => e.includes('verified'))],
  ];

  console.log('\n  Status checks:');
  let allPass = true;
  for (const [name, pass] of checks) {
    console.log('    ' + (pass ? 'PASS' : 'FAIL') + ' — ' + name);
    if (!pass) allPass = false;
  }

  await page.screenshot({ path: '/tmp/gui-test-final.png' });

  console.log('\n══════════════════════════════');
  console.log('RESULTS:');
  console.log('  Hands completed: ' + handsPlayed);
  console.log('  Local actions: ' + localActions);
  console.log('  Bot actions: ' + bot.getActions());
  console.log('══════════════════════════════');

  bot.ws.close();
  await browser.close();
}

test().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
