#!/usr/bin/env node
/**
 * GUI Test — uses Playwright to verify poker GUI works
 * Opens local player at http://localhost:3000, clicks through a hand
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
process.env.NODE_PATH = '/home/dev/Desktop/llm/node_modules';
require('module').Module._initPaths();

const { chromium } = require('playwright');

const WAIT = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // Open local player
  console.log('Opening http://localhost:3000...');
  await page.goto('http://localhost:3000');
  await WAIT(2000);

  // Take screenshot of lobby
  await page.screenshot({ path: '/tmp/poker-lobby.png' });
  console.log('Screenshot: /tmp/poker-lobby.png');

  // Check if lobby loaded
  const title = await page.textContent('#lobby-title').catch(() => null);
  console.log('Lobby title:', title);

  // Click first available "Sit Here" button
  const sitBtn = page.locator('button:has-text("Sit Here")').first();
  if (await sitBtn.isVisible()) {
    console.log('Clicking Sit Here...');
    await sitBtn.click();
    await WAIT(3000);
  } else {
    console.log('No Sit Here button — might already be in game');
  }

  // Take screenshot after joining
  await page.screenshot({ path: '/tmp/poker-joined.png' });
  console.log('Screenshot: /tmp/poker-joined.png');

  // Wait for cards to appear
  console.log('Waiting for cards...');
  for (let i = 0; i < 30; i++) {
    const html = await page.innerHTML('body');
    if (html.includes('card') && (html.includes('Fold') || html.includes('Check') || html.includes('Call'))) {
      console.log('Action buttons visible!');
      await page.screenshot({ path: '/tmp/poker-action.png' });
      console.log('Screenshot: /tmp/poker-action.png');
      break;
    }
    await WAIT(2000);
  }

  // Check for action buttons and click one
  const checkBtn = page.locator('button:has-text("Check")');
  const callBtn = page.locator('button:has-text("Call")');
  const foldBtn = page.locator('button:has-text("Fold")');

  if (await checkBtn.isVisible().catch(() => false)) {
    console.log('Clicking Check...');
    await checkBtn.click();
  } else if (await callBtn.isVisible().catch(() => false)) {
    console.log('Clicking Call...');
    await callBtn.click();
  } else if (await foldBtn.isVisible().catch(() => false)) {
    console.log('Clicking Fold...');
    await foldBtn.click();
  } else {
    console.log('No action buttons found');
  }

  await WAIT(5000);
  await page.screenshot({ path: '/tmp/poker-after-action.png' });
  console.log('Screenshot: /tmp/poker-after-action.png');

  // Wait for next street or settlement
  console.log('Waiting for game to progress...');
  for (let i = 0; i < 30; i++) {
    const html = await page.innerHTML('body');
    if (html.includes('Fold') || html.includes('Check') || html.includes('Call')) {
      console.log('New action buttons appeared!');
      await page.screenshot({ path: '/tmp/poker-next-street.png' });

      // Click again
      if (await checkBtn.isVisible().catch(() => false)) {
        console.log('Clicking Check...');
        await checkBtn.click();
      } else if (await foldBtn.isVisible().catch(() => false)) {
        console.log('Clicking Fold...');
        await foldBtn.click();
      }
      break;
    }
    if (html.includes('verified') || html.includes('wins') || html.includes('Waiting for next')) {
      console.log('Hand completed!');
      await page.screenshot({ path: '/tmp/poker-complete.png' });
      break;
    }
    await WAIT(2000);
  }

  await WAIT(3000);
  await page.screenshot({ path: '/tmp/poker-final.png' });
  console.log('Screenshot: /tmp/poker-final.png');

  console.log('Done. Browser staying open for 30s...');
  await WAIT(30000);
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
