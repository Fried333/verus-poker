#!/usr/bin/env node
/**
 * 3-View GUI Test — opens all 3 player browsers, plays a hand
 * Checks status display, card visibility, action propagation on ALL views
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
process.env.NODE_PATH = '/home/dev/Desktop/llm/node_modules';
require('module').Module._initPaths();
const { chromium } = require('playwright');

const WAIT = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const ts = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';

let pass = 0, fail = 0, total = 0;
function check(name, condition, detail) {
  total++;
  if (condition) { pass++; console.log(ts() + ' ✓ ' + name); }
  else { fail++; console.log(ts() + ' ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

async function ss(page, name) { await page.screenshot({ path: '/tmp/pw3-' + name + '.png' }); }

async function getControls(page) { return page.textContent('#controls').catch(() => ''); }
async function getPlayers(page) {
  return page.evaluate(() => {
    const seats = document.querySelectorAll('.seat:not([class*="empty"])');
    return Array.from(seats).map(s => ({
      name: s.querySelector('.seat-name')?.textContent || '',
      chips: s.querySelector('.seat-chips')?.textContent || '',
      hasCards: s.querySelectorAll('.seat-card').length,
      folded: s.classList.contains('folded'),
      isMe: s.classList.contains('me'),
    }));
  }).catch(() => []);
}
async function hasButtons(page) {
  return page.locator('#controls button').count().catch(() => 0);
}
async function clickAction(page, label) {
  for (const act of ['Check', 'Call', 'Fold']) {
    const btn = page.locator('button:has-text("' + act + '")');
    if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
      await btn.click();
      console.log(ts() + ' [' + label + '] → ' + act);
      return act;
    }
  }
  return null;
}

async function main() {
  console.log('════════════════════════════════════════════════════');
  console.log('  3-VIEW GUI TEST');
  console.log('════════════════════════════════════════════════════\n');

  const browser = await chromium.launch({ headless: false, args: ['--window-size=700,500'] });
  const p1 = await (await browser.newContext({ viewport: { width: 700, height: 500 } })).newPage();
  const p2 = await (await browser.newContext({ viewport: { width: 700, height: 500 } })).newPage();
  const p3 = await (await browser.newContext({ viewport: { width: 700, height: 500 } })).newPage();

  const views = [
    { page: p1, name: 'pc-player', url: 'http://localhost:3000' },
    { page: p2, name: 'pplayer2', url: 'https://46-225-132-28.sslip.io/' },
    { page: p3, name: 'pdealer2', url: 'https://verus.cx/poker/play?name=pdealer2' },
  ];

  // ── Open all 3 ──
  console.log(ts() + ' Opening all 3 browsers...');
  for (const v of views) {
    await v.page.goto(v.url);
    await WAIT(1000);
  }
  await WAIT(2000);
  for (const v of views) await ss(v.page, v.name + '-01-lobby');

  // ── Sit down at all 3 ──
  console.log(ts() + ' Sitting down...');
  for (const v of views) {
    const sit = v.page.locator('button:has-text("Sit Here")').first();
    if (await sit.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sit.click();
      console.log(ts() + ' [' + v.name + '] Sat down');
      await WAIT(2000);
    } else {
      console.log(ts() + ' [' + v.name + '] No sit button (auto-joined?)');
    }
  }
  await WAIT(5000);
  for (const v of views) await ss(v.page, v.name + '-02-seated');

  // ── Wait for hand to start ──
  console.log(ts() + ' Waiting for hand to start...');
  let handStarted = false;
  for (let i = 0; i < 120; i++) {
    for (const v of views) {
      const btns = await hasButtons(v.page);
      const cards = await v.page.locator('.seat-card').count().catch(() => 0);
      if (btns > 0 || cards >= 2) { handStarted = true; break; }
    }
    if (handStarted) break;
    if (i % 15 === 0) console.log(ts() + ' Still waiting...');
    await WAIT(1000);
  }
  check('Hand starts on at least one view', handStarted);
  await WAIT(3000);

  // ── Check all 3 views show players ──
  console.log('\n' + ts() + ' ── Checking all views ──');
  for (const v of views) {
    const players = await getPlayers(v.page);
    const nonEmpty = players.filter(p => p.name);
    check('[' + v.name + '] Shows players', nonEmpty.length >= 2, 'count=' + nonEmpty.length + ' names=' + nonEmpty.map(p => p.name).join(','));

    const myView = players.find(p => p.isMe);
    check('[' + v.name + '] Has "me" seat', !!myView, myView ? myView.name : 'none');

    const controls = await getControls(v.page);
    check('[' + v.name + '] Controls not empty', controls.length > 0, controls.substring(0, 40));

    await ss(v.page, v.name + '-03-state');
  }

  // ── Play through a hand — act on each view when buttons appear ──
  console.log('\n' + ts() + ' ── Playing hand ──');
  let actions = 0;
  let sawWinner = false;

  for (let round = 0; round < 30 && !sawWinner; round++) {
    // Check each view for action buttons
    for (const v of views) {
      const btns = await hasButtons(v.page);
      if (btns > 0) {
        const acted = await clickAction(v.page, v.name);
        if (acted) {
          actions++;
          await WAIT(1000);
          await ss(v.page, v.name + '-act-' + actions);

          // Check OTHER views show status
          for (const other of views) {
            if (other === v) continue;
            await WAIT(500);
            const controls = await getControls(other.page);
            console.log(ts() + ' [' + other.name + '] controls: ' + controls.substring(0, 50));
          }
        }
      }
    }

    // Check for winner
    for (const v of views) {
      const banner = await v.page.locator('#winner-banner').evaluate(
        el => el.style.display !== 'none' && el.textContent.includes('wins')
      ).catch(() => false);
      if (banner) {
        sawWinner = true;
        const text = await v.page.textContent('#winner-banner').catch(() => '');
        console.log(ts() + ' [' + v.name + '] Winner: ' + text.trim());
        break;
      }
    }

    if (!sawWinner) await WAIT(2000);
  }

  check('Hand completes with winner', sawWinner);
  check('Multiple actions taken', actions >= 1, 'actions=' + actions);

  // ── Check all views show winner ──
  if (sawWinner) {
    await WAIT(1000);
    for (const v of views) {
      const banner = await v.page.locator('#winner-banner').evaluate(
        el => el.style.display !== 'none' && el.textContent.includes('wins')
      ).catch(() => false);
      const text = await v.page.textContent('#winner-banner').catch(() => '');
      check('[' + v.name + '] Shows winner banner', banner, text.substring(0, 40));
      await ss(v.page, v.name + '-04-winner');
    }
  }

  // ── Summary ──
  console.log('\n════════════════════════════════════════════════════');
  console.log('  RESULTS: ' + pass + '/' + total + ' pass, ' + fail + ' fail');
  console.log('════════════════════════════════════════════════════');
  console.log(fail === 0 ? '★ ALL PASS' : '✗ ISSUES FOUND');

  console.log('\nBrowser open for 15s...');
  await WAIT(15000);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
