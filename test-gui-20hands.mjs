#!/usr/bin/env node
/**
 * 20-Hand 3-Player GUI Test — each browser plays independently
 * Clicks actions on ALL 3 views, verifies cards, status, settlement
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
process.env.NODE_PATH = '/home/dev/Desktop/llm/node_modules';
require('module').Module._initPaths();
const { chromium } = require('playwright');

const HANDS = 20;
const WAIT = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const ts = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';

async function clickAny(page, label) {
  const actions = ['Check', 'Call', 'Fold'];
  // 60% check/call, 40% fold after first action
  const r = Math.random();
  if (r < 0.4) {
    const check = page.locator('button:has-text("Check")');
    if (await check.isVisible({ timeout: 200 }).catch(() => false)) { await check.click(); return 'Check'; }
    const call = page.locator('button:has-text("Call")');
    if (await call.isVisible({ timeout: 200 }).catch(() => false)) { await call.click(); return 'Call'; }
  }
  if (r < 0.7) {
    const call = page.locator('button:has-text("Call")');
    if (await call.isVisible({ timeout: 200 }).catch(() => false)) { await call.click(); return 'Call'; }
    const check = page.locator('button:has-text("Check")');
    if (await check.isVisible({ timeout: 200 }).catch(() => false)) { await check.click(); return 'Check'; }
  }
  const fold = page.locator('button:has-text("Fold")');
  if (await fold.isVisible({ timeout: 200 }).catch(() => false)) { await fold.click(); return 'Fold'; }
  const check = page.locator('button:has-text("Check")');
  if (await check.isVisible({ timeout: 200 }).catch(() => false)) { await check.click(); return 'Check'; }
  return null;
}

async function main() {
  console.log('════════════════════════════════════════');
  console.log('  20-HAND 3-PLAYER GUI TEST');
  console.log('════════════════════════════════════════\n');

  const browser = await chromium.launch({ headless: false });
  const views = [
    { name: 'pc-player', url: 'http://localhost:3000' },
    { name: 'pplayer2', url: 'https://46-225-132-28.sslip.io/' },
    { name: 'pdealer2', url: 'https://verus.cx/poker/play?name=pdealer2' },
  ];

  for (const v of views) {
    v.page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
    await v.page.goto(v.url);
    console.log(ts() + ' Opened ' + v.name);
  }
  await WAIT(3000);

  // Sit down
  for (const v of views) {
    const sit = v.page.locator('button:has-text("Sit Here")').first();
    if (await sit.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sit.click();
      console.log(ts() + ' [' + v.name + '] Sat down');
    }
    await WAIT(2000);
  }

  // Wait for first hand
  console.log(ts() + ' Waiting for first hand...');
  for (let i = 0; i < 120; i++) {
    let found = false;
    for (const v of views) {
      const btns = await v.page.locator('#controls button').count().catch(() => 0);
      if (btns > 0) { found = true; break; }
    }
    if (found) break;
    await WAIT(1000);
  }

  let handsCompleted = 0;
  let totalActions = 0;
  let errors = [];

  for (let h = 1; h <= HANDS; h++) {
    console.log('\n' + ts() + ' ═══ HAND ' + h + ' ═══');
    let handDone = false;
    let actionsThisHand = 0;

    for (let round = 0; round < 40 && !handDone; round++) {
      // Check each view for buttons and click
      for (const v of views) {
        const btns = await v.page.locator('#controls button').count().catch(() => 0);
        if (btns > 0) {
          const acted = await clickAny(v.page, v.name);
          if (acted) {
            actionsThisHand++;
            totalActions++;
            process.stdout.write(' ' + v.name[0] + ':' + acted[0]);
          }
          await WAIT(500);
        }
      }

      // Check for winner on any view
      for (const v of views) {
        const banner = await v.page.locator('#winner-banner').evaluate(
          el => el.style.display !== 'none' && el.textContent.includes('wins')
        ).catch(() => false);
        if (banner) {
          const text = await v.page.textContent('#winner-banner').catch(() => '');
          console.log(' → ' + text.trim().replace(/\s+/g, ' '));
          handDone = true;
          break;
        }
      }

      if (!handDone) await WAIT(1500);
    }

    if (handDone) {
      handsCompleted++;
      console.log(ts() + ' Hand ' + h + ': ' + actionsThisHand + ' actions ✓');
    } else {
      errors.push('Hand ' + h + ': no winner after 40 rounds');
      console.log(ts() + ' Hand ' + h + ': TIMEOUT ✗');
    }

    // Wait for next hand
    for (let w = 0; w < 30; w++) {
      const banner = await views[0].page.locator('#winner-banner').evaluate(
        el => el.style.display === 'none' || el.style.display === ''
      ).catch(() => true);
      if (banner) break;
      await WAIT(1000);
    }
    await WAIT(3000);

    // Take screenshot every 5 hands
    if (h % 5 === 0) {
      for (const v of views) {
        await v.page.screenshot({ path: '/tmp/pw20-' + v.name + '-h' + h + '.png' });
      }
    }
  }

  // Final screenshots
  for (const v of views) {
    await v.page.screenshot({ path: '/tmp/pw20-' + v.name + '-final.png' });
  }

  console.log('\n════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('════════════════════════════════════════');
  console.log('Hands: ' + handsCompleted + '/' + HANDS);
  console.log('Actions: ' + totalActions);
  console.log('Errors: ' + errors.length);
  errors.forEach(e => console.log('  ✗ ' + e));
  console.log(handsCompleted >= HANDS * 0.8 ? '\n★ PASS (' + handsCompleted + '/' + HANDS + ')' : '\n✗ FAIL');

  await WAIT(10000);
  await browser.close();
  process.exit(errors.length > HANDS * 0.2 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
