const { chromium } = require('playwright');
const path = require('path');
const { launchOptions } = require('./browser');

(async () => {
  const browser = await chromium.launch(launchOptions({ headless: false }));
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto('https://run.camboulive.solutions');

  console.log('Please log in manually in the opened browser window.');
  console.log('Waiting for the dashboard (Home) to appear...');

  // Wait until something only visible when logged in appears.
  await page.waitForSelector('text=Good to see you', { timeout: 300000 });

  await context.storageState({ path: path.join(__dirname, 'auth.json') });
  console.log('Logged in. Session saved to auth.json.');

  await browser.close();
})();
