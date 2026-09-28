const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { launchOptions } = require('./browser');

const BASE = 'https://run.camboulive.solutions';
const OUT = __dirname;

const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
};

async function shot(page, dir, name) {
  await page.waitForTimeout(400);
  const file = path.join(OUT, dir, `${name}.png`);

  // Tailwind's `fixed` utility keeps nav/headers pinned to the viewport;
  // during a full-page stitched screenshot that makes them repeat at every
  // scroll offset. Temporarily detach them from viewport positioning (and
  // clear their inset offsets) just for the capture. Modal dialogs are also
  // `fixed inset-0` with their own internal `overflow-y-auto` scroll area,
  // so we also uncap that overflow. Finally, when a modal is open the
  // underlying page is still mounted (and often taller), so we hide every
  // sibling that isn't part of the modal's ancestor chain to stop it
  // bleeding through below the modal's real content.
  // Width is forced to 100%: an absolutely-positioned block with `width:auto`
  // and both left/right auto shrinks to fit its content (CSS 10.3.7) instead
  // of spanning the viewport like it would as `fixed inset-x-0`. The header
  // hit this too, but its bg-slate-900 matches the page background so the
  // squashed box was invisible there — the bottom nav's bg-slate-800 is what
  // exposed it. Forcing 100% restores the full-bleed bar these elements were
  // always meant to render as (`inset-x-0` / `inset-0` implies full width).
  const styleHandle = await page.addStyleTag({
    content: `
      .fixed {
        position: absolute !important;
        top: auto !important;
        bottom: auto !important;
        left: auto !important;
        right: auto !important;
        inset: auto !important;
        width: 100% !important;
      }
      [class*="overflow-y-auto"], [class*="overflow-auto"] {
        overflow: visible !important;
        max-height: none !important;
        height: auto !important;
      }
      [data-pw-hidden] { display: none !important; }
    `,
  });

  await page.evaluate(() => {
    const modals = Array.from(document.querySelectorAll('.fixed.inset-0'));
    if (modals.length === 0) return;
    const root = document.body.firstElementChild || document.body;
    (function hideNonModalSiblings(container) {
      Array.from(container.children).forEach((child) => {
        if (child.matches('.fixed.inset-0')) return;
        if (child.querySelector('.fixed.inset-0')) {
          hideNonModalSiblings(child);
        } else {
          child.setAttribute('data-pw-hidden', '1');
        }
      });
    })(root);
  });

  await page.screenshot({ path: file, fullPage: true });

  await page.evaluate(() => {
    document.querySelectorAll('[data-pw-hidden]').forEach((el) => el.removeAttribute('data-pw-hidden'));
  });
  await styleHandle.evaluate((el) => el.remove());
  console.log('saved', file);
}

async function closeModal(page) {
  const closeBtn = page.locator('button[aria-label="Close"]').last();
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click();
    await page.waitForTimeout(300);
  }
}

async function clickFab(page) {
  const fab = page.locator('button[aria-label="Record a run"]').first();
  if (await fab.isVisible().catch(() => false)) {
    await fab.click();
    return true;
  }
  return false;
}

async function clickSettings(page) {
  const gear = page.locator('button[aria-label="Settings"]').first();
  if (await gear.isVisible().catch(() => false)) {
    await gear.click();
    return true;
  }
  return false;
}

