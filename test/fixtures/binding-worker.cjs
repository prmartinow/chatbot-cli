const { chromium } = require('playwright-core');
const cb = require('../../CB.js');
let browser;
let binding;
process.on('message', async message => {
  try {
    if (message.action === 'acquire') {
      browser = await chromium.connectOverCDP(message.args.cdp, { timeout: 10000 });
      binding = await cb.findTargetAppPage(browser, message.args);
      process.send({ type: 'acquired', targetId: binding.targetId, conversationId: binding.conversationId });
    } else if (message.action === 'release') {
      cb.releasePageBinding(binding);
      if (browser) await browser.close();
      process.send({ type: 'released' });
      process.disconnect();
    }
  } catch (error) {
    process.send({ type: 'error', code: error.code, message: error.message });
    if (browser) await browser.close().catch(() => {});
    process.disconnect();
  }
});
