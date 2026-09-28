const fs = require('fs');
const path = require('path');

// Cloud images ship one preinstalled Chromium that may not match the pinned
// Playwright's build, and forbid downloading another: use it when present.
function launchOptions(opts = {}) {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const preinstalled = root && path.join(root, 'chromium');
  return preinstalled && fs.existsSync(preinstalled) ? { ...opts, executablePath: preinstalled } : opts;
}

module.exports = { launchOptions };
