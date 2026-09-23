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

test('responseAfterRound: Window bounds do not cross later user turns and honor acceptedUserTurn ref', () => {
  const prompt = 'First prompt';
  const promptHash = messageHash(prompt);
  const round = {
    messageHash: promptHash,
    messageHead: prompt,
    acceptedUserTurn: {
      textHash: promptHash,
    },
  };

  const entries = [
    { role: 'user', text: 'First prompt' },
    { role: 'assistant', text: 'First answer' },
    { role: 'user', text: 'Second prompt' },
    { role: 'assistant', text: 'Second answer' },
  ];

  assert.equal(responseAfterRound(entries, round), 'First answer');

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
  assert.equal(queueHoldStatusForError({ code: 'CONVERSATION_LEASE_BUSY' }), 'needs_recovery');
  assert.equal(queueHoldStatusForError({ code: 'THREAD_IDENTITY_DRIFT' }), 'failed');
  assert.equal(queueHoldStatusForError({ code: 'CONCURRENT_CONVERSATION_MUTATION' }), 'failed');
  assert.equal(queueHoldStatusForError({ code: 'ASSISTANT_TERMINAL_ERROR' }), 'failed');
  assert.equal(queueHoldStatusForError({ code: 'CONVERSATION_BUSY' }), 'failed');
});

test('ConversationLease: Atomic acquisition with token and verified release', () => {
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

  // Release with matching token succeeds
  releaseConversationLease(handle);
  assert.equal(fs.existsSync(handle.leasePath), false);
});
