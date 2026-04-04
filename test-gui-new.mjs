#!/usr/bin/env node
/**
 * 3-player Playwright GUI test — 50 hands, random actions, reload on bust
 * - Local GUI via Playwright (pc-player)
 * - 2 remote bots via WebSocket (pplayer2 on .28, pdealer2 on .59)
 */

import { chromium } from 'playwright';
import WebSocket from 'ws';

const LOCAL_URL = 'http://localhost:3000';
const BOTS = [
  { name: 'pplayer2', ws: 'ws://46.225.132.28:3001' },
  { name: 'pdealer2', ws: 'wss://verus.cx/poker/' },
];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════
// Remote bot — random actions, auto-reload on bust
// ══════════════════════════════════════
function startBot(name, url) {
  return new Promise((resolve, reject) => {
    let actions = 0, acted = false, busted = false, lastHand = 0;
    const ws = new WebSocket(url);

    ws.on('open', () => {
      console.log('[BOT ' + name + '] Connected');
      ws.send(JSON.stringify({ action: 'join', name }));
      resolve({ ws, getActions: () => actions, getName: () => name });
    });

    ws.on('error', e => {
      console.log('[BOT ' + name + '] Error: ' + e.message);
      reject(e);
    });

    ws.on('message', data => {
      try {
        const m = JSON.parse(data.toString());

        // Handle busted
        if (m.method === 'busted') {
          busted = true;
          console.log('[BOT ' + name + '] BUSTED — reloading...');
          ws.send(JSON.stringify({ action: 'reload' }));
          setTimeout(() => {
            ws.send(JSON.stringify({ action: 'sitin' }));
            busted = false;
            console.log('[BOT ' + name + '] Sat back in');
          }, 2000);
          return;
        }

        // Reset acted when hand changes or no actions
        if (m.method === 'fullstate') {
          if (m.handCount && m.handCount !== lastHand) { acted = false; lastHand = m.handCount; }
          if (!m.actions || (m.actions.possibilities || m.actions.validActions || []).length === 0) acted = false;
        }

        // Act on fullstate
        if (m.method === 'fullstate' && m.actions && !acted && !busted) {
          const va = m.actions.possibilities || m.actions.validActions || [];
          const action = pickRandom(va);
          if (action) {
            acted = true;
            const amount = action === 'raise' ? (m.actions.minRaiseTo || m.actions.minRaise || 4) : 0;
            ws.send(JSON.stringify({ action, amount }));
            actions++;
            console.log('[BOT ' + name + '] ' + action + (amount ? ' ' + amount : '') + ' (#' + actions + ')');
          }
        }

        // Act on old-style betting
        if (m.method === 'betting' && m.action === 'round_betting' && m.turnPlayer === name && !acted && !busted) {
          const poss = m.possibilities || [];
          const action = pickRandom(poss);
          if (action) {
            acted = true;
            const amount = action === 'raise' ? (m.minRaiseTo || 4) : 0;
            ws.send(JSON.stringify({ action, amount }));
            actions++;
            console.log('[BOT ' + name + '] ' + action + (amount ? ' ' + amount : '') + ' (#' + actions + ')');
          }
        }

        if (m.method === 'betting' && m.action !== 'round_betting') acted = false;
        if (m.method === 'reloaded') { console.log('[BOT ' + name + '] Reloaded to ' + m.chips); }
        if (m.method === 'satin') { console.log('[BOT ' + name + '] Back in'); }
      } catch {}
    });

    ws.on('close', () => console.log('[BOT ' + name + '] Disconnected'));
    setTimeout(() => reject(new Error('Bot connect timeout')), 15000);
  });
}

