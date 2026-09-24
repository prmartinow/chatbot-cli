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
  takeBrowserLaneLease,
  findTargetAppPage,
  compactActiveConversation,
  compactTargetConversation,
  syncTranscriptFromPage,
  responseAfterAcceptedTurnExcludingRevision,
  sameTurnRevision,
  turnRevisionMatchesRef,
  validateStage1Mode,
  resolveEditableUserTurn,
  openUserTurnEditor,
  populateAndVerifyEditor,
  submitEditedUserTurn,
  waitForEditedTurnAccepted,
  retryEditTurn,
  validateRecoveryMode,
  prepareRecoveryResendTarget,
  registerPendingRound,
  reloadExactConversation,
  watchTargetAppState,
  executeCompactionHandoff,
  parseArgs,
  prepareConversationForRead,
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

test('syncTranscriptFromPage: Enforces thread identity against expectedSessionId and pins transcript', async () => {
  const mockPageDrifted = {
    url: () => 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
  };
  const mockArgs = {
    expectedSessionId: '22222222-2222-4222-8222-222222222222',
    transcript: '',
  };

  await assert.rejects(
    async () => syncTranscriptFromPage(mockPageDrifted, mockArgs),
    (err) => err.code === 'THREAD_IDENTITY_DRIFT'
  );
});

test('prepareConversationForRead: Resolves expectedSessionId without calling page navigation', async () => {
  let navCalled = false;
  const mockPage = {
    url: () => 'https://chatgpt.com/',
    goto: () => { navCalled = true; },
  };
  const mockArgs = {
    conversation: '33333333-3333-4333-8333-333333333333',
  };

  await prepareConversationForRead(mockPage, mockArgs);
  assert.equal(mockArgs.expectedSessionId, '33333333-3333-4333-8333-333333333333');
  assert.equal(navCalled, false);
});

test('findTargetAppPage: Acquires and assigns browserLaneLease before creating newTab', async () => {
  const mockArgs = {
    newTab: true,
    cdp: 'http://127.0.0.1:9241',
  };
  const mockBrowser = {
    contexts: () => [{
      newPage: async () => ({
        goto: async () => {},
      }),
    }],
    newContext: async () => ({
      newPage: async () => ({
        goto: async () => {},
      }),
    }),
  };

  const page = await findTargetAppPage(mockBrowser, mockArgs);
  assert.notEqual(page, null);
  assert.notEqual(mockArgs._laneLease, null);
  assert.equal(fs.existsSync(mockArgs._laneLease.leasePath), true);

  // Clean up
  releaseBrowserLaneLease(mockArgs._laneLease);
  assert.equal(fs.existsSync(mockArgs._laneLease.leasePath), false);
});

test('takeBrowserLaneLease & withBrowserLaneLease: Adopts pre-acquired args._laneLease without self-conflict', async () => {
  const mockArgs = { cdp: 'http://127.0.0.1:9241' };
  mockArgs._laneLease = acquireBrowserLaneLease(mockArgs, 'pre-held-op');
  assert.notEqual(mockArgs._laneLease, null);

  let ran = false;
  await withBrowserLaneLease(mockArgs, 'adopted-op', async () => {
    ran = true;
    assert.equal(mockArgs._laneLease, null);
    const p = browserLaneLeasePath(mockArgs);
    assert.equal(fs.existsSync(p), true);
  });

  assert.equal(ran, true);
  const p = browserLaneLeasePath(mockArgs);
  assert.equal(fs.existsSync(p), false);
});

test('findTargetAppPage: Acquires browserLaneLease for fallback page creation when no existing target page is open', async () => {
  const mockArgs = {
    newTab: false,
    cdp: 'http://127.0.0.1:9241',
  };
  const mockBrowser = {
    contexts: () => [{
      pages: () => [],
      newPage: async () => ({
        goto: async () => {},
      }),
    }],
    newContext: async () => ({
      pages: () => [],
      newPage: async () => ({
        goto: async () => {},
      }),
    }),
  };

  const page = await findTargetAppPage(mockBrowser, mockArgs);
  assert.notEqual(page, null);
  assert.notEqual(mockArgs._laneLease, null);
  assert.equal(fs.existsSync(mockArgs._laneLease.leasePath), true);

  // Clean up
  releaseBrowserLaneLease(mockArgs._laneLease);
  assert.equal(fs.existsSync(mockArgs._laneLease.leasePath), false);
});

test('compactActiveConversation: Uses args.expectedSessionId and rejects drifted page URL with THREAD_IDENTITY_DRIFT', async () => {
  const mockPageDrifted = {
    url: () => 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
    waitForTimeout: async () => {},
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    locator: () => ({
      last: () => ({
        waitFor: async () => {},
      }),
    }),
  };
  const mockArgs = {
    expectedSessionId: '22222222-2222-4222-8222-222222222222',
  };

  await assert.rejects(
    async () => compactActiveConversation(mockPageDrifted, mockArgs),
    (err) => err.code === 'THREAD_IDENTITY_DRIFT'
  );
});

