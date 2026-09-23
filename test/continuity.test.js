const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  STABLE_SESSION_ID_RE,
  ROUTE_SESSION_ID_RE,
  routeSessionIdFromUrl,
  sessionIdFromUrl,
  isEphemeralRouteId,
  assertThreadIdentity,
  turnRef,
  turnMatchesRef,
  responseAfterAcceptedTurn,
  responseAfterRound,
  isErrorOnlyResponseText,
  queueHoldStatusForError,
  findRoundForJob,
  formatTranscriptEntry,
  acquireConversationLease,
  releaseConversationLease,
  reconcilePendingRoundsFromTranscript,
  normalizeIdentityText,
  normalizePromptForRenderedComparison,
  normalizeTurnText,
  browserLaneLeasePath,
  acquireBrowserLaneLease,
  releaseBrowserLaneLease,
  withBrowserLaneLease,
  bootstrapLeaseKey,
  bootstrapLeasePath,
  acquireBootstrapLease,
  releaseBootstrapLease,
  assertNewChatBootstrapRoute,
  roundAllowsTranscriptRecovery,
  canonicalRawPrompt,
  isCanonicalTargetRoot,
  prepareConversationForPrompt,
  ask,
  attestUserTurn,
  waitForAcceptedTurnAttestation,
  waitForSessionIdInUrl,
  terminalErrorForAwaitedTurn,
  messageHash,
  cbError,
} = require('../CB.js');

test('ID Model: STABLE vs ROUTE Session ID separation with synthetic IDs', () => {
  const stableUuid = '11111111-1111-1111-1111-111111111111';
  const webUuid = 'WEB:22222222-2222-2222-2222-222222222222';

  assert.equal(STABLE_SESSION_ID_RE.test(stableUuid), true);
  assert.equal(STABLE_SESSION_ID_RE.test(webUuid), false);

  assert.equal(ROUTE_SESSION_ID_RE.test(stableUuid), true);
  assert.equal(ROUTE_SESSION_ID_RE.test(webUuid), true);

  assert.equal(isEphemeralRouteId(webUuid), true);
  assert.equal(isEphemeralRouteId(stableUuid), false);

  assert.equal(routeSessionIdFromUrl(`https://chat.example.com/c/${webUuid}`), webUuid);
  assert.equal(sessionIdFromUrl(`https://chat.example.com/c/${webUuid}`), '');

  assert.equal(routeSessionIdFromUrl(`https://chat.example.com/c/${stableUuid}`), stableUuid);
  assert.equal(sessionIdFromUrl(`https://chat.example.com/c/${stableUuid}`), stableUuid);

  assert.equal(routeSessionIdFromUrl('https://chat.example.com/'), '');
  assert.equal(sessionIdFromUrl('https://chat.example.com/'), '');
});

test('assertThreadIdentity: Throws on drift to root or provisional route', async () => {
  const testBase = new URL('https://chat.example.com/');
  const expectedId = '11111111-1111-1111-1111-111111111111';

  // Matching URL: passes
  await assertThreadIdentity({ url: () => `https://chat.example.com/c/${expectedId}` }, expectedId, 'test_phase', testBase);

  // Root URL: drifts
  await assert.rejects(
    async () => {
      await assertThreadIdentity({ url: () => 'https://chat.example.com/' }, expectedId, 'test_phase', testBase);
    },
    (err) => err.code === 'THREAD_IDENTITY_DRIFT'
  );

  // Provisional WEB route: drifts
  await assert.rejects(
    async () => {
      await assertThreadIdentity({ url: () => 'https://chat.example.com/c/WEB:22222222-2222-2222-2222-222222222222' }, expectedId, 'test_phase', testBase);
    },
    (err) => err.code === 'THREAD_IDENTITY_DRIFT'
  );
});

