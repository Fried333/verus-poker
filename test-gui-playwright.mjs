#!/usr/bin/env node
/**
 * Playwright GUI Test — plays 20 real hands through the browser
 * Requires: dealer on .28, opponent (stress test) on .59, local player on port 3000
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
process.env.NODE_PATH = '/home/dev/Desktop/llm/node_modules';
require('module').Module._initPaths();

const { chromium } = require('playwright');

const HANDS = parseInt(process.argv.find(a => a.startsWith('--hands='))?.split('=')[1] || '20');
const HEADLESS = process.argv.includes('--headless');
const URL = 'http://localhost:3000';
const WAIT = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const ts = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';

async function main() {
  console.log('════════════════════════════════════════');
  console.log('  PLAYWRIGHT GUI TEST — ' + HANDS + ' hands');
  console.log('════════════════════════════════════════\n');

  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });

  // ── Load page ──
  console.log(ts() + ' Opening ' + URL);
  await page.goto(URL);
  await WAIT(2000);
  await page.screenshot({ path: '/tmp/pw-01-lobby.png' });

  // ── Click Sit Here ──
  const sitBtn = page.locator('button:has-text("Sit Here")').first();
  if (await sitBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log(ts() + ' Clicking Sit Here');
    await sitBtn.click();
  } else {
    console.log(ts() + ' ERROR: No Sit Here button');
    await browser.close();
    return;
  }
  await WAIT(3000);
  await page.screenshot({ path: '/tmp/pw-02-joined.png' });

  // ── Wait for first hand ──
  console.log(ts() + ' Waiting for first hand to start (max 120s)...');
  let started = false;
  for (let i = 0; i < 120; i++) {
    // Look for actual card images on the felt
    const cardCount = await page.locator('.card-img, .card, [class*="card"]').count().catch(() => 0);
    const hasButtons = await page.locator('button.btn-check, button.btn-call, button.btn-fold, button:has-text("Check"), button:has-text("Call"), button:has-text("Fold")').first().isVisible({ timeout: 200 }).catch(() => false);
    const bodyText = await page.textContent('#felt, #controls, body').catch(() => '');

    if (hasButtons) {
      started = true;
      console.log(ts() + ' Action buttons visible — hand started!');
      break;
    }
    // Check for card display (not just "Waiting")
    if (cardCount > 0 && !bodyText.includes('Waiting for dealer')) {
      started = true;
      console.log(ts() + ' Cards visible on felt — hand started!');
      break;
    }
    if (i % 10 === 0) console.log(ts() + ' Still waiting... cards=' + cardCount + ' buttons=' + hasButtons);
    await WAIT(1000);
  }

  if (!started) {
    console.log(ts() + ' FAIL: Hand never started');
    await page.screenshot({ path: '/tmp/pw-03-timeout.png' });
    await browser.close();
    return;
  }
  await page.screenshot({ path: '/tmp/pw-03-hand-started.png' });

  // ── Play hands ──
  let handsCompleted = 0;
  let totalActions = 0;
  let errors = [];

  for (let h = 1; h <= HANDS; h++) {
    console.log('\n' + ts() + ' ═══ HAND ' + h + ' ═══');
    let actionsThisHand = 0;
    let handDone = false;

    for (let street = 0; street < 20 && !handDone; street++) {
      // Wait for my turn (action buttons) or hand settlement
      let gotTurn = false;
      for (let w = 0; w < 60; w++) {
        // Check for action buttons
        const check = page.locator('button:has-text("Check")');
        const call = page.locator('button:has-text("Call")');
        const fold = page.locator('button:has-text("Fold")');
        const bet = page.locator('button:has-text("Bet")');

        for (const btn of [check, call, fold, bet]) {
          if (await btn.isVisible({ timeout: 200 }).catch(() => false)) {
            gotTurn = true;
            // Pick action: mostly check/call, sometimes fold
            const r = Math.random();
            let clicked = false;
            if (r < 0.6 && await check.isVisible({ timeout: 100 }).catch(() => false)) {
              await check.click(); clicked = true;
              console.log(ts() + ' → Check');
            } else if (r < 0.6 && await call.isVisible({ timeout: 100 }).catch(() => false)) {
              await call.click(); clicked = true;
              console.log(ts() + ' → Call');
            } else if (r < 0.8 && await call.isVisible({ timeout: 100 }).catch(() => false)) {
              await call.click(); clicked = true;
              console.log(ts() + ' → Call');
            } else if (await fold.isVisible({ timeout: 100 }).catch(() => false)) {
              await fold.click(); clicked = true;
              console.log(ts() + ' → Fold');
            } else if (await check.isVisible({ timeout: 100 }).catch(() => false)) {
              await check.click(); clicked = true;
              console.log(ts() + ' → Check (fallback)');
            }
            if (clicked) {
              actionsThisHand++;
              totalActions++;
              await WAIT(1000);
            }
            break;
          }
        }
        if (gotTurn) break;

        // Check for settlement — winner banner visible
        const bannerVisible = await page.locator('#winner-banner').evaluate(el => el.style.display !== 'none' && el.textContent.includes('wins')).catch(() => false);
        if (bannerVisible) {
          console.log(ts() + ' Winner banner visible — hand settled');
          handDone = true;
          break;
        }

        // Check for "..." (waiting for opponent)
        const controls = await page.textContent('#controls').catch(() => '');
        if (controls.includes('...') || controls.includes('Waiting')) {
          // Opponent's turn, keep waiting
        }

        await WAIT(1000);
      }

      if (!gotTurn && !handDone) {
        // Timeout waiting for turn
        console.log(ts() + ' Timeout waiting for turn/settlement');
        await page.screenshot({ path: '/tmp/pw-hand' + h + '-timeout.png' });
        errors.push('Hand ' + h + ': timeout on street ' + street);
        handDone = true;
      }
    }

    if (!handDone) {
      // Wait for settlement — winner banner
      for (let w = 0; w < 60; w++) {
        const bannerVisible = await page.locator('#winner-banner').evaluate(el => el.style.display !== 'none' && el.textContent.includes('wins')).catch(() => false);
        if (bannerVisible) { handDone = true; break; }
        await WAIT(1000);
      }
    }

    handsCompleted++;
    console.log(ts() + ' Hand ' + h + ': ' + actionsThisHand + ' actions');
    await page.screenshot({ path: '/tmp/pw-hand' + h + '.png' });

    // Wait for winner banner to disappear (settlement clear) then next hand
    console.log(ts() + ' Waiting for next hand...');
    // First wait for banner to disappear
    for (let w = 0; w < 30; w++) {
      const bannerVisible = await page.locator('#winner-banner').evaluate(el => el.style.display !== 'none').catch(() => false);
      if (!bannerVisible) break;
      await WAIT(1000);
    }
    // Then wait for new action buttons
    for (let w = 0; w < 60; w++) {
      const hasButtons = await page.locator('button:has-text("Check"), button:has-text("Call"), button:has-text("Fold")').first().isVisible({ timeout: 200 }).catch(() => false);
      if (hasButtons) break;
      await WAIT(1000);
    }
  }

  // ── Summary ──
  await page.screenshot({ path: '/tmp/pw-final.png' });

  console.log('\n════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('════════════════════════════════════════');
  console.log('Hands: ' + handsCompleted + '/' + HANDS);
  console.log('Actions: ' + totalActions);
  console.log('Errors: ' + errors.length);
  errors.forEach(e => console.log('  ✗ ' + e));
  console.log(errors.length === 0 ? '\n★ ALL PASS' : '\n✗ ISSUES FOUND');

  if (!HEADLESS) {
    console.log('\nBrowser open for 10s...');
    await WAIT(10000);
  }
  await browser.close();
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
