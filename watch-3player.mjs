#!/usr/bin/env node
/**
 * Opens 3 browser windows side by side — one per player.
 * Auto-plays random actions so you can watch the game live.
 * Press Ctrl+C to stop.
 */

import { chromium } from 'playwright';

const PLAYERS = [
  { name: 'pc-player', url: 'http://localhost:3000' },
  { name: 'pplayer2', url: 'http://46.225.132.28:3001' },
  { name: 'pdealer2', url: 'https://verus.cx/poker/' },
];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function autoPlay(page, name) {
  while (true) {
    try {
      // Reload if busted
      const busted = await page.evaluate(() => {
        const el = document.getElementById('controls');
        return el && el.textContent.includes('Out of chips');
      }).catch(() => false);
      if (busted) {
        console.log('[' + name + '] BUSTED — reloading');
        const btn = await page.$('#controls button');
        if (btn) await btn.click();
        await sleep(2000);
        const sitBtn = await page.$('#controls button');
        if (sitBtn) { const t = await sitBtn.textContent().catch(() => ''); if (t.includes('Sit In')) await sitBtn.click(); }
        await sleep(3000);
        continue;
      }

      // Click action buttons
      const btns = await page.$$eval('#controls button', b => b.map(x => x.textContent.trim())).catch(() => []);
      if (btns.length > 0 && !btns[0].includes('Reload') && !btns[0].includes('Sit In')) {
        const rnd = Math.random();
        const tryClick = async (kw) => {
          for (const b of btns) {
            if (b.toLowerCase().includes(kw)) {
              try { await page.click('#controls button:has-text("' + b.replace(/['"]/g, '') + '")', { timeout: 2000 }); return b; } catch { return null; }
            }
          }
          return null;
        };
        let action;
        // Heavy call/check to force showdowns
        if (rnd < 0.6) action = await tryClick('check') || await tryClick('call');
        else if (rnd < 0.75) action = await tryClick('raise') || await tryClick('bet');
        else if (rnd < 0.85) action = await tryClick('fold');
        else action = await tryClick('all in');
        if (!action) { const a = await page.$('#controls button'); if (a) { action = await a.textContent().catch(() => '?'); await a.click().catch(() => {}); } }
        if (action) console.log('[' + name + '] ' + action);
        await sleep(800);
      } else {
        await sleep(1500);
      }
    } catch { await sleep(2000); }
  }
}

async function main() {
  console.log('Opening 3 browser windows — watch the game!\nPress Ctrl+C to stop.\n');
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });

  // Position windows side by side
  const pages = [];
  for (let i = 0; i < PLAYERS.length; i++) {
    const p = PLAYERS[i];
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(e => console.log('WARN: ' + e.message));
    pages.push(page);
    console.log('Opened ' + p.name);
    await sleep(1000);
  }

  console.log('\nAll 3 windows open. Auto-playing...\n');

  // Start auto-play on all 3
  const runners = pages.map((page, i) => autoPlay(page, PLAYERS[i].name));

  // Keep running until Ctrl+C
  process.on('SIGINT', async () => {
    console.log('\nStopping...');
    await browser.close();
    process.exit(0);
  });

  await Promise.all(runners);
}

main().catch(e => { console.error(e); process.exit(1); });
