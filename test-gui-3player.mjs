#!/usr/bin/env node
/**
 * 3-Player GUI Test — opens all 3 player browsers, plays hands
 * Takes screenshots at every step
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
process.env.NODE_PATH = '/home/dev/Desktop/llm/node_modules';
require('module').Module._initPaths();

const { chromium } = require('playwright');

const WAIT = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const ts = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';

async function screenshot(page, name) {
  const path = '/tmp/poker-' + name + '.png';
  await page.screenshot({ path });
  console.log(ts() + ' Screenshot: ' + path);
}

async function clickAction(page, label) {
  for (const action of ['Check', 'Call', 'Fold', 'Raise', 'All In']) {
    const btn = page.locator('button:has-text("' + action + '")');
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      console.log(ts() + ' [' + label + '] Clicking ' + action);
      await btn.click();
      return action;
    }
  }
  return null;
}

async function waitForAction(page, label, timeoutS = 60) {
  for (let i = 0; i < timeoutS; i++) {
    for (const action of ['Check', 'Call', 'Fold']) {
      const btn = page.locator('button:has-text("' + action + '")');
      if (await btn.isVisible({ timeout: 200 }).catch(() => false)) {
        return true;
      }
    }
    await WAIT(1000);
  }
  return false;
}

async function main() {
  console.log('Launching 3 browsers...');
  const browser = await chromium.launch({ headless: false, args: ['--window-size=600,500'] });

  const ctx1 = await browser.newContext({ viewport: { width: 600, height: 500 } });
  const ctx2 = await browser.newContext({ viewport: { width: 600, height: 500 } });
  const ctx3 = await browser.newContext({ viewport: { width: 600, height: 500 } });

  const p1 = await ctx1.newPage(); // pc-player (local)
  const p2 = await ctx2.newPage(); // pdealer2 (.59)
  const p3 = await ctx3.newPage(); // pplayer2 (.28)

  // Open all 3
  console.log(ts() + ' Opening local player...');
  await p1.goto('http://localhost:3000');
  console.log(ts() + ' Opening .59 player...');
  await p2.goto('https://verus.cx/poker/play?name=pdealer2');
  console.log(ts() + ' Opening .28 player...');
  await p3.goto('https://46-225-132-28.sslip.io/');

  await WAIT(3000);
  await screenshot(p1, '01-p1-lobby');
  await screenshot(p2, '01-p2-lobby');
  await screenshot(p3, '01-p3-lobby');

  // Sit down at each table
  for (const [page, label] of [[p1, 'pc-player'], [p2, 'pdealer2'], [p3, 'pplayer2']]) {
    const sitBtn = page.locator('button:has-text("Sit Here")').first();
    if (await sitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log(ts() + ' [' + label + '] Clicking Sit Here');
      await sitBtn.click();
      await WAIT(2000);
    } else {
      console.log(ts() + ' [' + label + '] No Sit Here — already joined or different view');
    }
  }

  await WAIT(3000);
  await screenshot(p1, '02-p1-seated');
  await screenshot(p2, '02-p2-seated');
  await screenshot(p3, '02-p3-seated');

  // Play 3 hands
  for (let hand = 1; hand <= 3; hand++) {
    console.log('\n' + ts() + ' ═══ HAND ' + hand + ' ═══');

    // Wait for any player to get action buttons (max 60s)
    let handStarted = false;
    for (let i = 0; i < 60 && !handStarted; i++) {
      for (const [page, label] of [[p1, 'pc-player'], [p2, 'pdealer2'], [p3, 'pplayer2']]) {
        if (await waitForAction(page, label, 1)) {
          handStarted = true;
          console.log(ts() + ' [' + label + '] Has action buttons!');
          break;
        }
      }
    }

    if (!handStarted) {
      console.log(ts() + ' No action buttons after 60s — hand not started');
      await screenshot(p1, 'hand' + hand + '-timeout-p1');
      await screenshot(p2, 'hand' + hand + '-timeout-p2');
      await screenshot(p3, 'hand' + hand + '-timeout-p3');
      break;
    }

    // Play through streets — each player acts when they see buttons
    for (let street = 0; street < 8; street++) {
      let anyAction = false;
      for (const [page, label] of [[p1, 'pc-player'], [p2, 'pdealer2'], [p3, 'pplayer2']]) {
        const acted = await clickAction(page, label);
        if (acted) {
          anyAction = true;
          await WAIT(2000);
          await screenshot(page, 'hand' + hand + '-' + label + '-' + acted.toLowerCase());
        }
      }

      if (!anyAction) {
        // Wait for next street or settlement
        console.log(ts() + ' No buttons visible — waiting for next street...');
        let found = false;
        for (let i = 0; i < 30; i++) {
          for (const [page, label] of [[p1, 'pc-player'], [p2, 'pdealer2'], [p3, 'pplayer2']]) {
            if (await waitForAction(page, label, 1)) {
              found = true;
              break;
            }
          }
          if (found) break;

          // Check if hand ended
          const html = await p1.innerHTML('body').catch(() => '');
          if (html.includes('Waiting for next') || html.includes('verified')) {
            console.log(ts() + ' Hand completed!');
            await screenshot(p1, 'hand' + hand + '-complete-p1');
            await screenshot(p2, 'hand' + hand + '-complete-p2');
            await screenshot(p3, 'hand' + hand + '-complete-p3');
            found = true;
            break;
          }
          await WAIT(2000);
        }
        if (!found) {
          console.log(ts() + ' Stuck — no progress');
          await screenshot(p1, 'hand' + hand + '-stuck-p1');
          await screenshot(p2, 'hand' + hand + '-stuck-p2');
          await screenshot(p3, 'hand' + hand + '-stuck-p3');
        }
        break;
      }
    }

    await WAIT(5000); // Wait between hands
  }

  console.log('\n' + ts() + ' Done. Taking final screenshots...');
  await screenshot(p1, 'final-p1');
  await screenshot(p2, 'final-p2');
  await screenshot(p3, 'final-p3');

  console.log(ts() + ' Browser staying open for 30s...');
  await WAIT(30000);
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