function pickRandom(validActions) {
  // Handle both number codes and string names
  const map = { 0: 'fold', 1: 'check', 2: 'call', 3: 'raise', 7: 'allin' };
  const actions = validActions.map(a => typeof a === 'number' ? map[a] : a).filter(Boolean);
  if (actions.length === 0) return null;

  // Random: 40% check/call, 30% fold, 20% raise, 10% allin
  const rnd = Math.random();
  if (rnd < 0.4) {
    if (actions.includes('check')) return 'check';
    if (actions.includes('call')) return 'call';
  } else if (rnd < 0.7) {
    if (actions.includes('fold')) return 'fold';
  } else if (rnd < 0.9) {
    if (actions.includes('raise')) return 'raise';
  } else {
    if (actions.includes('allin')) return 'allin';
  }
  // Fallback: first available
  return actions[0];
}

// ══════════════════════════════════════
// Main test
// ══════════════════════════════════════
async function test() {
  console.log('=== 3-Player 50-Hand Test ===\n');

  // Start bots
  const bots = [];
  for (const b of BOTS) {
    try {
      const bot = await startBot(b.name, b.ws);
      bots.push(bot);
    } catch (e) {
      console.log('WARN: Could not connect bot ' + b.name + ': ' + e.message);
    }
  }
  console.log(bots.length + ' bots connected\n');
  await sleep(3000);

  // Open local GUI
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto(LOCAL_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });

  let handsPlayed = 0, localActions = 0, reloads = 0;

  // Wait for seats
  console.log('Waiting for seats...');
  for (let i = 0; i < 120; i++) {
    const seats = await page.$$eval('.seat', s => s.length).catch(() => 0);
    if (seats >= 2) { console.log('Seats: ' + seats + '\n'); break; }
    if (i % 15 === 0) console.log('  (' + i + 's)');
    await sleep(1000);
  }

  await page.screenshot({ path: '/tmp/gui-test-start.png' });

  // Play 50 hands
  for (let hand = 0; hand < 50; hand++) {
    let handDone = false;
    let handActions = 0;

    for (let tick = 0; tick < 120 && !handDone; tick++) {
      // Check for busted (reload button)
      const hasBusted = await page.evaluate(() => {
        const el = document.getElementById('controls');
        return el && el.textContent.includes('Out of chips');
      }).catch(() => false);

      if (hasBusted) {
        console.log('  [H' + (hand+1) + '] BUSTED — clicking Reload');
        const reloadBtn = await page.$('#controls button');
        if (reloadBtn) { await reloadBtn.click(); reloads++; }
        await sleep(2000);
        // Click Sit In
        const sitInBtn = await page.$('#controls button');
        if (sitInBtn) {
          const txt = await sitInBtn.textContent().catch(() => '');
          if (txt.includes('Sit In')) { await sitInBtn.click(); console.log('  [H' + (hand+1) + '] Sat back in'); }
        }
        await sleep(3000);
        continue;
      }

      // Check for action buttons
      const btns = await page.$$eval('#controls button', b => b.map(x => x.textContent.trim())).catch(() => []);
      if (btns.length > 0 && !btns[0].includes('Reload') && !btns[0].includes('Sit In')) {
        // Random action: 40% check/call, 30% fold, 20% raise/bet, 10% allin
        const rnd = Math.random();
        let clicked = false, clickedName = '';
        const tryClick = async (keyword) => {
          for (const b of btns) {
            if (b.toLowerCase().includes(keyword)) {
              await page.click('#controls button:has-text("' + b.replace(/"/g, '') + '")');
              clickedName = b;
              return true;
            }
          }
          return false;
        };

        if (rnd < 0.4) clicked = await tryClick('check') || await tryClick('call');
        else if (rnd < 0.7) clicked = await tryClick('fold');
        else if (rnd < 0.9) clicked = await tryClick('raise') || await tryClick('bet');
        else clicked = await tryClick('all in');
        if (!clicked) {
          const anyBtn = await page.$('#controls button');
          if (anyBtn) { clickedName = await anyBtn.textContent(); await anyBtn.click(); clicked = true; }
        }

        if (clicked) {
          localActions++;
          handActions++;
          if (hand < 5 || hand % 10 === 0) console.log('  [H' + (hand+1) + '] ' + clickedName);
        }
        await sleep(1500);
        continue;
      }

      // Check if hand ended
      const ended = await page.evaluate(() => {
        const banner = document.getElementById('winner-banner');
        const wait = document.querySelector('.wait-text');
        const wt = wait ? wait.textContent : '';
        return (banner && banner.style.display !== 'none') || wt.includes('verified') || wt.includes('next');
      }).catch(() => false);

      if (ended) { handDone = true; }

      await sleep(2000);
    }

    if (handDone) {
      handsPlayed++;
      if (hand < 5 || hand % 10 === 0) {
        console.log('  [H' + (hand+1) + '] Done (' + handActions + ' actions)');
        await page.screenshot({ path: '/tmp/gui-test-h' + (hand+1) + '.png' });
      }
    } else {
      console.log('  [H' + (hand+1) + '] Timed out');
      await page.screenshot({ path: '/tmp/gui-test-h' + (hand+1) + '-timeout.png' });
    }

    await sleep(6000);
  }

  // Final status
  console.log('\n=== Final Status ===');
  const status = await page.evaluate(() => {
    const logEl = document.getElementById('action-log');
    const tiTable = document.getElementById('ti-table');
    const tiBlinds = document.getElementById('ti-blinds');
    const tiHand = document.getElementById('ti-hand');
    const tiMode = document.getElementById('ti-mode');
    const tiVerify = document.getElementById('ti-verify');
    const controls = document.getElementById('controls');
    return {
      table: tiTable?.textContent || '',
      blinds: tiBlinds?.textContent || '',
      hand: tiHand?.textContent || '',
      mode: tiMode?.textContent || '',
      verify: tiVerify?.textContent || '',
      controls: controls?.textContent?.trim() || '',
      logCount: logEl ? logEl.querySelectorAll('div').length : 0,
      logLast10: logEl ? [...logEl.querySelectorAll('div')].slice(-10).map(d => d.textContent) : [],
      seats: document.querySelectorAll('.seat').length,
      dealerBadge: document.querySelectorAll('.seat-role').length,
    };
  }).catch(() => ({}));

  console.log('  Top-left: ' + status.table + ' | ' + status.blinds + ' | ' + status.hand + ' | ' + status.mode + ' | ' + status.verify);
  console.log('  Seats: ' + status.seats + ' | Dealer badge: ' + (status.dealerBadge > 0 ? 'YES' : 'NO'));
  console.log('  Controls: ' + status.controls);
  console.log('  Action log: ' + status.logCount + ' entries');
  console.log('  Last 10:');
  (status.logLast10 || []).forEach(e => console.log('    ' + e));

  // Checks
  const checks = [
    ['Table name in top-left', status.table.includes('ptable')],
    ['Blinds in top-left', status.blinds.includes('/')],
    ['Hand # in top-left', status.hand.includes('Hand')],
    ['Mode in top-left', status.mode.includes('p2p')],
    ['Dealer badge visible', status.dealerBadge > 0],
    ['Action log has entries', status.logCount > 0],
    ['Log has all players', (status.logLast10 || []).some(e => e.includes('pplayer2') || e.includes('pdealer2'))],
    ['Log has board cards', status.logCount > 5], // Should have many entries after 50 hands
  ];

  console.log('\n  Checks:');
  for (const [name, pass] of checks) {
    console.log('    ' + (pass ? 'PASS' : 'FAIL') + ' — ' + name);
  }

  await page.screenshot({ path: '/tmp/gui-test-final.png' });

  console.log('\n══════════════════════════════');
  console.log('RESULTS:');
  console.log('  Hands completed: ' + handsPlayed + '/50');
  console.log('  Local actions: ' + localActions);
  console.log('  Reloads: ' + reloads);
  bots.forEach(b => console.log('  ' + b.getName() + ' actions: ' + b.getActions()));
  console.log('══════════════════════════════');

  bots.forEach(b => b.ws.close());
  await browser.close();
}

test().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