async function run(viewportName) {
  const vp = VIEWPORTS[viewportName];
  const browser = await chromium.launch(launchOptions({ headless: true }));
  const context = await browser.newContext({
    viewport: vp,
    storageState: path.join(__dirname, 'auth.json'),
  });
  const page = await context.newPage();
  const dir = viewportName;
  fs.mkdirSync(path.join(OUT, dir), { recursive: true });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Good to see you');

  const declineBtn = page.locator('button', { hasText: 'Decline' }).first();
  if (await declineBtn.isVisible().catch(() => false)) {
    await declineBtn.click();
    await page.waitForTimeout(300);
  }

  await shot(page, dir, '01-home');

  await page.locator('text=Plan').last().click();
  await shot(page, dir, '02-plan');
  const week2 = page.locator('text=W2').first();
  if (await week2.isVisible().catch(() => false)) {
    await week2.click();
    await shot(page, dir, '02b-plan-week-expanded');
    await week2.click(); // collapse again before opening the edit form
  }

  // "Edit plan" — opens the goal/availability/style form (3 numbered
  // accordion sections). Capture it as-is (goal section expanded by default)
  // then navigate back WITHOUT clicking the generate/rebuild CTA, so the
  // plan itself is never touched.
  const editGoalRow = page.locator('text=Edit').first();
  if (await editGoalRow.isVisible().catch(() => false)) {
    await editGoalRow.click();
    await page.waitForTimeout(400);
    await shot(page, dir, '02c-plan-edit-form');
    const backBtn = page.locator('button[aria-label="Back"]').first();
    if (await backBtn.isVisible().catch(() => false)) {
      await backBtn.click();
      await page.waitForTimeout(300);
    }
  }

  const coachBtn = page.locator('button:text-is("Coach")').first();
  if (await coachBtn.isVisible().catch(() => false)) {
    await coachBtn.click();
    await page.waitForTimeout(800); // let the usage-ring fetch settle
    await shot(page, dir, '03-coach-chat');

    // Conversation history sheet.
    const historyBtn = page.locator('button[aria-label="Conversation history"]').first();
    if (await historyBtn.isVisible().catch(() => false)) {
      await historyBtn.click();
      await page.waitForTimeout(500);
      await shot(page, dir, '03b-coach-history');
      await page.keyboard.press('Escape'); // dismiss the sheet, back to the chat
      await page.waitForTimeout(300);
    }

    // Usage popover ("N left today").
    const usageBtn = page.locator('button[aria-expanded]').first();
    if (await usageBtn.isVisible().catch(() => false)) {
      await usageBtn.click();
      await page.waitForTimeout(300);
      await shot(page, dir, '03c-coach-usage');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }

    await closeModal(page);
  }

  if (await clickFab(page)) {
    await page.waitForTimeout(500);
    await shot(page, dir, '04-record-run');

    const gpsBtn = page.locator('text=Track a run live').first();
    if (await gpsBtn.isVisible().catch(() => false)) {
      await gpsBtn.click();
      await page.waitForTimeout(800);
      await shot(page, dir, '04b-live-gps-tracker');
      await closeModal(page);
    }
    await closeModal(page);
  }

  await page.locator('text=Races').last().click();
  await page.waitForTimeout(500);
  await shot(page, dir, '05-races-my-races');

  const findRace = page.locator('text=Find a race').first();
  if (await findRace.isVisible().catch(() => false)) {
    await findRace.click();
    await page.waitForTimeout(500);
    await shot(page, dir, '05b-races-find-a-race');

    const firstRace = page.locator('text=Berlin Marathon').first();
    if (await firstRace.isVisible().catch(() => false)) {
      await firstRace.click();
      await page.waitForTimeout(400);
      await shot(page, dir, '05c-races-detail-expanded');
    }
  }

  await page.locator('text=Progress').last().click();
  await page.waitForTimeout(500);

  const logTab = page.locator('text=Log').first();
  const statsTab = page.locator('text=Stats').first();
  const badgesTab = page.locator('text=Badges').first();

  if (await logTab.isVisible().catch(() => false)) {
    await logTab.click();
    await page.waitForTimeout(400);
    await shot(page, dir, '06-progress-log');
  }
  if (await statsTab.isVisible().catch(() => false)) {
    await statsTab.click();
    await page.waitForTimeout(400);
    await shot(page, dir, '07-progress-stats');
  }
  if (await badgesTab.isVisible().catch(() => false)) {
    await badgesTab.click();
    await page.waitForTimeout(400);
    await shot(page, dir, '08-progress-badges');
  }

  if (await clickSettings(page)) {
    await page.waitForTimeout(500);
    await shot(page, dir, '09-settings');
    await closeModal(page);
  }

  await browser.close();
}

(async () => {
  const target = process.argv[2];
  if (target === 'mobile' || target === 'desktop') {
    await run(target);
  } else {
    await run('mobile');
    await run('desktop');
  }
  console.log('Done.');
})();