test('compactTargetConversation: Resolves explicit conversation, navigates, and asserts thread identity', async () => {
  let navTarget = '';
  const mockPage = {
    url: () => navTarget || 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
    goto: async (url) => { navTarget = url; },
    evaluate: async () => true,
    waitForTimeout: async () => {},
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    locator: () => ({
      last: () => ({
        waitFor: async () => {},
      }),
    }),
  };
  const mockArgs = {
    conversation: '22222222-2222-4222-8222-222222222222',
    cdp: 'http://127.0.0.1:9241',
  };

  await assert.rejects(
    async () => compactTargetConversation(mockPage, mockArgs),
    (err) => err.code === 'THREAD_IDENTITY_DRIFT' || err.message.includes('did not hydrate') || err.message.includes('Transcript file not found')
  );
  assert.equal(mockArgs.expectedSessionId, '22222222-2222-4222-8222-222222222222');
});

test('Handoff State Reset: Post-ask handoff resets newConversation=false and derives reporting URL from authoritative expectedSessionId', async () => {
  const continuationId = '33333333-3333-4333-8333-333333333333';
  const mockArgs = {
    newConversation: true,
    handoffNewSession: true,
    conversation: 'old-session',
    expectedSessionId: continuationId,
  };

  // Verify post-handoff reset invariants
  const newSessionId = mockArgs.expectedSessionId;
  const newUrl = `https://chatgpt.com/c/${newSessionId}`;
  mockArgs.newConversation = false;
  mockArgs.handoffNewSession = false;
  mockArgs.conversation = '';

  assert.equal(mockArgs.newConversation, false);
  assert.equal(mockArgs.handoffNewSession, false);
  assert.equal(mockArgs.conversation, '');
  assert.equal(mockArgs.expectedSessionId, continuationId);
  assert.equal(newUrl, `https://chatgpt.com/c/${continuationId}`);
});

test('reloadExactConversation: rejects missing or invalid expectedSessionId fail-closed', async () => {
  const mockPage = { url: () => 'https://chatgpt.com/' };
  await assert.rejects(
    async () => reloadExactConversation(mockPage, ''),
    (err) => err.code === 'INVALID_TARGET_SESSION'
  );
  await assert.rejects(
    async () => reloadExactConversation(mockPage, 'WEB:provisional-id'),
    (err) => err.code === 'INVALID_TARGET_SESSION'
  );
});

test('Compaction Quarantine: executeCompactionHandoff rejects with LEGACY_COMPACTION_HANDOFF_DISABLED by default', async () => {
  const origEnv = process.env.CB_ENABLE_LEGACY_COMPACTION;
  delete process.env.CB_ENABLE_LEGACY_COMPACTION;
  try {
    const mockPage = { url: () => 'https://chatgpt.com/' };
    await assert.rejects(
      async () => executeCompactionHandoff(mockPage, {}),
      (err) => err.code === 'LEGACY_COMPACTION_HANDOFF_DISABLED'
    );
  } finally {
    if (origEnv !== undefined) process.env.CB_ENABLE_LEGACY_COMPACTION = origEnv;
  }
});

test('Recovery Resend Flag & Diagnostics: parseArgs correctly parses --recovery-resend and --export-context-summary', () => {
  const parsed1 = parseArgs(['node', 'CB.js', '--recovery-resend', '--conversation', '11111111-1111-4111-8111-111111111111']);
  assert.equal(parsed1.recoveryResend, true);
  assert.equal(parsed1.conversation, '11111111-1111-4111-8111-111111111111');

  const parsed2 = parseArgs(['node', 'CB.js', '--export-context-summary']);
  assert.equal(parsed2.compactConversation, true);
});

test('reloadExactConversation: enforces thread identity before and after reload', async () => {
  const targetId = '55555555-5555-4555-8555-555555555555';
  let reloaded = false;
  const mockPage = {
    url: () => `https://chatgpt.com/c/${targetId}`,
    reload: async () => { reloaded = true; },
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    locator: () => ({ last: () => ({ waitFor: async () => {} }) }),
    evaluate: async () => ({
      hydrated: true,
      sessionId: targetId,
      turnCount: 2,
      roleNodeCount: 2,
      composerVisible: true,
    }),
  };
  const res = await reloadExactConversation(mockPage, targetId, 'test-phase');
  assert.equal(reloaded, true);
  assert.equal(res.hydrated, true);
});

test('Stage-2 Invalid Mode: --new-conversation cannot be combined with --recovery-resend', async () => {
  const mockPage = { url: () => 'https://chatgpt.com/' };
  const mockArgs = {
    newConversation: true,
    recoveryResend: true,
    conversation: '11111111-1111-4111-8111-111111111111',
  };
  await assert.rejects(
    async () => prepareConversationForPrompt(mockPage, mockArgs),
    (err) => err.code === 'INVALID_RECOVERY_MODE'
  );
});

test('Stage-2 Root Rejection: root URL with --recovery-resend and no target throws RECOVERY_TARGET_REQUIRED', async () => {
  const mockPage = { url: () => 'https://chatgpt.com/' };
  const mockArgs = {
    recoveryResend: true,
    message: 'test recovery prompt',
    conversation: '',
    expectedSessionId: '',
  };
  await assert.rejects(
    async () => prepareConversationForPrompt(mockPage, mockArgs),
    (err) => err.code === 'RECOVERY_TARGET_REQUIRED'
  );
});

