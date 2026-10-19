const test = require('node:test');
const assert = require('node:assert/strict');
const { acquirePageBinding, releasePageBinding } = require('../lib/page-binding');

function fixture() {
  const origin = 'https://chatgpt.com';
  const locks = new Set();
  let topology = false;
  let sequence = 0;
  const pages = [];
  const session = '11111111-1111-4111-8111-111111111111';
  const makePage = (id, initialUrl) => {
    let url = initialUrl;
    return { id, url: () => url, goto: async destination => {
      assert.equal(topology, false, 'navigation is outside topology lock');
      assert.ok(locks.has(`target:${id}`), 'target is owned before navigation');
      url = destination;
    } };
  };
  const lock = (key, code) => {
    if (locks.has(key)) throw Object.assign(new Error('busy'), { code });
    locks.add(key); return { key, token: key, fence: 1 };
  };
  const deps = {
    cbError: (code, message) => Object.assign(new Error(message), { code }),
    getPageTargetId: async page => page.id,
    acquireTargetLease: (cdp, id) => lock(`target:${id}`, 'BROWSER_LANE_BUSY'),
    acquireConversationLease: id => lock(`conversation:${id}`, 'CONVERSATION_LEASE_BUSY'),
    releaseConversationLease: lease => { if (lease) locks.delete(lease.key); },
    withTopologyLease: async (args, id, fn) => { topology = true; try { return await fn(); } finally { topology = false; } },
    normalizeCdpUrl: cdp => cdp || 'http://localhost:9222',
    sessionIdFromUrl: url => url.startsWith(`${origin}/c/`) ? url.split('/c/')[1] : '',
    isTargetAppUrl: url => url.startsWith(`${origin}/`),
    targetAppUrl: () => `${origin}/`,
    targetConversationUrl: id => `${origin}/c/${id}`,
    parseConversationRef: ref => ({ sessionId: ref === 'known' ? session : ref }),
    loadConversationIndex: () => ({}), randomId: () => 'test-op',
    assertLeaseCurrent: lease => assert.ok(locks.has(lease.key)),
  };
  const context = { pages: () => pages, newPage: async () => { const page = makePage(`new-${++sequence}`, 'about:blank'); pages.push(page); return page; } };
  const browser = { contexts: () => [context] };
  return { session, origin, locks, pages, makePage, deps, browser };
}

test('owned binding rejects held targets and releases all resources', async () => {
  const f = fixture();
  f.pages.push(f.makePage('A', `${f.origin}/c/${f.session}`));
  const args = { targetId: 'A' };
  const binding = await acquirePageBinding(f.browser, args, f.deps);
  assert.equal(binding.targetId, 'A');
  assert.equal(binding.conversationId, f.session);
  await assert.rejects(acquirePageBinding(f.browser, { targetId: 'A' }, f.deps), { code: 'BROWSER_LANE_BUSY' });
  releasePageBinding(binding, f.deps.releaseConversationLease);
  assert.equal(f.locks.size, 0);
});

test('current is ambiguous and unpinned reads never allocate', async () => {
  const f = fixture();
  await assert.rejects(acquirePageBinding(f.browser, { status: true }, f.deps), { code: 'TARGET_BINDING_REQUIRED' });
  assert.equal(f.pages.length, 0);
  f.pages.push(f.makePage('A', `${f.origin}/c/${f.session}`), f.makePage('B', `${f.origin}/`));
  await assert.rejects(acquirePageBinding(f.browser, { conversation: 'current' }, f.deps), { code: 'PAGE_TARGET_AMBIGUOUS' });
  assert.equal(f.locks.size, 0);
});

test('new allocation owns target before navigation and releases topology first', async () => {
  const f = fixture();
  f.pages.push(f.makePage('foreign', 'https://example.org/'));
  const binding = await acquirePageBinding(f.browser, { message: 'new work' }, f.deps);
  assert.equal(binding.page.url(), `${f.origin}/`);
  assert.equal(f.pages[0].url(), 'https://example.org/');
  releasePageBinding(binding, f.deps.releaseConversationLease);
  assert.equal(f.locks.size, 0);
});

test('target origin and conversation mismatch fail without navigation', async () => {
  const f = fixture();
  f.pages.push(f.makePage('foreign', 'https://example.org/'), f.makePage('A', `${f.origin}/c/${f.session}`));
  await assert.rejects(acquirePageBinding(f.browser, { targetId: 'foreign' }, f.deps), { code: 'PAGE_ORIGIN_MISMATCH' });
  await assert.rejects(acquirePageBinding(f.browser, { targetId: 'A', expectedSessionId: 'different' }, f.deps), { code: 'THREAD_IDENTITY_DRIFT' });
  assert.equal(f.locks.size, 0);
  assert.equal(f.pages[1].url(), `${f.origin}/c/${f.session}`);
});


test('branch recovery never allocates a page and binds only an existing candidate', async () => {
  const f = fixture();
  await assert.rejects(acquirePageBinding(f.browser, { recoverBranchId: 'incident' }, f.deps), { code: 'TARGET_BINDING_REQUIRED' });
  await assert.rejects(acquirePageBinding(f.browser, { recoverBranchId: 'incident', expectedSessionId: f.session }, f.deps), { code: 'PAGE_TARGET_NOT_FOUND' });
  assert.equal(f.pages.length, 0);
  f.pages.push(f.makePage('candidate', `${f.origin}/c/${f.session}`));
  const binding = await acquirePageBinding(f.browser, { recoverBranchId: 'incident', expectedSessionId: f.session }, f.deps);
  assert.equal(binding.targetId, 'candidate');
  releasePageBinding(binding, f.deps.releaseConversationLease);
});

test('allocation failure closes only its owned new page before releasing locks', async () => {
  const f = fixture();
  const context = f.browser.contexts()[0];
  let closed = false;
  context.newPage = async () => ({ id: 'failing', url: () => 'about:blank',
    goto: async () => { throw new Error('navigation failed'); },
    close: async () => { assert.ok(f.locks.has('target:failing')); closed = true; } });
  await assert.rejects(acquirePageBinding(f.browser, { newTab: true }, f.deps), /navigation failed/);
  assert.equal(closed, true);
  assert.equal(f.locks.size, 0);
});