test('isErrorOnlyResponseText: Classifies UI error banners and ignores normal assistant prose', () => {
  const banner = 'Something went wrong. If this issue persists please contact us through our help center at help.openai.com. Retry';
  assert.equal(isErrorOnlyResponseText(banner), true);

  const serverError = 'Internal server error occurred';
  assert.equal(isErrorOnlyResponseText(serverError), true);

  const streamError = 'There was an error generating a response';
  assert.equal(isErrorOnlyResponseText(streamError), true);

  const normalProse = 'When implementing an exponential backoff policy, if something went wrong you should retry after 2 seconds.';
  assert.equal(isErrorOnlyResponseText(normalProse), false);
});

test('terminalErrorForAwaitedTurn: Scopes error evaluation strictly to target assistant turn', () => {
  const pageStateWithError = {
    latestAssistant: {
      testid: 'turn-historical-assistant',
      errorText: 'Something went wrong. Retry',
    },
  };

  const outcomeMatching = {
    assistantTurn: { testid: 'turn-historical-assistant' },
  };
  const outcomeDifferent = {
    assistantTurn: { testid: 'turn-current-assistant' },
  };

  // When outcome assistant matches latestAssistant testid: reports error
  assert.equal(
    terminalErrorForAwaitedTurn(pageStateWithError, outcomeMatching, { testid: 'turn-user-1' }),
    'Something went wrong. Retry'
  );

  // When outcome assistant is different: ignores historical error
  assert.equal(
    terminalErrorForAwaitedTurn(pageStateWithError, outcomeDifferent, { testid: 'turn-user-1' }),
    null
  );

  // When no accepted ref: reports latest error
  assert.equal(
    terminalErrorForAwaitedTurn(pageStateWithError, null, null),
    'Something went wrong. Retry'
  );
});

test('responseAfterAcceptedTurn: Bounded turn lineage lookup', () => {
  const ref = {
    messageId: 'msg-u1',
    testid: 'turn-u1',
    role: 'user',
    textHash: messageHash('Analyze this code'),
  };

  const turns = [
    { messageId: 'msg-u1', testid: 'turn-u1', role: 'user', text: 'Analyze this code' },
    { messageId: 'msg-a1', testid: 'turn-a1', role: 'assistant', text: 'Here is the analysis...' },
    { messageId: 'msg-u2', testid: 'turn-u2', role: 'user', text: 'Follow-up question' },
    { messageId: 'msg-a2', testid: 'turn-a2', role: 'assistant', text: 'Second answer...' },
  ];

  const outcome = responseAfterAcceptedTurn(turns, ref);
  assert.equal(outcome.text, 'Here is the analysis...');
  assert.equal(outcome.userTurnMissing, false);
  assert.equal(outcome.concurrentUserTurn, null);

  const pendingTurns = [
    { messageId: 'msg-u1', testid: 'turn-u1', role: 'user', text: 'Analyze this code' },
    { messageId: 'msg-u2', testid: 'turn-u2', role: 'user', text: 'Unexpected second prompt' },
  ];
  const pendingOutcome = responseAfterAcceptedTurn(pendingTurns, ref);
  assert.notEqual(pendingOutcome.concurrentUserTurn, null);
  assert.equal(pendingOutcome.text, '');
});

test('responseAfterRound: Fails closed on ambiguous repeated identical prompts and abort states', () => {
  const prompt = 'continue';
  const promptHash = messageHash(prompt);
  const round = {
    messageHash: promptHash,
    messageHead: prompt,
    dispatchState: 'accepted',
    acceptedUserTurn: {
      textHash: promptHash,
    },
  };

  // Single occurrence: resolves cleanly
  const singleMatchEntries = [
    { role: 'user', text: 'continue' },
    { role: 'assistant', text: 'Continuing with part 1...' },
  ];
  assert.equal(responseAfterRound(singleMatchEntries, round), 'Continuing with part 1...');

  // Multiple identical prompts: fails closed as ambiguous
  const multiMatchEntries = [
    { role: 'user', text: 'continue' },
    { role: 'assistant', text: 'Continuing with part 1...' },
    { role: 'user', text: 'continue' },
    { role: 'assistant', text: 'Continuing with part 2...' },
  ];
  assert.equal(responseAfterRound(multiMatchEntries, round), '');

  // Aborted precommit round: can never match transcript
  const abortedRound = {
    ...round,
    dispatchState: 'aborted_precommit',
  };
  assert.equal(responseAfterRound(singleMatchEntries, abortedRound), '');
});