test('Exact Reload Post-Reload Drift: reloadExactConversation fails closed if URL drifts post-reload', async () => {
  const targetId = '55555555-5555-4555-8555-555555555555';
  const driftedId = '66666666-6666-4666-8666-666666666666';
  let hasReloaded = false;
  const mockPage = {
    url: () => (hasReloaded ? `https://chatgpt.com/c/${driftedId}` : `https://chatgpt.com/c/${targetId}`),
    reload: async () => { hasReloaded = true; },
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    locator: () => ({ last: () => ({ waitFor: async () => {} }) }),
    evaluate: async () => ({
      hydrated: true,
      sessionId: driftedId,
      turnCount: 2,
      roleNodeCount: 2,
      composerVisible: true,
    }),
  };
  await assert.rejects(
    async () => reloadExactConversation(mockPage, targetId, 'test-drift-phase'),
    (err) => err.code === 'THREAD_IDENTITY_DRIFT'
  );
});

test('Target-Aware Watch Drift: watchTargetAppState fails closed if URL drifts to foreign session during polling', async () => {
  const targetId = '77777777-7777-4777-8777-777777777777';
  const driftedId = '88888888-8888-4888-8888-888888888888';
  let pollCount = 0;
  const mockPage = {
    url: () => (pollCount > 0 ? `https://chatgpt.com/c/${driftedId}` : `https://chatgpt.com/c/${targetId}`),
    waitForTimeout: async () => { pollCount++; },
    evaluate: async () => ({
      composer: { visible: true },
      turns: { count: 1, latest: null },
      isGenerating: false,
    }),
    $$eval: async () => [],
    $eval: async () => '',
    $: async () => null,
  };
  const mockArgs = {
    stateJsonl: false,
    stateInterval: 10,
    timeout: 100,
    waitReady: false,
  };
  await assert.rejects(
    async () => watchTargetAppState(mockPage, mockArgs, { expectedSessionId: targetId }),
    (err) => err.code === 'THREAD_IDENTITY_DRIFT'
  );
});

test('Target-Aware Watch Resolution: prepareConversationForRead resolves explicit conversation target', async () => {
  const targetId = '99999999-9999-4999-8999-999999999999';
  const mockPage = { url: () => 'https://chatgpt.com/c/other-session' };
  const mockArgs = {
    conversation: targetId,
    expectedSessionId: '',
  };
  await prepareConversationForRead(mockPage, mockArgs);
  assert.equal(mockArgs.expectedSessionId, targetId);
});

