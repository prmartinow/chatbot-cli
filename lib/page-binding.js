'use strict';

// Selection never implies ownership. Keep the physical lease from allocation
// until the outer operation releases the binding, including passive reads.
async function acquirePageBinding(browser, args, deps) {
  const {
    cbError, getPageTargetId, acquireTargetLease, acquireConversationLease,
    releaseConversationLease, withTopologyLease, normalizeCdpUrl,
    sessionIdFromUrl, isTargetAppUrl, targetAppUrl, targetConversationUrl,
    parseConversationRef, loadConversationIndex, randomId, assertLeaseCurrent,
  } = deps;
  const cdp = normalizeCdpUrl(args.cdp);
  const operationId = args.jobId || randomId('page-operation');
  let expected = args.expectedSessionId || '';
  if (!expected && args.conversation && !/^(current|active|this)$/i.test(args.conversation) && !args.newConversation) {
    expected = parseConversationRef(args.conversation, loadConversationIndex()).sessionId;
    if (!expected) throw cbError('CONVERSATION_UNRESOLVED', 'Conversation alias has no stable session binding');
  }
  const current = /^(current|active|this)$/i.test(args.conversation || '');
  const explicitTarget = args.targetId || args.pageTargetId || '';
  const readOnly = Boolean(args.status || args.watchState || args.latestAssistant || args.syncTranscript || args.recoverQueue || args.recoverBranchId || args.schedule);
  if (!explicitTarget && !expected && !current && !args.newTab && readOnly) {
    throw cbError('TARGET_BINDING_REQUIRED', 'Inspection requires an exact target or conversation');
  }
  let conversationLease = null;
  let targetLease = null;
  let page = null;
  let created = false;
  let binding = null;
  try {
    if (expected) conversationLease = acquireConversationLease(expected, operationId);
    const pages = () => browser.contexts().flatMap(context => context.pages());
    const choose = async () => {
      if (explicitTarget) {
        for (const candidate of pages()) {
          if (await getPageTargetId(candidate) === explicitTarget) return candidate;
        }
        throw cbError('PAGE_TARGET_NOT_FOUND', `No page matches target ID "${explicitTarget}"`);
      }
      if (args.newTab || args.newConversation) return null;
      const matches = pages().filter(candidate => isTargetAppUrl(candidate.url())
        && (expected ? sessionIdFromUrl(candidate.url()) === expected : current));
      if (matches.length > 1) throw cbError('PAGE_TARGET_AMBIGUOUS', 'Multiple eligible tabs; specify --target-id');
      if (matches.length === 1) return matches[0];
      if (current || args.recoverBranchId) throw cbError('PAGE_TARGET_NOT_FOUND', 'Requested conversation is not open; discovery/recovery will not allocate a tab');
      return null;
    };
    const reserve = async candidate => {
      const targetId = await getPageTargetId(candidate);
      if (!targetId) throw cbError('PAGE_TARGET_ID_UNVERIFIED', 'Could not establish physical CDP target identity');
      targetLease = acquireTargetLease(cdp, targetId, operationId);
      if (await getPageTargetId(candidate) !== targetId) throw cbError('PAGE_TARGET_ID_UNVERIFIED', 'Target changed while acquiring its lease');
      if (!created && !isTargetAppUrl(candidate.url())) throw cbError('PAGE_ORIGIN_MISMATCH', 'Explicit target is not a target-app page');
      const actualSession = sessionIdFromUrl(candidate.url());
      if (!created && expected && actualSession !== expected) throw cbError('THREAD_IDENTITY_DRIFT', 'Explicit target does not contain the requested conversation');
      if (!expected && actualSession && !args.newConversation) {
        conversationLease = acquireConversationLease(actualSession, operationId);
        expected = actualSession;
      }
      let windowId = null;
      if (typeof browser.newBrowserCDPSession === 'function') {
        const session = await browser.newBrowserCDPSession();
        try {
          windowId = (await session.send('Browser.getWindowForTarget', { targetId })).windowId;
        } finally { await session.detach(); }
      }
      if (args.windowId != null && Number(args.windowId) !== windowId) {
        throw cbError('PAGE_WINDOW_MISMATCH', 'Target does not belong to the requested browser window');
      }
      if (typeof candidate.emulateMedia === 'function') {
        const colorScheme = process.env.CHATBOT_COLOR_SCHEME || 'dark';
        if (colorScheme !== 'no-override') {
          await candidate.emulateMedia({ colorScheme }).catch((err) => {
            console.warn(`[page-binding] Failed to apply colorScheme emulation "${colorScheme}": ${err.message || err}`);
          });
        }
      }
      binding = { page: candidate, cdp, browserInstanceId: args.browserInstanceId || cdp, targetId, targetLease,
        conversationId: expected, conversationLease, fence: targetLease.fence,
        windowId, released: false };
      return candidate;
    };
    page = await choose();
    if (page) {
      await reserve(page);
    } else {
      // Reserve while topology is held, but NEVER navigate under topology lock.
      await withTopologyLease(args, operationId, async () => {
        page = await choose();
        if (!page) {
          const context = browser.contexts()[0] || await browser.newContext();
          page = await context.newPage();
          created = true;
        }
        await reserve(page);
      });
    }
    if (created) {
      await page.goto(expected ? targetConversationUrl(expected) : targetAppUrl(), { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (!isTargetAppUrl(page.url()) || (expected && sessionIdFromUrl(page.url()) !== expected)) {
        throw cbError('THREAD_IDENTITY_DRIFT', 'Allocated page did not reach the requested origin/conversation');
      }
    }
    if (typeof page.emulateMedia === 'function') {
      const colorScheme = process.env.CHATBOT_COLOR_SCHEME || 'dark';
      if (colorScheme !== 'no-override') {
        await page.emulateMedia({ colorScheme }).catch(() => {});
      }
    }
    assertLeaseCurrent(targetLease);
    if (conversationLease) assertLeaseCurrent(conversationLease);
    args.pageTargetId = binding.targetId;
    args.expectedSessionId = expected;
    args._pageBinding = binding;
    // Legacy operation helpers borrow these, never consume the outer ownership.
    args._laneLease = targetLease;
    return binding;
  } catch (error) {
    // Only dispose a tab this operation created, while it still owns that tab.
    // A lost lease is not authorization to close a successor's page.
    if (created && page && targetLease) {
      try {
        assertLeaseCurrent(targetLease);
        await page.close();
      } catch { error.retainedTargetId = binding?.targetId || null; }
    }
    if (targetLease) releaseConversationLease(targetLease);
    if (conversationLease) releaseConversationLease(conversationLease);
    throw error;
  }
}

function releasePageBinding(binding, releaseLease) {
  if (!binding || binding.released) return;
  binding.released = true;
  try { releaseLease(binding.conversationLease); }
  finally { releaseLease(binding.targetLease); }
}

module.exports = { acquirePageBinding, releasePageBinding };
