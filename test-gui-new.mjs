#!/usr/bin/env node
/**
 * 3-player 200-hand test — ALL players via GUI (Playwright browsers)
 * Each player runs gui-server.mjs, Playwright opens browser to each.
 * Random actions on all streets. Auto-reload on bust.
 */

import { chromium } from 'playwright';

const PLAYERS = [
  { name: 'pc-player', url: 'http://localhost:3000', local: true },
  { name: 'pplayer2', url: 'http://46.225.132.28:3001', local: false },
  { name: 'pdealer2', url: 'https://verus.cx/poker/', local: false },
];
const TOTAL_HANDS = 200;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════
// Auto-play a browser page — random actions on all streets
// ══════════════════════════════════════
async function autoPlay(page, name, stats) {
  while (!stats.stop) {
    try {
      // Check for busted
      const busted = await page.evaluate(() => {
        const el = document.getElementById('controls');
        return el && el.textContent.includes('Out of chips');
      }).catch(() => false);

      if (busted) {
        stats.reloads++;
        console.log('  [' + name + '] BUSTED — reloading');
        const btn = await page.$('#controls button');
        if (btn) await btn.click();
        await sleep(2000);
        const sitBtn = await page.$('#controls button');
        if (sitBtn) {
          const txt = await sitBtn.textContent().catch(() => '');
          if (txt.includes('Sit In')) await sitBtn.click();
        }
        await sleep(3000);
        continue;
      }

      // Check for action buttons
      const btns = await page.$$eval('#controls button', b => b.map(x => x.textContent.trim())).catch(() => []);
      if (btns.length > 0 && !btns[0].includes('Reload') && !btns[0].includes('Sit In')) {
        // Random action
        const rnd = Math.random();
        let clicked = false;

        const tryClick = async (keyword) => {
          for (const b of btns) {
            if (b.toLowerCase().includes(keyword)) {
              try {
                await page.click('#controls button:has-text("' + b.replace(/['"]/g, '') + '")', { timeout: 2000 });
                return b;
              } catch { return null; }
            }
          }
          return null;
        };

        let actionName;
        if (rnd < 0.35) actionName = await tryClick('check') || await tryClick('call');
        else if (rnd < 0.6) actionName = await tryClick('fold');
        else if (rnd < 0.85) actionName = await tryClick('raise') || await tryClick('bet');
        else actionName = await tryClick('all in');

        if (!actionName) {
          const anyBtn = await page.$('#controls button');
          if (anyBtn) { actionName = await anyBtn.textContent().catch(() => '?'); await anyBtn.click().catch(() => {}); }
        }

        if (actionName) {
          stats.actions++;
          if (stats.actions <= 20 || stats.actions % 50 === 0) {
            console.log('  [' + name + '] ' + actionName + ' (action #' + stats.actions + ')');
          }
        }
        await sleep(800);
      } else {
        await sleep(1500);
      }
    } catch {
      await sleep(2000);
    }
  }
}

// ══════════════════════════════════════
// Main
// ══════════════════════════════════════
async function test() {
  console.log('=== 3-Player 200-Hand GUI Test ===');
  console.log('All 3 players via Playwright browsers\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });

  // Open all 3 browsers
  const pages = [];
  const stats = [];
  for (const p of PLAYERS) {
    console.log('Opening ' + p.name + ' → ' + p.url);
    const page = await context.newPage();
    await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(e => console.log('  WARN: ' + e.message));
    pages.push({ page, ...p });
    stats.push({ actions: 0, reloads: 0, stop: false });
    await sleep(1000);
  }

  // Wait for seats on local page
  console.log('\nWaiting for seats...');
  const localPage = pages[0].page;
  for (let i = 0; i < 120; i++) {
    const seats = await localPage.$$eval('.seat', s => s.length).catch(() => 0);
    if (seats >= 3) { console.log('All 3 seats visible (' + i + 's)\n'); break; }
    if (seats >= 2 && i > 30) { console.log(seats + ' seats visible (' + i + 's) — proceeding\n'); break; }
    if (i % 15 === 0) console.log('  Waiting... (' + i + 's, seats: ' + seats + ')');
    await sleep(1000);
  }

  await localPage.screenshot({ path: '/tmp/gui-test-start.png' });

  // Start auto-play on ALL 3 browsers
  console.log('Starting auto-play on all 3 browsers...\n');
  const autoPlayers = pages.map((p, i) => autoPlay(p.page, p.name, stats[i]));

  // Monitor progress — count hands via local page
  let lastHand = 0;
  let handsCompleted = 0;
  let staleCount = 0;

  for (let tick = 0; tick < 3600 && handsCompleted < TOTAL_HANDS; tick++) {
    const handInfo = await localPage.evaluate(() => {
      const el = document.getElementById('ti-hand');
      return el ? el.textContent : '';
    }).catch(() => '');

    const handNum = parseInt((handInfo.match(/\d+/) || ['0'])[0]);
    if (handNum > lastHand) {
      handsCompleted += (handNum - lastHand);
      lastHand = handNum;
      staleCount = 0;

      if (handsCompleted <= 10 || handsCompleted % 25 === 0) {
        console.log('[PROGRESS] Hand #' + handNum + ' (' + handsCompleted + '/' + TOTAL_HANDS + ' completed)');
        console.log('  Actions: ' + stats.map((s, i) => PLAYERS[i].name + '=' + s.actions).join(', '));
        await localPage.screenshot({ path: '/tmp/gui-test-progress-' + handsCompleted + '.png' });
      }
    } else {
      staleCount++;
      if (staleCount > 0 && staleCount % 60 === 0) {
        console.log('[STALE] No new hand for ' + staleCount + 's (at hand #' + lastHand + ')');
        await localPage.screenshot({ path: '/tmp/gui-test-stale-' + staleCount + '.png' });
      }
    }

    await sleep(1000);
  }

  // Stop auto-play
  stats.forEach(s => s.stop = true);
  await sleep(2000);

  // Final status
  console.log('\n=== Final Status ===');
  const status = await localPage.evaluate(() => {
    const logEl = document.getElementById('action-log');
    return {
      table: document.getElementById('ti-table')?.textContent || '',
      blinds: document.getElementById('ti-blinds')?.textContent || '',
      hand: document.getElementById('ti-hand')?.textContent || '',
      mode: document.getElementById('ti-mode')?.textContent || '',
      verify: document.getElementById('ti-verify')?.textContent || '',
      controls: document.getElementById('controls')?.textContent?.trim() || '',
      logCount: logEl ? logEl.querySelectorAll('div').length : 0,
      logLast15: logEl ? [...logEl.querySelectorAll('div')].slice(-15).map(d => d.textContent) : [],
      seats: document.querySelectorAll('.seat').length,
      dealerBadge: document.querySelectorAll('.seat-role').length,
      boardCards: document.querySelectorAll('.board-card').length,
    };
  }).catch(() => ({}));

  console.log('  Top-left: ' + status.table + ' | ' + status.blinds + ' | ' + status.hand + ' | ' + status.mode + ' | ' + status.verify);
  console.log('  Seats: ' + status.seats + ' | Dealer badge: ' + (status.dealerBadge > 0 ? 'YES' : 'NO'));
  console.log('  Board cards: ' + status.boardCards);
  console.log('  Action log: ' + status.logCount + ' entries');
  console.log('\n  Last 15 log entries:');
  (status.logLast15 || []).forEach(e => console.log('    ' + e));

  // Verify all 3 pages show correct state
  console.log('\n  Per-player status:');
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const pStatus = await p.page.evaluate(() => {
      const logEl = document.getElementById('action-log');
      return {
        seats: document.querySelectorAll('.seat').length,
        log: logEl ? logEl.querySelectorAll('div').length : 0,
        hand: document.getElementById('ti-hand')?.textContent || '',
      };
    }).catch(() => ({ seats: 0, log: 0, hand: '?' }));
    console.log('    ' + p.name + ': seats=' + pStatus.seats + ' log=' + pStatus.log + ' ' + pStatus.hand);
    await p.page.screenshot({ path: '/tmp/gui-test-' + p.name + '-final.png' });
  }

  // Checks
  const checks = [
    ['Table info visible', status.table.includes('ptable')],
    ['Blinds visible', status.blinds.includes('/')],
    ['Hand # visible', status.hand.includes('Hand')],
    ['Dealer badge', status.dealerBadge > 0],
    ['3 seats rendered', status.seats >= 3],
    ['Action log populated', status.logCount > 10],
    ['Log has multiple players', (status.logLast15 || []).filter(e => e.includes('pplayer2') || e.includes('pdealer2') || e.includes('pc-player')).length >= 2],
    ['Log has board cards', (status.logLast15 || []).some(e => e.includes('flop') || e.includes('turn') || e.includes('river') || e.includes('showdown'))],
    ['Log has winners', (status.logLast15 || []).some(e => e.includes('wins'))],
    ['Log has verification', (status.logLast15 || []).some(e => e.includes('verified'))],
    ['200+ hands completed', handsCompleted >= TOTAL_HANDS],
  ];

  console.log('\n  Checks:');
  let allPass = true;
  for (const [name, pass] of checks) {
    console.log('    ' + (pass ? 'PASS' : 'FAIL') + ' — ' + name);
    if (!pass) allPass = false;
  }

  await localPage.screenshot({ path: '/tmp/gui-test-final.png' });

  console.log('\n══════════════════════════════');
  console.log('RESULTS:');
  console.log('  Hands completed: ' + handsCompleted + '/' + TOTAL_HANDS);
  for (let i = 0; i < PLAYERS.length; i++) {
    console.log('  ' + PLAYERS[i].name + ': ' + stats[i].actions + ' actions, ' + stats[i].reloads + ' reloads');
  }
  console.log('  All checks: ' + (allPass ? 'PASS' : 'FAIL'));
  console.log('══════════════════════════════');

  await browser.close();
}

test().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