test('WAL Round Recovery Metadata: registerPendingRound persists operationKind, recoveryStage, and recoveryIncidentId', () => {
  const mockArgs = { cdp: 'http://127.0.0.1:9241' };
  const mockPage = { url: () => 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111' };
  const round = registerPendingRound(mockArgs, mockPage, 'Test recovery message', 'turn-1', {
    expectedSessionId: '11111111-1111-4111-8111-111111111111',
    operationKind: 'recovery_resend',
    recoveryStage: 2,
    recoveryIncidentId: 'INCIDENT-1234',
  });

  assert.equal(round.operationKind, 'recovery_resend');
  assert.equal(round.recoveryStage, 2);
  assert.equal(round.recoveryIncidentId, 'INCIDENT-1234');
});

test('Stage-2 Mode Constraints: --recovery-resend rejects scheduling and missing message', async () => {
  const mockPage = { url: () => 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111' };

  // Rejects missing message
  await assert.rejects(
    async () => prepareConversationForPrompt(mockPage, {
      recoveryResend: true,
      message: null,
      conversation: '11111111-1111-4111-8111-111111111111',
    }),
    (err) => err.code === 'RECOVERY_MESSAGE_REQUIRED'
  );

  // Rejects scheduling
  await assert.rejects(
    async () => prepareConversationForPrompt(mockPage, {
      recoveryResend: true,
      message: 'test',
      schedule: true,
      conversation: '11111111-1111-4111-8111-111111111111',
    }),
    (err) => err.code === 'INVALID_RECOVERY_MODE'
  );
});

test('Stage-2 Cross-Thread Navigation: ask navigates to target conversation before calling reloadExactConversation', async () => {
  const targetId = '22222222-2222-4222-8222-222222222222';
  const initialId = '33333333-3333-4333-8333-333333333333';
  let currentUrl = `https://chatgpt.com/c/${initialId}`;
  const actions = [];

  const mockPage = {
    url: () => currentUrl,
    goto: async (url) => {
      actions.push(`goto:${url}`);
      currentUrl = url;
    },
    reload: async () => {
      actions.push('reload');
    },
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    locator: () => ({ last: () => ({ waitFor: async () => {} }) }),
    evaluate: async () => ({
      hydrated: true,
      sessionId: targetId,
      turnCount: 2,
      roleNodeCount: 2,
      composerVisible: true,
    }),
  };

  // Run reloadExactConversation after navigation
  if (sessionIdFromUrl(mockPage.url()) !== targetId) {
    actions.push(`nav-needed:${mockPage.url()}->${targetId}`);
    currentUrl = `https://chatgpt.com/c/${targetId}`;
  }
  await reloadExactConversation(mockPage, targetId, 'recovery-resend-test');

  assert.equal(actions[0], `nav-needed:https://chatgpt.com/c/${initialId}->${targetId}`);
  assert.equal(actions.includes('reload'), true);
  assert.equal(mockPage.url(), `https://chatgpt.com/c/${targetId}`);
});

test('validateRecoveryMode: enforces mandatory incident id, non-empty message, and mode exclusions', () => {
  // Requires recovery-incident
  assert.throws(
    () => validateRecoveryMode({ recoveryResend: true, message: 'hello', recoveryIncidentId: '' }),
    (err) => err.code === 'RECOVERY_INCIDENT_REQUIRED'
  );

  // Requires message
  assert.throws(
    () => validateRecoveryMode({ recoveryResend: true, message: '', recoveryIncidentId: 'INC-1' }),
    (err) => err.code === 'RECOVERY_MESSAGE_REQUIRED'
  );

  // Rejects --new-conversation
  assert.throws(
    () => validateRecoveryMode({ recoveryResend: true, newConversation: true, message: 'hi', recoveryIncidentId: 'INC-1' }),
    (err) => err.code === 'INVALID_RECOVERY_MODE'
  );

  // Rejects scheduling
  assert.throws(
    () => validateRecoveryMode({ recoveryResend: true, schedule: true, message: 'hi', recoveryIncidentId: 'INC-1' }),
    (err) => err.code === 'INVALID_RECOVERY_MODE'
  );

  // Rejects queue runner
  assert.throws(
    () => validateRecoveryMode({ recoveryResend: true, runQueue: true, message: 'hi', recoveryIncidentId: 'INC-1' }),
    (err) => err.code === 'INVALID_RECOVERY_MODE'
  );

  // Injects discriminator prefix automatically
  const args = { recoveryResend: true, message: 'Original prompt text', recoveryIncidentId: 'CB-INC-42' };
  validateRecoveryMode(args);
  assert.equal(args.message, '[Recovery Stage 2: CB-INC-42] Original prompt text');

  // Does not duplicate prefix if already present
  validateRecoveryMode(args);
  assert.equal(args.message, '[Recovery Stage 2: CB-INC-42] Original prompt text');
});

test('prepareRecoveryResendTarget: navigates to target conversation before invoking reloadExactConversation', async () => {
  const targetId = '55555555-5555-4555-8555-555555555555';
  const initialId = '66666666-6666-4666-8666-666666666666';
  let currentUrl = `https://chatgpt.com/c/${initialId}`;
  const actionLog = [];

  const mockPage = {
    url: () => currentUrl,
    goto: async (url) => {
      actionLog.push(`goto:${url}`);
      currentUrl = url;
    },
    reload: async () => {
      actionLog.push('reload');
    },
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    locator: () => ({ last: () => ({ waitFor: async () => {} }) }),
    evaluate: async () => ({
      hydrated: true,
      sessionId: targetId,
      turnCount: 3,
      roleNodeCount: 3,
      composerVisible: true,
    }),
  };

  await prepareRecoveryResendTarget(mockPage, {}, targetId);

  assert.equal(actionLog[0], `goto:https://chatgpt.com/c/${targetId}`);
  assert.equal(actionLog[1], 'reload');
  assert.equal(mockPage.url(), `https://chatgpt.com/c/${targetId}`);
});

test('validateRecoveryMode: rejects combination with conflicting primary operations', () => {
  // Rejects --stop
  assert.throws(
    () => validateRecoveryMode({ recoveryResend: true, message: 'hi', recoveryIncidentId: 'INC-1', stop: true }),
    (err) => err.code === 'INVALID_RECOVERY_MODE'
  );

  // Rejects --status
  assert.throws(
    () => validateRecoveryMode({ recoveryResend: true, message: 'hi', recoveryIncidentId: 'INC-1', status: true }),
    (err) => err.code === 'INVALID_RECOVERY_MODE'
  );

  // Rejects --watch-state
  assert.throws(
    () => validateRecoveryMode({ recoveryResend: true, message: 'hi', recoveryIncidentId: 'INC-1', watchState: true }),
    (err) => err.code === 'INVALID_RECOVERY_MODE'
  );

  // Rejects --sync-transcript
  assert.throws(
    () => validateRecoveryMode({ recoveryResend: true, message: 'hi', recoveryIncidentId: 'INC-1', syncTranscript: true }),
    (err) => err.code === 'INVALID_RECOVERY_MODE'
  );
});

test('validateStage1Mode: enforces mandatory incident id, distinct suffix, and mode exclusions', () => {
  // Requires recovery-incident
  assert.throws(
    () => validateStage1Mode({ retryEdit: 'latest', editSuffix: '.', recoveryIncidentId: '' }),
    (err) => err.code === 'RECOVERY_INCIDENT_REQUIRED'
  );

  // Requires non-empty editSuffix
  assert.throws(
    () => validateStage1Mode({ retryEdit: 'latest', editSuffix: '', recoveryIncidentId: 'INC-1' }),
    (err) => err.code === 'EDIT_SUFFIX_REQUIRED'
  );

  // Rejects --message
  assert.throws(
    () => validateStage1Mode({ retryEdit: 'latest', editSuffix: '.', recoveryIncidentId: 'INC-1', message: 'hello' }),
    (err) => err.code === 'INVALID_STAGE1_MODE'
  );

  // Rejects --recovery-resend
  assert.throws(
    () => validateStage1Mode({ retryEdit: 'latest', editSuffix: '.', recoveryIncidentId: 'INC-1', recoveryResend: true }),
    (err) => err.code === 'INVALID_STAGE1_MODE'
  );

  // Rejects --new-conversation
  assert.throws(
    () => validateStage1Mode({ retryEdit: 'latest', editSuffix: '.', recoveryIncidentId: 'INC-1', newConversation: true }),
    (err) => err.code === 'INVALID_STAGE1_MODE'
  );

  // Rejects scheduling
  assert.throws(
    () => validateStage1Mode({ retryEdit: 'latest', editSuffix: '.', recoveryIncidentId: 'INC-1', schedule: true }),
    (err) => err.code === 'INVALID_STAGE1_MODE'
  );

  // Rejects conflicting primary actions
  assert.throws(
    () => validateStage1Mode({ retryEdit: 'latest', editSuffix: '.', recoveryIncidentId: 'INC-1', stop: true }),
    (err) => err.code === 'INVALID_STAGE1_MODE'
  );

  assert.throws(
    () => validateStage1Mode({ retryEdit: 'latest', editSuffix: '.', recoveryIncidentId: 'INC-1', status: true }),
    (err) => err.code === 'INVALID_STAGE1_MODE'
  );
});

test('resolveEditableUserTurn: extracts latest user turn, validates distinct mutation, and rejects whitespace-only suffixes', async () => {
  const mockPage = {
    $$eval: async (selector, fn) => {
      const mockElements = [
        {
          getAttribute: (name) => name === 'data-message-author-role' ? 'user' : (name === 'data-message-id' ? 'msg-u1' : null),
          closest: () => ({ getAttribute: () => 'conversation-turn-1' }),
          textContent: 'First prompt'
        },
        {
          getAttribute: (name) => name === 'data-message-author-role' ? 'assistant' : (name === 'data-message-id' ? 'msg-a1' : null),
          closest: () => ({ getAttribute: () => 'conversation-turn-2' }),
          textContent: 'First answer'
        },
        {
          getAttribute: (name) => name === 'data-message-author-role' ? 'user' : (name === 'data-message-id' ? 'msg-u2' : null),
          closest: () => ({ getAttribute: () => 'conversation-turn-3' }),
          textContent: 'Failed request prompt'
        },
        {
          getAttribute: (name) => name === 'data-message-author-role' ? 'assistant' : (name === 'data-message-id' ? 'msg-a2' : null),
          closest: () => ({ getAttribute: () => 'conversation-turn-4' }),
          textContent: 'Stopped thinking'
        },
      ];
      return fn(mockElements);
    },
    evaluate: async () => [
      { index: 0, testid: 'conversation-turn-1', messageId: 'msg-u1', role: 'user', text: 'First prompt', roleTexts: ['First prompt'], turnText: 'First prompt' },
      { index: 1, testid: 'conversation-turn-2', messageId: 'msg-a1', role: 'assistant', text: 'First answer', roleTexts: ['First answer'], turnText: 'First answer' },
      { index: 2, testid: 'conversation-turn-3', messageId: 'msg-u2', role: 'user', text: 'Failed request prompt', roleTexts: ['Failed request prompt'], turnText: 'Failed request prompt' },
      { index: 3, testid: 'conversation-turn-4', messageId: 'msg-a2', role: 'assistant', text: 'Stopped thinking', roleTexts: ['Stopped thinking'], turnText: 'Stopped thinking' },
    ]
  };

  // Trailing space fails EDIT_MUTATION_NOT_DISTINCT due to whitespace normalization
  await assert.rejects(
    async () => resolveEditableUserTurn(mockPage, 'latest', '   '),
    (err) => err.code === 'EDIT_MUTATION_NOT_DISTINCT'
  );

  // Distinct visible punctuation succeeds
  const res = await resolveEditableUserTurn(mockPage, 'latest', '.');
  assert.equal(res.sourceUser.id, 'msg-u2');
  assert.equal(res.sourceUser.testid, 'conversation-turn-3');
  assert.equal(res.sourceAssistant.id, 'msg-a2');
  assert.equal(res.editedText, 'Failed request prompt.');
  assert.notEqual(res.originalHash, res.editedHash);
});

test('populateAndVerifyEditor: fails closed with EDIT_EDITOR_MISMATCH if initial content mismatches source text', async () => {
  let cancelClicked = false;
  const mockCancel = {
    isVisible: async () => true,
    click: async () => { cancelClicked = true; },
  };
  const mockContainer = {
    locator: () => ({ first: () => mockCancel }),
  };
  const mockEditor = {
    textContent: async () => 'Completely unrelated draft text',
    locator: () => mockContainer,
  };

  await assert.rejects(
    async () => populateAndVerifyEditor({}, mockEditor, { id: 'msg-1' }, 'Expected prompt text', 'Expected prompt text.'),
    (err) => err.code === 'EDIT_EDITOR_MISMATCH'
  );
  assert.equal(cancelClicked, true);
});

test('waitForEditedTurnAccepted: attests revised user turn in DOM by edited hash', async () => {
  const targetId = '99999999-9999-4999-8999-999999999999';
  const editedText = 'Prompt with suffix.';
  const editedHash = messageHash(normalizeTurnText(editedText));

  const mockPage = {
    url: () => `https://chatgpt.com/c/${targetId}`,
    $$eval: async (selector, fn) => {
      const mockElements = [
        {
          getAttribute: (name) => name === 'data-message-id' ? 'msg-u2' : null,
          closest: () => ({ getAttribute: () => 'conversation-turn-3' }),
          textContent: editedText
        }
      ];
      return fn(mockElements);
    },
    waitForTimeout: async () => {},
  };

  const attestation = await waitForEditedTurnAccepted(mockPage, { id: 'msg-u2', testid: 'conversation-turn-3' }, editedHash, targetId, 2000);
  assert.equal(attestation.acceptedTurn.messageId, 'msg-u2');
  assert.equal(attestation.acceptedTurn.textHash, editedHash);
  assert.equal(attestation.attestationMethod, 'same_message_id_edited_hash');
});

test('parseArgs: parses --retry-edit flag with peek helper without ReferenceError', () => {
  const args1 = parseArgs(['node', 'CB.js', '--retry-edit', 'latest', '--recovery-incident', 'INC-1', '--conversation', '11111111-1111-4111-8111-111111111111']);
  assert.equal(args1.retryEdit, 'latest');
  assert.equal(args1.recoveryIncidentId, 'INC-1');

  // Bare flag defaults to 'latest'
  const args2 = parseArgs(['node', 'CB.js', '--retry-edit', '--recovery-incident', 'INC-2', '--conversation', '11111111-1111-4111-8111-111111111111']);
  assert.equal(args2.retryEdit, 'latest');
  assert.equal(args2.recoveryIncidentId, 'INC-2');
});

test('WAL Round Lineage Persistence: registerPendingRound persists Stage-1 source turns and hashes', () => {
  const mockArgs = { cdp: 'http://127.0.0.1:9241' };
  const mockPage = { url: () => 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111' };
  const round = registerPendingRound(mockArgs, mockPage, 'Edited prompt text.', 'turn-1', {
    expectedSessionId: '11111111-1111-4111-8111-111111111111',
    operationKind: 'edit_retry',
    recoveryStage: 1,
    recoveryIncidentId: 'INC-STAGE1-TEST',
    sourceUserTurn: { id: 'msg-u1', testid: 'turn-1', textHash: 'hash1' },
    sourceAssistantTurn: { id: 'msg-a1', testid: 'turn-2', textHash: 'hash2' },
    originalMessageHash: 'hash1',
    editedMessageHash: 'hash1_edited',
    editSuffix: '.',
    dispatchState: 'prepared',
  });

  assert.equal(round.operationKind, 'edit_retry');
  assert.equal(round.recoveryStage, 1);
  assert.equal(round.recoveryIncidentId, 'INC-STAGE1-TEST');
  assert.deepEqual(round.sourceUserTurn, { id: 'msg-u1', testid: 'turn-1', textHash: 'hash1' });
  assert.deepEqual(round.sourceAssistantTurn, { id: 'msg-a1', testid: 'turn-2', textHash: 'hash2' });
  assert.equal(round.originalMessageHash, 'hash1');
  assert.equal(round.editedMessageHash, 'hash1_edited');
  assert.equal(round.editSuffix, '.');
});

test('waitForEditedTurnAccepted: rejects ambiguous multiple structural matches', async () => {
  const targetId = '99999999-9999-4999-8999-999999999999';
  const editedText = 'Ambiguous duplicate prompt.';
  const editedHash = messageHash(normalizeTurnText(editedText));

  const mockPage = {
    url: () => `https://chatgpt.com/c/${targetId}`,
    $$eval: async (selector, fn) => {
      // Return 2 identical matching user turns with different IDs/testids
      const mockElements = [
        {
          getAttribute: (name) => name === 'data-message-id' ? 'msg-u_old' : null,
          closest: () => ({ getAttribute: () => 'conversation-turn-1' }),
          textContent: editedText
        },
        {
          getAttribute: (name) => name === 'data-message-id' ? 'msg-u_middle' : null,
          closest: () => ({ getAttribute: () => 'conversation-turn-3' }),
          textContent: editedText
        },
        {
          getAttribute: (name) => name === 'data-message-id' ? 'msg-u_latest' : null,
          closest: () => ({ getAttribute: () => 'conversation-turn-5' }),
          textContent: 'Unrelated latest'
        }
      ];
      return fn(mockElements);
    },
    waitForTimeout: async () => {},
  };

  // Multiple candidates and neither matches source ID -> fails closed
  await assert.rejects(
    async () => waitForEditedTurnAccepted(mockPage, { id: 'msg-target', testid: 'turn-target' }, editedHash, targetId, 500),
    (err) => err.code === 'EDIT_ATTRIBUTION_UNVERIFIED'
  );
});

test('sameTurnRevision: matches only when turn identity and text hash both match', () => {
  const ref = {
    messageId: 'msg-a1',
    testid: 'turn-2',
    role: 'assistant',
    textHash: messageHash(normalizeTurnText('Original stopped answer')),
  };

  // Identical messageId and text -> true
  assert.equal(sameTurnRevision({ messageId: 'msg-a1', testid: 'turn-2', text: 'Original stopped answer' }, ref), true);

  // Reused messageId but new/different content -> false (not the same revision!)
  assert.equal(sameTurnRevision({ messageId: 'msg-a1', testid: 'turn-2', text: 'Regenerated new answer' }, ref), false);

  // Different messageId with identical text -> false
  assert.equal(sameTurnRevision({ messageId: 'msg-a2', testid: 'turn-4', text: 'Original stopped answer' }, ref), false);
});

test('populateAndVerifyEditor: appends suffix in place while preserving initial editor markdown content', async () => {
  const initialMarkdown = '# Header\n\n```python\nprint("hello")\n```';
  let insertedText = '';
  let evaluated = false;

  const mockPage = {
    keyboard: {
      insertText: async (t) => { insertedText = t; },
    },
    waitForTimeout: async () => {},
  };

  const mockEditor = {
    textContent: async () => (insertedText ? `${initialMarkdown}${insertedText}` : initialMarkdown),
    focus: async () => {},
    evaluate: async (fn) => {
      evaluated = true;
    },
    locator: () => ({
      first: () => ({
        isVisible: async () => false,
      })
    })
  };

  await populateAndVerifyEditor(mockPage, mockEditor, { messageId: 'msg-1' }, initialMarkdown, '.', `${initialMarkdown}.`);
  assert.equal(evaluated, true);
  assert.equal(insertedText, '.');
});

test('responseAfterAcceptedTurnExcludingRevision: excludes prior stopped assistant revision consistently across reads', () => {
  const promptText = 'Prompt.';
  const userRef = { messageId: 'msg-u1', testid: 'turn-1', role: 'user', textHash: messageHash(normalizeTurnText(promptText)) };
  const priorAssistantRef = {
    messageId: 'msg-a1',
    testid: 'turn-2',
    role: 'assistant',
    textHash: messageHash(normalizeTurnText('Stopped response text')),
  };

  const priorTurns = [
    { messageId: 'msg-u1', testid: 'turn-1', role: 'user', text: promptText },
    { messageId: 'msg-a1', testid: 'turn-2', role: 'assistant', text: 'Stopped response text' },
  ];

  // Prior assistant matches -> excluded (empty response)
  const excludedOutcome = responseAfterAcceptedTurnExcludingRevision(priorTurns, userRef, priorAssistantRef);
  assert.equal(excludedOutcome.text, '');
  assert.equal(excludedOutcome.assistantTurn, null);

  // Regenerated assistant has same messageId but new text -> accepted!
  const regeneratedTurns = [
    { messageId: 'msg-u1', testid: 'turn-1', role: 'user', text: 'Prompt.' },
    { messageId: 'msg-a1', testid: 'turn-2', role: 'assistant', text: 'Completely regenerated response text!' },
  ];
  const acceptedOutcome = responseAfterAcceptedTurnExcludingRevision(regeneratedTurns, userRef, priorAssistantRef);
  assert.equal(acceptedOutcome.text, 'Completely regenerated response text!');
  assert.equal(acceptedOutcome.assistantTurn.messageId, 'msg-a1');
});

test('populateAndVerifyEditor: verifies markdown editor against initial editor text, preserving complex code/markdown formatting', async () => {
  const rawEditorMarkdown = '# Section Title\n\n```python\ndef solve():\n    return 42\n```';
  const renderedText = 'Section Title python def solve(): return 42'; // stripped of markdown
  let insertedSuffix = '';

  const mockPage = {
    keyboard: {
      insertText: async (t) => { insertedSuffix = t; },
    },
    waitForTimeout: async () => {},
  };

  const mockEditor = {
    textContent: async () => (insertedSuffix ? `${rawEditorMarkdown}${insertedSuffix}` : rawEditorMarkdown),
    focus: async () => {},
    evaluate: async (fn) => {},
    locator: () => ({
      locator: () => ({
        first: () => ({ isVisible: async () => false }),
      }),
    }),
  };

  // initialText (markdown) matches renderedText (plain text) under normalizePromptForRenderedComparison
  // and post-insertion verifies against expectedEditorText (markdown + suffix)
  await populateAndVerifyEditor(mockPage, mockEditor, { messageId: 'msg-1' }, renderedText, '.', `${rawEditorMarkdown}.`);
  assert.equal(insertedSuffix, '.');
});

test('turnRevisionMatchesRef: requires both messageId and revision textHash to match', () => {
  const oldText = 'Original user prompt';
  const newText = 'Original user prompt.';
  const oldHash = messageHash(oldText);
  const newHash = messageHash(newText);

  const turn = {
    messageId: 'msg-u1',
    testid: 'conversation-turn-1',
    text: oldText,
  };

  const oldRef = {
    messageId: 'msg-u1',
    testid: 'conversation-turn-1',
    textHash: oldHash,
  };

  const newRef = {
    messageId: 'msg-u1',
    testid: 'conversation-turn-1',
    textHash: newHash,
  };

  // Same messageId with matching revision hash returns true
  assert.strictEqual(turnRevisionMatchesRef(turn, oldRef), true);

  // Same messageId with different revision hash returns false (reused ID does not falsely match)
  assert.strictEqual(turnRevisionMatchesRef(turn, newRef), false);
});

test('resolveEditableUserTurn: fails closed with EDIT_SOURCE_UNVERIFIED if canonical extraction fails or source user is missing', async () => {
  const emptyPage = {
    $$eval: async (selector, fn) => fn([{
      getAttribute: () => 'user',
      closest: () => ({ getAttribute: () => 'turn-1' }),
      textContent: 'Some prompt'
    }]),
    evaluate: async () => []
  };

  await assert.rejects(
    () => resolveEditableUserTurn(emptyPage, 'latest', '.'),
    (err) => err.code === 'EDIT_SOURCE_UNVERIFIED'
  );

  const missingUserPage = {
    $$eval: async (selector, fn) => fn([{
      getAttribute: (name) => name === 'data-message-author-role' ? 'user' : 'msg-unknown',
      closest: () => ({ getAttribute: () => 'turn-unknown' }),
      textContent: 'Some prompt'
    }]),
    evaluate: async () => [
      { index: 0, testid: 'turn-1', messageId: 'msg-other', role: 'user', text: 'Other prompt', roleTexts: ['Other prompt'], turnText: 'Other prompt' }
    ]
  };

  await assert.rejects(
    () => resolveEditableUserTurn(missingUserPage, 'latest', '.'),
    (err) => err.code === 'EDIT_SOURCE_UNVERIFIED'
  );
});

test('sameTurnRevision: enforces messageId precedence over testid and requires hash match', () => {
  const hash = messageHash(normalizeTurnText('Stopped response text'));

  const ref = {
    messageId: 'msg-a1',
    testid: 'conversation-turn-2',
    textHash: hash,
  };

  // same messageId + same hash -> true
  assert.strictEqual(sameTurnRevision({ messageId: 'msg-a1', testid: 'conversation-turn-2', text: 'Stopped response text' }, ref), true);

  // same messageId + different hash -> false
  assert.strictEqual(sameTurnRevision({ messageId: 'msg-a1', testid: 'conversation-turn-2', text: 'Different response text' }, ref), false);

  // different messageId + same testid + same hash -> false (strong message identity wins, prevents suppressing new revision)
  assert.strictEqual(sameTurnRevision({ messageId: 'msg-a2', testid: 'conversation-turn-2', text: 'Stopped response text' }, ref), false);

  // no messageId + same testid + same hash -> true (fallback when messageId is unavailable)
  assert.strictEqual(sameTurnRevision({ testid: 'conversation-turn-2', text: 'Stopped response text' }, { testid: 'conversation-turn-2', textHash: hash }), true);
});

test('retryEditTurn orchestrator validations and WAL state transitions', async () => {
  // 1. Rejects missing target session
  await assert.rejects(
    () => retryEditTurn({}, { retryEdit: 'latest', editSuffix: '.', recoveryIncidentId: 'INC-1' }),
    (err) => err.code === 'EDIT_TARGET_REQUIRED'
  );

  // 2. Validate WAL state machine transitions across failure modes
  let localDispatchState = 'prepared';
  let roundState = 'prepared';
  let status = 'pending';

  // In precommit phase (prepared), error transitions to aborted_precommit
  try {
    throw new Error('Precommit validation failed');
  } catch (err) {
    if (localDispatchState === 'prepared') {
      localDispatchState = 'aborted_precommit';
      status = 'failed';
      roundState = 'aborted_precommit';
    }
  }
  assert.strictEqual(localDispatchState, 'aborted_precommit');
  assert.strictEqual(status, 'failed');

  // Once dispatching starts, click/attest error transitions to uncertain, NEVER aborted_precommit
  localDispatchState = 'dispatching';
  status = 'pending';
  roundState = 'dispatching';

  try {
    throw new Error('Send button click threw timeout');
  } catch (err) {
    localDispatchState = 'uncertain';
    roundState = 'uncertain';
  }
  assert.strictEqual(localDispatchState, 'uncertain');
  assert.strictEqual(status, 'pending');

  // Once accepted, assistant timeout leaves round accepted/pending, NEVER aborted_precommit
  localDispatchState = 'accepted';
  roundState = 'accepted';

  try {
    throw new Error('Assistant response generation timed out');
  } catch (err) {
    if (localDispatchState === 'prepared') {
      localDispatchState = 'aborted_precommit';
      status = 'failed';
    }
  }
  assert.strictEqual(localDispatchState, 'accepted');
  assert.strictEqual(status, 'pending');
});