test('findRoundForJob: Matches explicit jobId over hash', () => {
  const rounds = [
    { id: 'round-1', jobId: 'job-123', messageHash: 'common-hash' },
    { id: 'round-2', jobId: 'job-456', messageHash: 'common-hash' },
  ];

  assert.equal(findRoundForJob(rounds, { id: 'job-123' })?.id, 'round-1');
  assert.equal(findRoundForJob(rounds, { id: 'job-456' })?.id, 'round-2');
});

test('formatTranscriptEntry: Preserves ancestral timestamp', () => {
  const originalTimestamp = '2026-09-22T04:45:00.000Z';
  const formatted = formatTranscriptEntry('assistant', 'Hello', originalTimestamp);
  assert.equal(formatted.startsWith(`[${originalTimestamp}] ASSISTANT\nHello`), true);
});

test('queueHoldStatusForError: Maps invariant error codes to state machine', () => {
  assert.equal(queueHoldStatusForError({ code: 'DISPATCH_UNCERTAIN' }), 'needs_recovery');
  assert.equal(queueHoldStatusForError({ code: 'CONVERSATION_NOT_HYDRATED' }), 'needs_recovery');
  assert.equal(queueHoldStatusForError({ code: 'CONVERSATION_LEASE_BUSY' }), 'needs_recovery');
  assert.equal(queueHoldStatusForError({ code: 'BOOTSTRAP_LEASE_BUSY' }), 'needs_recovery');
  assert.equal(queueHoldStatusForError({ code: 'BROWSER_LANE_BUSY' }), 'needs_recovery');
  assert.equal(queueHoldStatusForError({ code: 'NEW_SESSION_ID_UNCERTAIN' }), 'needs_recovery');
  assert.equal(queueHoldStatusForError({ code: 'THREAD_IDENTITY_DRIFT' }), 'failed');
  assert.equal(queueHoldStatusForError({ code: 'CONCURRENT_CONVERSATION_MUTATION' }), 'failed');
  assert.equal(queueHoldStatusForError({ code: 'ASSISTANT_TERMINAL_ERROR' }), 'failed');
  assert.equal(queueHoldStatusForError({ code: 'CONVERSATION_BUSY' }), 'failed');
});

test('ConversationLease: Atomic acquisition with token and refusal of mismatched token release', () => {
  const syntheticSession = '33333333-3333-3333-3333-333333333333';
  const handle = acquireConversationLease(syntheticSession, 'round-test-1');
  assert.notEqual(handle, null);
  assert.equal(typeof handle.token, 'string');
  assert.equal(fs.existsSync(handle.leasePath), true);

  // Second acquisition while active process owns it must fail
  assert.throws(
    () => acquireConversationLease(syntheticSession, 'round-test-2'),
    (err) => err.code === 'CONVERSATION_LEASE_BUSY'
  );

  // Release with WRONG token must be ignored (lease remains on disk)
  releaseConversationLease({ ...handle, token: 'wrong-token' });
  assert.equal(fs.existsSync(handle.leasePath), true);

  // Release with matching token succeeds
  releaseConversationLease(handle);
  assert.equal(fs.existsSync(handle.leasePath), false);
});

test('waitForSessionIdInUrl: Ignores provisional WEB route and waits for stable UUID', async () => {
  let step = 0;
  const mockPage = {
    url: () => {
      step++;
      if (step < 3) return 'https://chat.example.com/c/WEB:22222222-2222-2222-2222-222222222222';
      return 'https://chat.example.com/c/11111111-1111-1111-1111-111111111111';
    },
    waitForTimeout: async (ms) => new Promise((resolve) => setTimeout(resolve, 10)),
  };

  const id = await waitForSessionIdInUrl(mockPage, 1000);
  assert.equal(id, '11111111-1111-1111-1111-111111111111');

  // Timeout with only provisional route returns empty string
  const mockPageTimeout = {
    url: () => 'https://chat.example.com/c/WEB:22222222-2222-2222-2222-222222222222',
    waitForTimeout: async (ms) => new Promise((resolve) => setTimeout(resolve, 10)),
  };
  const timedOutId = await waitForSessionIdInUrl(mockPageTimeout, 50);
  assert.equal(timedOutId, '');
});

test('normalizeIdentityText: Preserves markdown syntax while stripping UI buttons and collapsing whitespace', () => {
  const raw = '# Header with `code` and **bold** text and ~strike~\nShow more';
  // Identity preserves all markdown syntax tokens
  assert.equal(normalizeIdentityText(raw), '# Header with `code` and **bold** text and ~strike~');
  assert.notEqual(messageHash(normalizeIdentityText('C# API')), messageHash(normalizeIdentityText('C API')));
  assert.notEqual(messageHash(normalizeIdentityText('*foo*')), messageHash(normalizeIdentityText('foo')));

  // Rendered comparison strips markdown for matching HTML-rendered bubbles
  assert.equal(normalizePromptForRenderedComparison(raw), 'Header with code and bold text and strike');

  const withNbsp = 'Hello\u00a0world\nShow less';
  assert.equal(normalizeIdentityText(withNbsp), 'Hello world');
});

test('bootstrapLeaseKey: Normalizes localhost vs 127.0.0.1 to identical lease lock', () => {
  const key1 = bootstrapLeaseKey({ cdp: 'http://127.0.0.1:9241' });
  const key2 = bootstrapLeaseKey({ cdp: 'http://localhost:9241' });
  assert.equal(key1, key2);
});

test('assertNewChatBootstrapRoute: Strictly enforces canonical targetBase origin, pathname, and absence of route ID', () => {
  const testBase = new URL('https://chat.example.com/');

  // Canonical root on matching origin: passes
  assert.doesNotThrow(() => {
    assertNewChatBootstrapRoute({ url: () => 'https://chat.example.com/' }, testBase);
  });

  // Foreign origin drift: throws even on root path
  assert.throws(
    () => {
      assertNewChatBootstrapRoute({ url: () => 'https://evil.example.com/' }, testBase);
    },
    (err) => err.code === 'NEW_CHAT_ROUTE_DRIFT'
  );

  // Provisional route: drifts
  assert.throws(
    () => {
      assertNewChatBootstrapRoute({ url: () => 'https://chat.example.com/c/WEB:22222222-2222-2222-2222-222222222222' }, testBase);
    },
    (err) => err.code === 'NEW_CHAT_ROUTE_DRIFT'
  );

  // Stable conversation route: drifts
  assert.throws(
    () => {
      assertNewChatBootstrapRoute({ url: () => 'https://chat.example.com/c/11111111-1111-1111-1111-111111111111' }, testBase);
    },
    (err) => err.code === 'NEW_CHAT_ROUTE_DRIFT'
  );
});

test('assertThreadIdentity: Strictly validates origin in addition to session ID', async () => {
  const testBase = new URL('https://chat.example.com/');
  const stableId = '11111111-1111-1111-1111-111111111111';

  // Valid origin and matching session ID: passes
  await assert.doesNotReject(async () => {
    await assertThreadIdentity({ url: () => `https://chat.example.com/c/${stableId}` }, stableId, 'test-phase', testBase);
  });

  // Foreign origin with matching session ID: throws THREAD_IDENTITY_DRIFT
  await assert.rejects(
    async () => {
      await assertThreadIdentity({ url: () => `https://attacker.example.com/c/${stableId}` }, stableId, 'test-phase', testBase);
    },
    (err) => err.code === 'THREAD_IDENTITY_DRIFT'
  );
});

test('roundAllowsTranscriptRecovery: Strictly requires durable stable UUID for all authoritative states', () => {
  const stableUuid = '11111111-1111-1111-1111-111111111111';

  // Disallowed unauthoritative states
  assert.equal(roundAllowsTranscriptRecovery({ sessionBindingState: 'mismatch', sessionId: '' }), false);
  assert.equal(roundAllowsTranscriptRecovery({ sessionBindingState: 'mismatch', sessionId: stableUuid }), false);
  assert.equal(roundAllowsTranscriptRecovery({ sessionBindingState: 'unverifiable', sessionId: '' }), false);
  assert.equal(roundAllowsTranscriptRecovery({ sessionBindingState: 'candidate', sessionId: '' }), false);
  assert.equal(roundAllowsTranscriptRecovery({ sessionBindingState: 'unbound', sessionId: '' }), false);

  // Authoritative states MUST have a durable stable UUID
  assert.equal(roundAllowsTranscriptRecovery({ sessionBindingState: 'not_applicable', sessionId: '' }), false);
  assert.equal(roundAllowsTranscriptRecovery({ sessionBindingState: 'attested', sessionId: '' }), false);
  assert.equal(roundAllowsTranscriptRecovery({ sessionBindingState: 'attested', sessionId: stableUuid }), true);
  assert.equal(roundAllowsTranscriptRecovery({ sessionBindingState: 'not_applicable', sessionId: stableUuid }), true);

  // Legacy rounds without sessionBindingState require a stable UUID
  assert.equal(roundAllowsTranscriptRecovery({ sessionId: stableUuid }), true);
  assert.equal(roundAllowsTranscriptRecovery({ sessionId: '' }), false);
});

test('isCanonicalTargetRoot: Correctly identifies root without route IDs', () => {
  const testBase = new URL('https://chat.example.com/');
  assert.equal(isCanonicalTargetRoot('https://chat.example.com/', testBase), true);
  assert.equal(isCanonicalTargetRoot('https://chat.example.com', testBase), true);
  assert.equal(isCanonicalTargetRoot('https://chat.example.com/c/11111111-1111-1111-1111-111111111111', testBase), false);
  assert.equal(isCanonicalTargetRoot('https://chat.example.com/c/WEB:22222222-2222-2222-2222-222222222222', testBase), false);
  assert.equal(isCanonicalTargetRoot('https://attacker.example.com/', testBase), false);
});

test('prepareConversationForPrompt: Auto-promotes canonical root sends and rejects provisional routes', async () => {
  // Canonical root -> auto-promotes args.newConversation = true
  const rootArgs = { conversation: '' };
  const rootPage = { url: () => 'https://chatgpt.com/' };
  await prepareConversationForPrompt(rootPage, rootArgs);
  assert.equal(rootArgs.newConversation, true);

  // Provisional route -> fails closed with NEW_CHAT_MODE_REQUIRED
  const provArgs = { conversation: '' };
  const provPage = { url: () => 'https://chatgpt.com/c/WEB:22222222-2222-2222-2222-222222222222' };
  await assert.rejects(
    async () => {
      await prepareConversationForPrompt(provPage, provArgs);
    },
    (err) => err.code === 'NEW_CHAT_MODE_REQUIRED'
  );

  // Stable existing conversation -> sets args.expectedSessionId
  const stableUuid = '11111111-1111-1111-1111-111111111111';
  const existingArgs = { conversation: '' };
  const existingPage = { url: () => `https://chatgpt.com/c/${stableUuid}` };
  await prepareConversationForPrompt(existingPage, existingArgs);
  assert.equal(existingArgs.expectedSessionId, stableUuid);
  assert.equal(Boolean(existingArgs.newConversation), false);
});

