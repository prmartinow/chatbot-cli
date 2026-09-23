const test = require('node:test');
const assert = require('node:assert/strict');
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
} = require('../CB.js');

test('ID Model: STABLE vs ROUTE Session ID separation', () => {
  const stableUuid = '6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c';
  const webUuid = 'WEB:0bd28d17-35cc-447a-a589-1cbd8a6fec12';

  assert.equal(STABLE_SESSION_ID_RE.test(stableUuid), true);
  assert.equal(STABLE_SESSION_ID_RE.test(webUuid), false);

  assert.equal(ROUTE_SESSION_ID_RE.test(stableUuid), true);
  assert.equal(ROUTE_SESSION_ID_RE.test(webUuid), true);

  assert.equal(isEphemeralRouteId(webUuid), true);
  assert.equal(isEphemeralRouteId(stableUuid), false);

  assert.equal(routeSessionIdFromUrl(`https://chatgpt.com/c/${webUuid}`), webUuid);
  assert.equal(sessionIdFromUrl(`https://chatgpt.com/c/${webUuid}`), '');

  assert.equal(routeSessionIdFromUrl(`https://chatgpt.com/c/${stableUuid}`), stableUuid);
  assert.equal(sessionIdFromUrl(`https://chatgpt.com/c/${stableUuid}`), stableUuid);

  assert.equal(routeSessionIdFromUrl('https://chatgpt.com/'), '');
  assert.equal(sessionIdFromUrl('https://chatgpt.com/'), '');
});

test('assertThreadIdentity: Throws on drift to root or provisional route', async () => {
  const expectedId = '6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c';

  // Matching URL: passes
  await assertThreadIdentity({ url: () => `https://chatgpt.com/c/${expectedId}` }, expectedId, 'test_phase');

  // Root URL: drifts
  await assert.rejects(
    async () => {
      await assertThreadIdentity({ url: () => 'https://chatgpt.com/' }, expectedId, 'test_phase');
    },
    (err) => err.code === 'THREAD_IDENTITY_DRIFT'
  );

  // Provisional WEB route: drifts (never considered stable expected session)
  await assert.rejects(
    async () => {
      await assertThreadIdentity({ url: () => 'https://chatgpt.com/c/WEB:0bd28d17-35cc-447a-a589-1cbd8a6fec12' }, expectedId, 'test_phase');
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

  // Normal prose containing 'retry' or 'something went wrong'
  const normalProse = 'When implementing an exponential backoff policy, if something went wrong you should retry after 2 seconds.';
  assert.equal(isErrorOnlyResponseText(normalProse), false);
});

test('responseAfterAcceptedTurn: Bounded turn lineage lookup', () => {
  const ref = {
    messageId: 'msg-u1',
    testid: 'turn-u1',
    role: 'user',
    textHash: 'hash-u1',
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

  // Detects concurrent user turn if another user turn appears before assistant response
  const pendingTurns = [
    { messageId: 'msg-u1', testid: 'turn-u1', role: 'user', text: 'Analyze this code' },
    { messageId: 'msg-u2', testid: 'turn-u2', role: 'user', text: 'Unexpected second prompt' },
  ];
  const pendingOutcome = responseAfterAcceptedTurn(pendingTurns, ref);
  assert.notEqual(pendingOutcome.concurrentUserTurn, null);
  assert.equal(pendingOutcome.text, '');
});

test('responseAfterRound: Window bounds do not cross later user turns', () => {
  const round = {
    messageHash: 'hash1',
    messageHead: 'First prompt',
  };

  const entries = [
    { role: 'user', text: 'First prompt' },
    { role: 'assistant', text: 'First answer' },
    { role: 'user', text: 'Second prompt' },
    { role: 'assistant', text: 'Second answer' },
  ];

  // Must only return 'First answer', never 'Second answer'
  assert.equal(responseAfterRound(entries, round), 'First answer');

  // Error banners are filtered out
  const entriesWithError = [
    { role: 'user', text: 'First prompt' },
    { role: 'assistant', text: 'Something went wrong. If this issue persists... Retry' },
  ];
  assert.equal(responseAfterRound(entriesWithError, round), '');
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
  assert.equal(queueHoldStatusForError({ code: 'THREAD_IDENTITY_DRIFT' }), 'failed');
  assert.equal(queueHoldStatusForError({ code: 'CONCURRENT_CONVERSATION_MUTATION' }), 'failed');
  assert.equal(queueHoldStatusForError({ code: 'ASSISTANT_TERMINAL_ERROR' }), 'failed');
  assert.equal(queueHoldStatusForError({ code: 'CONVERSATION_BUSY' }), 'failed');
});
