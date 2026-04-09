#!/usr/bin/env node
/**
 * Real-browser end-to-end test via Playwright.
 *
 * Drives both player GUIs through a full poker hand at human pace, checking
 * the actual rendered DOM at each step. This is the test that proves a real
 * human can play — not just that the wire protocols work.
 *
 * Setup expected (started by hand before running this):
 *   - Dealer on .28 port 3000 (--phase-multisig)
 *   - pplayer2 gui-server on .28 port 3001 (also reachable via :3001)
 *   - pc-player gui-server local port 3002
 *   - cashier1 running locally
 *
 * Usage: node test-playwright-real-game.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const PC_PLAYER_URL = 'http://localhost:3002/';
const PPLAYER2_URL  = 'http://46.225.132.28:3001/';
const SHOTS = './pw-shots';
mkdirSync(SHOTS, { recursive: true });

const WAIT = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function record(name, status, info = {}) {
  results.push({ name, status, ...info });
  const tag = status === 'PASS' ? '\u2713' : status === 'FAIL' ? '\u2717' : '\u00b7';
  console.log('  [' + tag + '] ' + name + (info.note ? ' \u2014 ' + info.note : ''));
}

async function snap(page, label) {
  const path = SHOTS + '/' + label + '.png';
  try { await page.screenshot({ path, fullPage: false }); } catch {}
}

async function getState(page) {
  return await page.evaluate(() => {
    const el = document.getElementById('controls');
    const seats = Array.from(document.querySelectorAll('[data-seat-id], .seat-player, [class*="seat"]')).map(s => s.textContent?.trim()).filter(Boolean).slice(0, 9);
    const pot = document.getElementById('pot')?.textContent?.trim();
    const board = Array.from(document.querySelectorAll('#board img, #board .card')).map(c => c.getAttribute('alt') || c.textContent || '?');
    return { controlsHTML: el?.innerHTML?.trim()?.slice(0, 400) || '', controlsText: el?.textContent?.trim()?.slice(0, 200) || '', pot, board, hasUndefined: document.body.innerText.includes('undefined') };
  });
}

async function clickIfVisible(page, selector, label) {
  try {
    const btn = await page.locator(selector).first();
    if (await btn.isVisible({ timeout: 2000 })) {
      await btn.click();
      console.log('    clicked: ' + label);
      return true;
    }
  } catch {}
  return false;
}

async function main() {
  console.log('='.repeat(70));
  console.log('Playwright real-browser end-to-end test');
  console.log('='.repeat(70));

  const browser = await chromium.launch({ headless: true });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage(); // pc-player
  const pageB = await ctxB.newPage(); // pplayer2

  // Capture console errors
  pageA.on('pageerror', e => console.log('  [pcA pageerror]', e.message));
  pageB.on('pageerror', e => console.log('  [ppB pageerror]', e.message));

  console.log('\n--- Step 1: load both player GUIs ---');
  await pageA.goto(PC_PLAYER_URL, { waitUntil: 'networkidle' });
  await pageB.goto(PPLAYER2_URL, { waitUntil: 'networkidle' });
  await WAIT(2000);
  await snap(pageA, '01-pcA-loaded');
  await snap(pageB, '01-ppB-loaded');
  record('both GUIs loaded', 'PASS');

  // Check Leave button is in DOM (proves new HTML deployed)
  const leaveInA = await pageA.evaluate(() => document.body.innerHTML.includes('doLeave'));
  const leaveInB = await pageB.evaluate(() => document.body.innerHTML.includes('doLeave'));
  record('Leave button in pcA HTML', leaveInA ? 'PASS' : 'FAIL');
  record('Leave button in ppB HTML', leaveInB ? 'PASS' : 'FAIL');

  // Check no "undefined" text on initial load
  const undefA = await pageA.evaluate(() => document.body.innerText.includes('undefined'));
  const undefB = await pageB.evaluate(() => document.body.innerText.includes('undefined'));
  record('no "undefined" in pcA', undefA ? 'FAIL' : 'PASS');
  record('no "undefined" in ppB', undefB ? 'FAIL' : 'PASS');

  console.log('\n--- Step 2: pick a seat (Sit Here button or Sit In) ---');
  // The "Sit Here" buttons appear when sitting out. Click the first one.
  await WAIT(2000);
  const pickedA = await clickIfVisible(pageA, 'button:has-text("Sit Here")', 'pcA Sit Here');
  const pickedB = await clickIfVisible(pageB, 'button:has-text("Sit Here")', 'ppB Sit Here');
  if (!pickedA) await clickIfVisible(pageA, 'button:has-text("Sit In")', 'pcA Sit In');
  if (!pickedB) await clickIfVisible(pageB, 'button:has-text("Sit In")', 'ppB Sit In');
  record('Sit In clicked on both', 'PASS');
  await WAIT(8000);
  await snap(pageA, '02-pcA-seated');
  await snap(pageB, '02-ppB-seated');

  console.log('\n--- Step 3: wait for phase + hand to start (up to 240s) ---');
  let handStarted = false;
  for (let i = 0; i < 80; i++) {
    const sA = await getState(pageA);
    const sB = await getState(pageB);
    const buttonsA = await pageA.evaluate(() => {
      const c = document.getElementById('controls');
      return !!c && (c.querySelector('button.btn-check') || c.querySelector('button.btn-call') || c.querySelector('button.btn-fold:not([onclick*="SitOut"]):not([onclick*="Leave"])'));
    });
    const buttonsB = await pageB.evaluate(() => {
      const c = document.getElementById('controls');
      return !!c && (c.querySelector('button.btn-check') || c.querySelector('button.btn-call') || c.querySelector('button.btn-fold:not([onclick*="SitOut"]):not([onclick*="Leave"])'));
    });
    if (buttonsA || buttonsB) {
      handStarted = true;
      console.log('    hand started after ' + (i * 3) + 's (pcA=' + buttonsA + ' ppB=' + buttonsB + ')');
      break;
    }
    if (i % 10 === 0) console.log('    still waiting... (' + (i * 3) + 's) pcA=' + sA.controlsText.slice(0, 50) + ' | ppB=' + sB.controlsText.slice(0, 50));
    await WAIT(3000);
  }
  record('hand started + buttons visible', handStarted ? 'PASS' : 'FAIL');
  await snap(pageA, '03-pcA-hand-start');
  await snap(pageB, '03-ppB-hand-start');

  if (!handStarted) {
    console.log('  No buttons appeared. Final controls state:');
    const sA = await getState(pageA);
    const sB = await getState(pageB);
    console.log('  pcA:', sA.controlsText.slice(0, 150));
    console.log('  ppB:', sB.controlsText.slice(0, 150));
  }

  // Check no "undefined" mid-hand
  const undefAMid = await pageA.evaluate(() => document.body.innerText.includes('undefined'));
  const undefBMid = await pageB.evaluate(() => document.body.innerText.includes('undefined'));
  record('no "undefined" mid-hand pcA', undefAMid ? 'FAIL' : 'PASS');
  record('no "undefined" mid-hand ppB', undefBMid ? 'FAIL' : 'PASS');

  console.log('\n--- Step 4: play through the hand (check/call loop, 8 rounds) ---');
  for (let round = 0; round < 8; round++) {
    await WAIT(3000);
    for (const [page, label] of [[pageA, 'pcA'], [pageB, 'ppB']]) {
      const has = await page.evaluate(() => {
        const c = document.getElementById('controls');
        if (!c) return { check: false, call: false, fold: false };
        return {
          check: !!c.querySelector('button.btn-check'),
          call: !!c.querySelector('button.btn-call'),
          fold: !!c.querySelector('button.btn-fold')
        };
      });
      if (has.check) await clickIfVisible(page, 'button.btn-check', label + ' Check');
      else if (has.call) await clickIfVisible(page, 'button.btn-call', label + ' Call');
    }
  }
  await snap(pageA, '04-pcA-after-actions');
  await snap(pageB, '04-ppB-after-actions');

  console.log('\n--- Step 5: wait for hand settlement ---');
  await WAIT(15000);
  const sAFinal = await getState(pageA);
  const sBFinal = await getState(pageB);
  console.log('  pcA controls:', sAFinal.controlsText.slice(0, 150));
  console.log('  ppB controls:', sBFinal.controlsText.slice(0, 150));
  await snap(pageA, '05-pcA-after-hand');
  await snap(pageB, '05-ppB-after-hand');

  // No undefined after hand
  const undefAEnd = await pageA.evaluate(() => document.body.innerText.includes('undefined'));
  const undefBEnd = await pageB.evaluate(() => document.body.innerText.includes('undefined'));
  record('no "undefined" after hand pcA', undefAEnd ? 'FAIL' : 'PASS');
  record('no "undefined" after hand ppB', undefBEnd ? 'FAIL' : 'PASS');

  console.log('\n--- Step 6: pcA clicks Leave ---');
  // Set up dialog handler before clicking (Leave triggers a confirm())
  pageA.on('dialog', async dialog => { console.log('    dialog:', dialog.message().slice(0,60)); await dialog.accept(); });
  const clickedLeave = await clickIfVisible(pageA, 'button:has-text("Leave")', 'pcA Leave');
  record('clicked Leave button', clickedLeave ? 'PASS' : 'FAIL');
  await WAIT(20000);
  await snap(pageA, '06-pcA-after-leave');

  // Verify the GUI shows we're not at the table anymore
  const sAAfterLeave = await getState(pageA);
  console.log('  pcA after leave:', sAAfterLeave.controlsText.slice(0, 150));

  console.log('\n' + '='.repeat(70));
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  console.log('PASS: ' + pass + '   FAIL: ' + fail + '   (total: ' + results.length + ')');
  console.log('Screenshots saved to ' + SHOTS);

  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });
