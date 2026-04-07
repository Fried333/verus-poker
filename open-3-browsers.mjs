#!/usr/bin/env node
// Open 3 browsers via Playwright to validate the GUIs render correctly
import { chromium } from 'playwright';

const URLS = [
  { label: 'pplayer2  (.28:3001)', url: 'http://46.225.132.28:3001/' },
  { label: 'pc-player (.28:3002)', url: 'http://46.225.132.28:3002/' },
  { label: 'pdealer2  (.59:3001)', url: 'http://89.125.50.59:3001/' },
];

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });

for (let i = 0; i < URLS.length; i++) {
  const { label, url } = URLS[i];
  console.log(`Opening ${label} → ${url}`);
  const page = await ctx.newPage();
  page.on('pageerror', err => console.log(`[${label}] PAGE ERROR:`, err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') console.log(`[${label}] console.error:`, msg.text());
  });
  try {
    await page.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
    // Wait briefly for state hydrate
    await page.waitForTimeout(3000);
    // Check whether the table felt loaded
    const title = await page.title();
    const hasFelt = await page.locator('.felt, #felt, [class*="table"], canvas').count();
    console.log(`[${label}] title="${title}" feltElements=${hasFelt}`);
    // Take a screenshot
    const shotPath = `/tmp/poker-${i}-${label.replace(/\W+/g, '_')}.png`;
    await page.screenshot({ path: shotPath, fullPage: true });
    console.log(`[${label}] screenshot → ${shotPath}`);
  } catch (e) {
    console.log(`[${label}] LOAD ERROR:`, e.message);
  }
}

console.log('\nAll 3 browsers open. Sleeping 5 minutes — Ctrl+C to close.');
await new Promise(r => setTimeout(r, 5 * 60 * 1000));
await browser.close();