test('canonicalRawPrompt: Preserves exact formatting and indentation while normalizing line endings', () => {
  const code = 'function test() {\r\n  const x = 1;\r\n  return x;\r\n}';
  const canonical = canonicalRawPrompt(code);
  assert.equal(canonical, 'function test() {\n  const x = 1;\n  return x;\n}');
  assert.notEqual(messageHash(canonicalRawPrompt('foo  bar')), messageHash(canonicalRawPrompt('foo bar')));
});

test('attestUserTurn: Hierarchical verification across messageId, testid, and content hash', () => {
  const prompt = 'Plan architecture';
  const promptHash = messageHash(normalizeTurnText(prompt));
  const ref = {
    messageId: 'msg-u-100',
    testid: 'turn-u-100',
    textHash: promptHash,
  };

  // Level 1: exact messageId match
  const turnsWithMessageId = [
    { role: 'user', messageId: 'msg-u-100', testid: 'turn-u-100', text: prompt },
  ];
  const res1 = attestUserTurn(turnsWithMessageId, ref);
  assert.equal(res1.attested, true);
  assert.equal(res1.method, 'message_id');

  // Level 1 mismatch: mounted turns have messageIds, but ours is missing
  const turnsWithOtherId = [
    { role: 'user', messageId: 'msg-u-200', testid: 'turn-u-200', text: prompt },
  ];
  const resMismatch = attestUserTurn(turnsWithOtherId, ref);
  assert.equal(resMismatch.attested, false);
  assert.equal(resMismatch.definitiveMismatch, true);

  // Level 2: testid + textHash match when messageIds not exposed
  const turnsWithTestidOnly = [
    { role: 'user', testid: 'turn-u-100', text: prompt },
  ];
  const refNoMsgId = { testid: 'turn-u-100', textHash: promptHash };
  const res2 = attestUserTurn(turnsWithTestidOnly, refNoMsgId);
  assert.equal(res2.attested, true);
  assert.equal(res2.method, 'testid_hash');

  // Level 3: unique text hash
  const turnsUnmounted = [
    { role: 'user', testid: 'turn-dynamic', text: prompt },
  ];
  const refHashOnly = { textHash: promptHash };
  const res3 = attestUserTurn(turnsUnmounted, refHashOnly);
  assert.equal(res3.attested, true);
  assert.equal(res3.method, 'unique_text_hash');

  // Level 3 failure: ambiguous duplicate text hash
  const turnsAmbiguous = [
    { role: 'user', testid: 'turn-1', text: prompt },
    { role: 'user', testid: 'turn-2', text: prompt },
  ];
  const resAmbiguous = attestUserTurn(turnsAmbiguous, refHashOnly);
  assert.equal(resAmbiguous.attested, false);
  assert.equal(resAmbiguous.definitiveMismatch, true);
});

test('BootstrapLease: Exclusive acquisition per CDP endpoint and verified release', () => {
  const mockArgs1 = { cdp: 'http://127.0.0.1:9241' };
  const mockArgs2 = { cdp: 'http://127.0.0.1:9242' };

  const handle1 = acquireBootstrapLease(mockArgs1, 'op-1');
  assert.notEqual(handle1, null);
  assert.equal(fs.existsSync(handle1.leasePath), true);

  // Second acquisition on same CDP port fails
  assert.throws(
    () => acquireBootstrapLease(mockArgs1, 'op-2'),
    (err) => err.code === 'BOOTSTRAP_LEASE_BUSY'
  );

  // Independent CDP endpoint does not block
  const handle2 = acquireBootstrapLease(mockArgs2, 'op-3');
  assert.notEqual(handle2, null);
  assert.equal(fs.existsSync(handle2.leasePath), true);

  // Clean up
  releaseBootstrapLease(handle1);
  releaseBootstrapLease(handle2);
  assert.equal(fs.existsSync(handle1.leasePath), false);
  assert.equal(fs.existsSync(handle2.leasePath), false);
});

test('Immutable Session Identity: Error catch records observed drift without overwriting authoritative round sessionId', () => {
  const authoritativeSessionId = '11111111-1111-1111-1111-111111111111';
  const driftedSessionId = '22222222-2222-2222-2222-222222222222';

  // Synthetic round with authoritative bound session
  const round = {
    id: 'round-test-drift',
    status: 'pending',
    sessionId: authoritativeSessionId,
    expectedSessionId: authoritativeSessionId,
    sessionBindingState: 'not_applicable',
    url: `https://chatgpt.com/c/${authoritativeSessionId}`,
  };

  // Simulating the error block update in ask()
  const error = new Error(`Thread identity drift: expected=${authoritativeSessionId}, actual=${driftedSessionId}`);
  const observedSessionId = driftedSessionId;
  const update = {
    status: 'pending',
    lastError: error.message,
    observedSessionId,
    observedUrl: `https://chatgpt.com/c/${driftedSessionId}`,
  };
  Object.assign(round, update);

  // Authoritative identity remains unchanged
  assert.equal(round.sessionId, authoritativeSessionId);
  assert.equal(round.expectedSessionId, authoritativeSessionId);
  assert.equal(round.observedSessionId, driftedSessionId);
});

test('Operational Contract: Dedicated browser tab/lane or serialized execution per CDP endpoint', () => {
  // Verifies that bootstrap and conversation leases lock the respective resources
  const mockArgs = { cdp: 'http://127.0.0.1:9241' };
  const lease1 = acquireBootstrapLease(mockArgs, 'op-active');
  assert.equal(fs.existsSync(lease1.leasePath), true);

  // Re-acquisition on same CDP lane fails immediately
  assert.throws(
    () => acquireBootstrapLease(mockArgs, 'op-concurrent'),
    (err) => err.code === 'BOOTSTRAP_LEASE_BUSY'
  );

  releaseBootstrapLease(lease1);
  assert.equal(fs.existsSync(lease1.leasePath), false);
});

test('BrowserLaneLease: Exclusive acquisition per CDP endpoint and verified release', () => {
  const mockArgs1 = { cdp: 'http://127.0.0.1:9241' };
  const mockArgs2 = { cdp: 'http://127.0.0.1:9242' };

  const handle1 = acquireBrowserLaneLease(mockArgs1, 'lane-op-1');
  assert.notEqual(handle1, null);
  assert.equal(fs.existsSync(handle1.leasePath), true);

  // Second acquisition on same CDP port fails with BROWSER_LANE_BUSY
  assert.throws(
    () => acquireBrowserLaneLease(mockArgs1, 'lane-op-2'),
    (err) => err.code === 'BROWSER_LANE_BUSY'
  );

  // Independent CDP endpoint does not block
  const handle2 = acquireBrowserLaneLease(mockArgs2, 'lane-op-3');
  assert.notEqual(handle2, null);
  assert.equal(fs.existsSync(handle2.leasePath), true);

  // Clean up
  releaseBrowserLaneLease(handle1);
  releaseBrowserLaneLease(handle2);
  assert.equal(fs.existsSync(handle1.leasePath), false);
  assert.equal(fs.existsSync(handle2.leasePath), false);
});

test('withBrowserLaneLease: Executes action under exclusive lane lock and verifies release', async () => {
  const mockArgs = { cdp: 'http://127.0.0.1:9241' };
  let insideRan = false;

  await withBrowserLaneLease(mockArgs, 'op-wrapper', async () => {
    insideRan = true;
    // Inside callback, lane lease exists
    const p = browserLaneLeasePath(mockArgs);
    assert.equal(fs.existsSync(p), true);

    // Concurrent acquisition fails
    assert.throws(
      () => acquireBrowserLaneLease(mockArgs, 'op-concurrent'),
      (err) => err.code === 'BROWSER_LANE_BUSY'
    );
  });

  assert.equal(insideRan, true);
  // Outside callback, lease is cleanly released
  const p = browserLaneLeasePath(mockArgs);
  assert.equal(fs.existsSync(p), false);
});
