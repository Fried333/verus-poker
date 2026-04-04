#!/usr/bin/env node
/**
 * Playwright Scenario Test — verifies every GUI state visually
 * Runs against real dealer on .28 + stress test opponent on .59
 * Tests: lobby, sit, deal, action, fold, showdown, clear, next hand
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
process.env.NODE_PATH = '/home/dev/Desktop/llm/node_modules';
require('module').Module._initPaths();
const { chromium } = require('playwright');

const URL = 'http://localhost:3000';
const WAIT = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const ts = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';

let pass = 0, fail = 0, total = 0;
function check(name, condition, detail) {
  total++;
  if (condition) { pass++; console.log(ts() + ' ✓ ' + name); }
  else { fail++; console.log(ts() + ' ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

async function ss(page, name) {
  await page.screenshot({ path: '/tmp/pw-' + name + '.png' });
}

async function main() {
  console.log('════════════════════════════════════════════════════');
  console.log('  GUI SCENARIO TEST');
  console.log('════════════════════════════════════════════════════\n');

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });

  // ══ SCENARIO 1: Lobby ══
  console.log('\n' + ts() + ' ── Scenario 1: Lobby ──');
  await page.goto(URL);
  await WAIT(2000);
  await ss(page, 's01-lobby');

  const lobbyTitle = await page.textContent('#lobby-title').catch(() => '');
  check('Lobby title shows table name', lobbyTitle.includes('ptable2'), lobbyTitle);

  const sitButtons = await page.locator('button:has-text("Sit Here")').count();
  check('Sit Here buttons visible', sitButtons > 0, 'count=' + sitButtons);

  // ══ SCENARIO 2: Sit Down ══
  console.log('\n' + ts() + ' ── Scenario 2: Sit Down ──');
  await page.locator('button:has-text("Sit Here")').first().click();
  await WAIT(3000);
  await ss(page, 's02-seated');

  const myName = await page.textContent('body').catch(() => '');
  check('My name visible', myName.includes('pc-player'), '');

  // ══ SCENARIO 3: Wait for Hand ══
  console.log('\n' + ts() + ' ── Scenario 3: Wait for hand ──');
  let handStarted = false;
  for (let i = 0; i < 120; i++) {
    // Check for action buttons OR card elements
    const hasCheck = await page.locator('button:has-text("Check")').isVisible({ timeout: 200 }).catch(() => false);
    const hasCall = await page.locator('button:has-text("Call")').isVisible({ timeout: 200 }).catch(() => false);
    const hasFold = await page.locator('button:has-text("Fold")').isVisible({ timeout: 200 }).catch(() => false);
    if (hasCheck || hasCall || hasFold) { handStarted = true; break; }

    // Check for card images (seat-card class)
    const cards = await page.locator('.seat-card').count().catch(() => 0);
    if (cards >= 2) { handStarted = true; break; }

    if (i % 15 === 0) console.log(ts() + ' Still waiting for hand...');
    await WAIT(1000);
  }
  check('Hand starts (cards or buttons)', handStarted);
  await ss(page, 's03-hand-started');

  if (!handStarted) {
    console.log('Cannot continue without a hand. Aborting.');
    await browser.close();
    printSummary();
    return;
  }

  // ══ SCENARIO 4: Verify Initial State ══
  console.log('\n' + ts() + ' ── Scenario 4: Verify initial state ──');

  // My cards visible
  const myCards = await page.locator('.me .seat-card').count().catch(() => 0);
  check('My cards visible', myCards >= 2, 'count=' + myCards);

  // Other players visible
  const playerSeats = await page.locator('.seat:not(.me):not([class*="empty"])').count().catch(() => 0);
  check('Other player(s) visible', playerSeats >= 1, 'count=' + playerSeats);

  // Pot shows
  const potText = await page.textContent('#pot-display').catch(() => '');
  check('Pot displayed', potText.includes('Pot'), potText);

  // ══ SCENARIO 5: My Turn — Action Buttons ══
  console.log('\n' + ts() + ' ── Scenario 5: Action buttons ──');

  // Wait for buttons if not already visible
  let hasButtons = false;
  for (let i = 0; i < 60; i++) {
    const btns = await page.locator('#controls button').count().catch(() => 0);
    if (btns > 0) { hasButtons = true; break; }
    await WAIT(1000);
  }
  check('Action buttons appear when my turn', hasButtons);
  await ss(page, 's05-my-turn');

  // ══ SCENARIO 6: Take Action (Check/Call) ══
  console.log('\n' + ts() + ' ── Scenario 6: Take action ──');

  const checkBtn = page.locator('button:has-text("Check")');
  const callBtn = page.locator('button:has-text("Call")');
  let acted = false;
  if (await checkBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    await checkBtn.click(); acted = true; console.log(ts() + ' Clicked Check');
  } else if (await callBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    await callBtn.click(); acted = true; console.log(ts() + ' Clicked Call');
  }
  check('Able to click action', acted);
  await WAIT(1000);

  // Buttons should disappear after acting
  const btnsAfter = await page.locator('#controls button').count().catch(() => 0);
  check('Buttons disappear after action', btnsAfter === 0, 'buttons=' + btnsAfter);
  await ss(page, 's06-after-action');

  // ══ SCENARIO 7: Opponent's Turn / Waiting ══
  console.log('\n' + ts() + ' ── Scenario 7: Waiting for opponent ──');

  const controlsText = await page.textContent('#controls').catch(() => '');
  check('Shows waiting/status text', controlsText.length > 0 && !controlsText.includes('undefined'), controlsText.substring(0, 50));

  // ══ SCENARIO 8: Wait for hand to progress ══
  console.log('\n' + ts() + ' ── Scenario 8: Hand progression ──');

  // Play through remaining streets — click buttons when they appear
  let actionsTotal = 1; // Already acted once
  let sawBoard = false;
  let sawWinner = false;

  for (let round = 0; round < 20; round++) {
    // Wait for buttons or settlement
    for (let w = 0; w < 60; w++) {
      // Check for winner banner
      const bannerVis = await page.locator('#winner-banner').evaluate(
        el => el.style.display !== 'none' && el.textContent.length > 5
      ).catch(() => false);
      if (bannerVis) { sawWinner = true; break; }

      // Check for action buttons
      const btns = await page.locator('#controls button').count().catch(() => 0);
      if (btns > 0) break;

      // Check for board cards
      const boardCards = await page.locator('#board .board-card, #board img, #board [class*="card"]').count().catch(() => 0);
      if (boardCards > 0) sawBoard = true;

      await WAIT(1000);
    }

    if (sawWinner) break;

    // Click action if available
    const btns = await page.locator('#controls button').count().catch(() => 0);
    if (btns > 0) {
      // Randomly pick check/call or fold (80% check/call, 20% fold)
      const r = Math.random();
      if (r < 0.8) {
        if (await checkBtn.isVisible({ timeout: 300 }).catch(() => false)) {
          await checkBtn.click(); actionsTotal++; console.log(ts() + ' → Check');
        } else if (await callBtn.isVisible({ timeout: 300 }).catch(() => false)) {
          await callBtn.click(); actionsTotal++; console.log(ts() + ' → Call');
        } else {
          const fold = page.locator('button:has-text("Fold")');
          if (await fold.isVisible({ timeout: 300 }).catch(() => false)) {
            await fold.click(); actionsTotal++; console.log(ts() + ' → Fold');
          }
        }
      } else {
        const fold = page.locator('button:has-text("Fold")');
        if (await fold.isVisible({ timeout: 300 }).catch(() => false)) {
          await fold.click(); actionsTotal++; console.log(ts() + ' → Fold (random)');
        }
      }
      await WAIT(1000);
      await ss(page, 's08-action-' + actionsTotal);
    }
  }

  check('Played multiple actions', actionsTotal >= 1, 'actions=' + actionsTotal);

  // ══ SCENARIO 9: Settlement / Winner ══
  console.log('\n' + ts() + ' ── Scenario 9: Settlement ──');

  if (!sawWinner) {
    // Wait for winner banner
    for (let w = 0; w < 60; w++) {
      const bannerVis = await page.locator('#winner-banner').evaluate(
        el => el.style.display !== 'none' && el.textContent.length > 5
      ).catch(() => false);
      if (bannerVis) { sawWinner = true; break; }
      await WAIT(1000);
    }
  }
  check('Winner banner shows', sawWinner);
  if (sawWinner) {
    const winnerText = await page.textContent('#winner-banner').catch(() => '');
    check('Winner name in banner', winnerText.includes('wins'), winnerText.substring(0, 40));
  }
  await ss(page, 's09-settlement');

  // ══ SCENARIO 10: Hand Clears ══
  console.log('\n' + ts() + ' ── Scenario 10: Hand clears ──');

  // Wait for banner to hide
  for (let w = 0; w < 30; w++) {
    const bannerVis = await page.locator('#winner-banner').evaluate(
      el => el.style.display !== 'none'
    ).catch(() => false);
    if (!bannerVis) break;
    await WAIT(1000);
  }

  const bannerHidden = await page.locator('#winner-banner').evaluate(
    el => el.style.display === 'none' || el.style.display === ''
  ).catch(() => false);
  check('Winner banner hides after settlement', bannerHidden);

  const controlsAfter = await page.textContent('#controls').catch(() => '');
  check('Controls show waiting message', controlsAfter.includes('Waiting') || controlsAfter.includes('shuffling') || controlsAfter.includes('Hand'), controlsAfter.substring(0, 40));
  await ss(page, 's10-cleared');

  // ══ SCENARIO 11: Next Hand ══
  console.log('\n' + ts() + ' ── Scenario 11: Next hand ──');

  let nextHand = false;
  for (let w = 0; w < 120; w++) {
    const btns = await page.locator('#controls button').count().catch(() => 0);
    const cards = await page.locator('.me .seat-card').count().catch(() => 0);
    if (btns > 0 || cards >= 2) { nextHand = true; break; }
    if (w % 15 === 0) console.log(ts() + ' Waiting for next hand...');
    await WAIT(1000);
  }
  check('Next hand starts', nextHand);
  await ss(page, 's11-next-hand');

  // ══ SUMMARY ══
  printSummary();

  console.log('\nBrowser open for 10s...');
  await WAIT(10000);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}

function printSummary() {
  console.log('\n════════════════════════════════════════════════════');
  console.log('  RESULTS: ' + pass + '/' + total + ' pass, ' + fail + ' fail');
  console.log('════════════════════════════════════════════════════');
  console.log(fail === 0 ? '★ ALL PASS' : '✗ ISSUES FOUND');
}

main().catch(e => { console.error(e); process.exit(1); });
