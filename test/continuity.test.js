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
  bootstrapLeaseKey,
  bootstrapLeasePath,
  acquireBootstrapLease,
  releaseBootstrapLease,
  assertNewChatBootstrapRoute,
  attestUserTurn,
  waitForAcceptedTurnAttestation,
  waitForSessionIdInUrl,
  terminalErrorForAwaitedTurn,
  normalizeTurnText,
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
  const expectedId = '11111111-1111-1111-1111-111111111111';

  // Matching URL: passes
  await assertThreadIdentity({ url: () => `https://chat.example.com/c/${expectedId}` }, expectedId, 'test_phase');

  // Root URL: drifts
  await assert.rejects(
    async () => {
      await assertThreadIdentity({ url: () => 'https://chat.example.com/' }, expectedId, 'test_phase');
    },
    (err) => err.code === 'THREAD_IDENTITY_DRIFT'
  );

  // Provisional WEB route: drifts
  await assert.rejects(
    async () => {
      await assertThreadIdentity({ url: () => 'https://chat.example.com/c/WEB:22222222-2222-2222-2222-222222222222' }, expectedId, 'test_phase');
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

test('normalizeTurnText: Strips markdown syntax, UI buttons, and collapses whitespace', () => {
  const raw = '# Header with `code` and **bold** text and ~strike~\nShow more';
  assert.equal(normalizeTurnText(raw), 'Header with code and bold text and strike');

  const withNbsp = 'Hello\u00a0world\nShow less';
  assert.equal(normalizeTurnText(withNbsp), 'Hello world');
});

test('assertNewChatBootstrapRoute: Throws on route drift before dispatch', () => {
  // Canonical root: passes
  assert.doesNotThrow(() => {
    assertNewChatBootstrapRoute({ url: () => 'https://chat.example.com/' });
  });

  // Provisional route: drifts
  assert.throws(
    () => {
      assertNewChatBootstrapRoute({ url: () => 'https://chat.example.com/c/WEB:22222222-2222-2222-2222-222222222222' });
    },
    (err) => err.code === 'NEW_CHAT_ROUTE_DRIFT'
  );

  // Stable conversation route: drifts
  assert.throws(
    () => {
      assertNewChatBootstrapRoute({ url: () => 'https://chat.example.com/c/11111111-1111-1111-1111-111111111111' });
    },
    (err) => err.code === 'NEW_CHAT_ROUTE_DRIFT'
  );
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
