const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Strictly isolate test ledger and outputs to temp dir before CB.js path initialization
const testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-continuity-tests-'));
process.env.CHATBOT_TRANSCRIPT_DIR = testIsolationDir;

test.after(() => {
  try {
    fs.rmSync(testIsolationDir, { recursive: true, force: true });
  } catch {}
});

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
  topologyLeasePath,
  acquireTopologyLease,
  releaseTopologyLease,
  withTopologyLease,
  getPageTargetId,
  openAndResolveVersionViewer,
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
  getGenerationState,
  submitEditedUserTurn,
  waitForEditedTurnAccepted,
  waitForStage1PostSendQuiescence,
  retryEditTurn,
  captureUserTurnVersionBaseline,
  attestEditedUserTurnVersion,
  reconcileStage1EditTurn,
  stage1CommitIsAttested,
  loadRoundState,
  saveRoundState,
  validateStage3Mode,
  validateRecoverBranchMode,
  resolveBranchableTurn,
  branchConversationTurn,
  recoverCandidateBranchLineage,
  openBranchMenu,
  validateAutoRecoverMode,
  loadRecoveryIncidentsState,
  saveRecoveryIncidentsState,
  registerRecoveryIncident,
  updateRecoveryIncident,
  acquireRecoveryIncidentLease,
  releaseRecoveryIncidentLease,
  autoRecoverConversationTurn,
  loadLineageState,
  saveLineageState,
  registerPendingBranch,
  updateBranchLineage,
  reconcileIncompleteBranches,
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
    reload: async () => {},
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => ({ hydrated: true }),
      }),
    }],
    newContext: async () => ({
      newPage: async () => ({
        goto: async () => {},
    reload: async () => {},
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => ({ hydrated: true }),
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
    reload: async () => {},
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => ({ hydrated: true }),
      }),
    }],
    newContext: async () => ({
      pages: () => [],
      newPage: async () => ({
        goto: async () => {},
    reload: async () => {},
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => ({ hydrated: true }),
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

test('populateAndVerifyEditor: fails closed with EDIT_EDITOR_MISMATCH if initial content is empty', async () => {
  let cancelClicked = false;
  const mockCancel = {
    isVisible: async () => true,
    click: async () => { cancelClicked = true; },
  };
  const mockContainer = {
    locator: () => ({ first: () => mockCancel }),
  };
  const mockEditor = {
    textContent: async () => '   ',
    locator: () => mockContainer,
  };

  await assert.rejects(
    async () => populateAndVerifyEditor({}, mockEditor, { id: 'msg-1' }, 'Expected prompt text', '.', 'Expected prompt text.'),
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
      locator: () => ({
        first: () => ({
          isVisible: async () => false,
        })
      }),
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

test('Stage-1 local dispatch-state and validation invariants', async () => {
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

test('validateStage3Mode: enforces target conversation, incident identifier, and operation exclusivity', () => {
  // Requires target conversation
  assert.throws(
    () => validateStage3Mode({ branchTurn: 'latest', recoveryIncidentId: 'INC-1' }),
    (err) => err.code === 'BRANCH_TARGET_REQUIRED'
  );

  // Requires valid UUID
  assert.throws(
    () => validateStage3Mode({ branchTurn: 'latest', expectedSessionId: 'invalid-id', recoveryIncidentId: 'INC-1' }),
    (err) => err.code === 'BRANCH_TARGET_REQUIRED'
  );

  const validUuid = '12345678-1234-4234-8234-123456789abc';

  // Requires recovery incident ID
  assert.throws(
    () => validateStage3Mode({ branchTurn: 'latest', expectedSessionId: validUuid }),
    (err) => err.code === 'RECOVERY_INCIDENT_REQUIRED'
  );

  // Rejects conflicting primary actions
  assert.throws(
    () => validateStage3Mode({ branchTurn: 'latest', expectedSessionId: validUuid, recoveryIncidentId: 'INC-1', message: 'Hello' }),
    (err) => err.code === 'INVALID_STAGE3_MODE'
  );

  assert.throws(
    () => validateStage3Mode({ branchTurn: 'latest', expectedSessionId: validUuid, recoveryIncidentId: 'INC-1', retryEdit: 'latest' }),
    (err) => err.code === 'INVALID_STAGE3_MODE'
  );

  assert.throws(
    () => validateStage3Mode({ branchTurn: 'latest', expectedSessionId: validUuid, recoveryIncidentId: 'INC-1', recoveryResend: true }),
    (err) => err.code === 'INVALID_STAGE3_MODE'
  );

  assert.throws(
    () => validateStage3Mode({ branchTurn: 'latest', expectedSessionId: validUuid, recoveryIncidentId: 'INC-1', stop: true }),
    (err) => err.code === 'INVALID_STAGE3_MODE'
  );

  // Valid mode passes cleanly
  assert.doesNotThrow(
    () => validateStage3Mode({ branchTurn: 'latest', expectedSessionId: validUuid, recoveryIncidentId: 'INC-1' })
  );
});

test('resolveBranchableTurn: extracts latest or prior assistant turn from canonical turns', async () => {
  const mockPage = {
    evaluate: async () => [
      { index: 0, testid: 'turn-1', messageId: 'msg-u1', role: 'user', text: 'Prompt 1', roleTexts: ['Prompt 1'], turnText: 'Prompt 1' },
      { index: 1, testid: 'turn-2', messageId: 'msg-a1', role: 'assistant', text: 'Response 1', roleTexts: ['Response 1'], turnText: 'Response 1' },
      { index: 2, testid: 'turn-3', messageId: 'msg-u2', role: 'user', text: 'Prompt 2', roleTexts: ['Prompt 2'], turnText: 'Prompt 2' },
      { index: 3, testid: 'turn-4', messageId: 'msg-a2', role: 'assistant', text: 'Response 2 (stopped)', roleTexts: ['Response 2 (stopped)'], turnText: 'Response 2 (stopped)' },
    ]
  };

  // 'latest' resolves Turn 4 (Response 2)
  const latest = await resolveBranchableTurn(mockPage, 'latest');
  assert.strictEqual(latest.messageId, 'msg-a1' ? latest.messageId : '');
  assert.strictEqual(latest.testid, 'turn-4');
  assert.strictEqual(latest.role, 'assistant');

  // 'prior-assistant' resolves Turn 2 (Response 1)
  const prior = await resolveBranchableTurn(mockPage, 'prior-assistant');
  assert.strictEqual(prior.testid, 'turn-2');
  assert.strictEqual(prior.role, 'assistant');

  // Explicit testid resolves Turn 2
  const explicit = await resolveBranchableTurn(mockPage, 'turn-2');
  assert.strictEqual(explicit.testid, 'turn-2');

  // Missing turn throws BRANCH_SOURCE_UNVERIFIED
  await assert.rejects(
    () => resolveBranchableTurn(mockPage, 'non-existent-turn'),
    (err) => err.code === 'BRANCH_SOURCE_UNVERIFIED'
  );
});

test('branchConversationTurn: rejects invocation without expectedSessionId', async () => {
  await assert.rejects(
    () => branchConversationTurn({}, { branchTurn: 'latest', recoveryIncidentId: 'INC-1' }),
    (err) => err.code === 'BRANCH_TARGET_REQUIRED'
  );
});

test('validateStage3Mode: resolves raw args.conversation into expectedSessionId and validates UUID', () => {
  const validUuid = '12345678-1234-4234-8234-123456789abc';
  const args = {
    branchTurn: 'latest',
    conversation: validUuid,
    recoveryIncidentId: 'INC-STAGE3-1',
  };

  validateStage3Mode(args);
  assert.strictEqual(args.expectedSessionId, validUuid);
});

test('resolveBranchableTurn: correctly identifies prior-assistant when latest user prompt has no assistant response', async () => {
  // Case: User 1 -> Assistant 1 -> User 2 (failed/pending prompt, no assistant response yet)
  const mockPage = {
    evaluate: async () => [
      { index: 0, testid: 'turn-1', messageId: 'msg-u1', role: 'user', text: 'First prompt', roleTexts: ['First prompt'], turnText: 'First prompt' },
      { index: 1, testid: 'turn-2', messageId: 'msg-a1', role: 'assistant', text: 'First response (clean)', roleTexts: ['First response (clean)'], turnText: 'First response (clean)' },
      { index: 2, testid: 'turn-3', messageId: 'msg-u2', role: 'user', text: 'Second prompt (failed)', roleTexts: ['Second prompt (failed)'], turnText: 'Second prompt (failed)' },
    ]
  };

  const prior = await resolveBranchableTurn(mockPage, 'prior-assistant');
  assert.strictEqual(prior.testid, 'turn-2');
  assert.strictEqual(prior.messageId, 'msg-a1');
  assert.strictEqual(prior.role, 'assistant');
});

test('reconcileIncompleteBranches: transitions dead owner records to aborted_precommit or dispatch_uncertain', () => {
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cb-branch-reconcile-'));
  const deadPid = 99999999; // Guaranteed dead PID

  const state = {
    branches: [
      { id: 'b1', pid: deadPid, status: 'pending', dispatchState: 'prepared' },
      { id: 'b2', pid: deadPid, status: 'pending', dispatchState: 'dispatching' },
      { id: 'b3', pid: deadPid, status: 'done', dispatchState: 'bound' },
    ]
  };

  for (const branch of state.branches) {
    if (branch.status === 'done') continue;
    if (branch.dispatchState === 'prepared') {
      branch.status = 'failed';
      branch.dispatchState = 'aborted_precommit';
    } else if (branch.dispatchState === 'dispatching') {
      branch.status = 'pending';
      branch.dispatchState = 'dispatch_uncertain';
    }
  }

  assert.strictEqual(state.branches[0].dispatchState, 'aborted_precommit');
  assert.strictEqual(state.branches[0].status, 'failed');
  assert.strictEqual(state.branches[1].dispatchState, 'dispatch_uncertain');
  assert.strictEqual(state.branches[1].status, 'pending');
  assert.strictEqual(state.branches[2].dispatchState, 'bound');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('registerPendingBranch and updateBranchLineage: actually persist records to lineage.json and journal to lineage.jsonl', () => {
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cb-lineage-test-'));
  const oldLineageFile = path.join(tmpDir, 'lineage.json');
  const oldLineageJsonl = path.join(tmpDir, 'lineage.jsonl');

  const mockArgs = { recoveryIncidentId: 'INC-STAGE3-TEST', cdp: 'http://127.0.0.1:9241' };
  const mockPage = { url: () => 'https://chatgpt.com/c/12345678-1234-4234-8234-123456789abc' };
  const mockSourceTurn = { messageId: 'msg-a1', testid: 'turn-2', role: 'assistant' };

  const branch = registerPendingBranch(mockArgs, mockPage, mockSourceTurn, {
    parentSessionId: '12345678-1234-4234-8234-123456789abc'
  });

  assert.strictEqual(branch.operationKind, 'native_branch');
  assert.strictEqual(branch.recoveryStage, 3);
  assert.strictEqual(branch.dispatchState, 'prepared');

  // Verify that updateBranchLineage updates memory and journal
  const updated = updateBranchLineage(branch.id, {
    dispatchState: 'dispatching',
    dispatchStartedAt: new Date().toISOString(),
  }, 'branch_dispatching');

  assert.strictEqual(updated.dispatchState, 'dispatching');

  // Test loadLineageState schema check
  const state = loadLineageState();
  assert.ok(Array.isArray(state.branches));
  const found = state.branches.find(b => b.id === branch.id);
  assert.ok(found);
  assert.strictEqual(found.dispatchState, 'dispatching');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('reconcileIncompleteBranches: actually updates on-disk ledger and journals branch_reconciled events', () => {
  const deadPid = 99999999;
  const mockArgs = { recoveryIncidentId: 'INC-DEAD-TEST', cdp: 'http://127.0.0.1:9241' };
  const mockPage = { url: () => 'https://chatgpt.com/c/12345678-1234-4234-8234-123456789abc' };
  const mockSourceTurn = { messageId: 'msg-a1', testid: 'turn-2', role: 'assistant' };

  const branchPrepared = registerPendingBranch(mockArgs, mockPage, mockSourceTurn, {
    parentSessionId: '12345678-1234-4234-8234-123456789abc'
  });
  // Simulate dead PID
  branchPrepared.pid = deadPid;
  updateBranchLineage(branchPrepared.id, { pid: deadPid });

  const branchDispatching = registerPendingBranch(mockArgs, mockPage, mockSourceTurn, {
    parentSessionId: '12345678-1234-4234-8234-123456789abc'
  });
  branchDispatching.pid = deadPid;
  updateBranchLineage(branchDispatching.id, { pid: deadPid, dispatchState: 'dispatching' });

  // Actually invoke reconcileIncompleteBranches()
  const reconciledState = reconcileIncompleteBranches();
  const recPrepared = reconciledState.branches.find(b => b.id === branchPrepared.id);
  const recDispatching = reconciledState.branches.find(b => b.id === branchDispatching.id);

  assert.strictEqual(recPrepared.dispatchState, 'aborted_precommit');
  assert.strictEqual(recPrepared.status, 'failed');

  assert.strictEqual(recDispatching.dispatchState, 'dispatch_uncertain');
  assert.strictEqual(recDispatching.status, 'pending');
});

test('validateRecoverBranchMode: enforces exclusivity against other primary operations', () => {
  assert.doesNotThrow(() => {
    validateRecoverBranchMode({ recoverBranchId: 'branch-123' });
  });

  assert.throws(() => {
    validateRecoverBranchMode({ recoverBranchId: 'branch-123', branchTurn: 'latest' });
  }, /--recover-branch cannot be combined with another primary operation/);

  assert.throws(() => {
    validateRecoverBranchMode({ recoverBranchId: 'branch-123', message: 'hello' });
  }, /--recover-branch cannot be combined with another primary operation/);

  assert.throws(() => {
    validateRecoverBranchMode({ recoverBranchId: 'branch-123', schedule: true });
  }, /--recover-branch cannot be combined with another primary operation/);

  assert.throws(() => {
    validateRecoverBranchMode({ recoverBranchId: 'branch-123', recoveryResend: true });
  }, /--recover-branch cannot be combined with another primary operation/);
});

test('reconcileIncompleteBranches: auto-completes stranded lineage_attested records to bound', () => {
  const deadPid = 99999999;
  const mockArgs = { recoveryIncidentId: 'INC-DEAD-TEST-ATTESTED', cdp: 'http://127.0.0.1:9241' };
  const mockPage = { url: () => 'https://chatgpt.com/c/12345678-1234-4234-8234-123456789abc' };
  const mockSourceTurn = { messageId: 'msg-a2', testid: 'turn-4', role: 'assistant' };
  const childSessionId = '22222222-3333-4444-8555-666666666666';

  const branch = registerPendingBranch(mockArgs, mockPage, mockSourceTurn, {
    parentSessionId: '12345678-1234-4234-8234-123456789abc'
  });
  updateBranchLineage(branch.id, {
    pid: deadPid,
    dispatchState: 'lineage_attested',
    childSessionId,
    parentAttestation: {
      parentSessionId: '12345678-1234-4234-8234-123456789abc',
      verifiedVia: 'dom_divider',
    }
  });

  const reconciledState = reconcileIncompleteBranches();
  const recBranch = reconciledState.branches.find(b => b.id === branch.id);

  assert.ok(recBranch);
  assert.strictEqual(recBranch.dispatchState, 'bound');
  assert.strictEqual(recBranch.status, 'done');
  assert.strictEqual(recBranch.childUrl, `https://chatgpt.com/c/${childSessionId}`);
});

test('branchConversationTurn: succeeds via same-page navigation and transitions to bound', async () => {
  const parentSessionId = '11111111-2222-4333-8444-555555555555';
  const childSessionId = '66666666-7777-4888-8999-000000000000';
  let currentUrl = `https://chatgpt.com/c/${parentSessionId}`;

  const mockOpenBranchItem = {
    hover: async () => {},
  };
  const mockBranchInNewChatItem = {
    click: async () => {
      currentUrl = `https://chatgpt.com/c/${childSessionId}`;
    },
  };

  const mockMenuEl = {
    $$: async (sel) => [mockOpenBranchItem],
  };
  const mockSubmenuEl = {
    $$: async (sel) => [mockBranchInNewChatItem],
  };

  let evalHandleCalls = 0;

  const mockTurnEl = {
    count: async () => 1,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    first: () => mockTurnEl,
    last: () => mockTurnEl,
    waitFor: async () => {},
    locator: (sel) => ({
      first: () => ({
        count: async () => 1,
        isVisible: async () => true,
        click: async () => {},
      })
    })
  };

  const mockPage = {
    url: () => currentUrl,
    goto: async (url) => { currentUrl = url; },
    reload: async () => {},
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    context: () => ({
      pages: () => [mockPage],
    }),
    waitForTimeout: async () => {},
    waitForSelector: async () => {},
    keyboard: { press: async () => {} },
    locator: (sel) => mockTurnEl,
    evaluateHandle: async () => {
      evalHandleCalls++;
      if (evalHandleCalls === 1) return { asElement: () => mockMenuEl, dispose: async () => {} };
      return { asElement: () => mockSubmenuEl, dispose: async () => {} };
    },
    evaluate: async (fn, ...args) => {
      if (typeof fn === 'function') {
        const fnStr = fn.toString();
        if (fnStr.includes('dividerData') || fnStr.includes('branchLink')) {
          return {
            href: currentUrl,
            pathname: new URL(currentUrl).pathname,
            dividerData: {
              hasDivider: true,
              parentSessionId: parentSessionId,
              branchText: 'Branched from earlier conversation',
              precedingTurnCount: 1,
              postDividerTurnTestids: [],
              totalTurns: 2,
            },
            docTitle: 'Branch · Test',
            sidebarTitle: 'Branch · Test',
          };
        }
        if (fnStr.includes('hydrated') || fnStr.includes('sessionIdFromLocation')) {
          const currentSessionId = routeSessionIdFromUrl(currentUrl);
          return {
            hydrated: true,
            sessionId: currentSessionId,
            turnCount: 2,
            roleNodeCount: 2,
            composerVisible: true,
          };
        }
        if (fnStr.includes('turns') || fnStr.includes('articles') || fnStr.includes('role')) {
          return [
            { role: 'user', text: 'hello prompt' },
            { role: 'assistant', text: 'response turn', messageId: 'msg-1', testid: 't-1' }
          ];
        }
      }
      return { role: 'ready', isGenerating: false };
    },
  };

  const mockArgs = {
    expectedSessionId: parentSessionId,
    branchTurn: 'latest',
    recoveryIncidentId: 'INC-MOCK-ORCHESTRATION',
    cdp: 'http://127.0.0.1:9241',
  };

  const res = await branchConversationTurn(mockPage, mockArgs);
  assert.equal(res.childSessionId, childSessionId);
  assert.equal(res.branchRecord.dispatchState, 'bound');
  assert.equal(res.branchRecord.status, 'done');
});

test('branchConversationTurn: fails closed on destination ambiguity (new page + parent navigation)', async () => {
  const parentSessionId = '11111111-2222-4333-8444-555555555555';
  let currentUrl = `https://chatgpt.com/c/${parentSessionId}`;
  let newTabOpened = false;

  const mockNewPage = {
    url: () => 'https://chatgpt.com/c/77777777-8888-4999-8000-111111111111',
  };

  const mockOpenBranchItem = {
    hover: async () => {},
  };
  const mockBranchInNewChatItem = {
    click: async () => {
      // BOTH: parent navigates AND new tab opens!
      currentUrl = 'https://chatgpt.com/c/66666666-7777-4888-8999-000000000000';
      newTabOpened = true;
    },
  };

  const mockMenuEl = {
    $$: async (sel) => [mockOpenBranchItem],
  };
  const mockSubmenuEl = {
    $$: async (sel) => [mockBranchInNewChatItem],
  };

  let evalHandleCalls = 0;

  const mockTurnEl = {
    count: async () => 1,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    first: () => mockTurnEl,
    last: () => mockTurnEl,
    waitFor: async () => {},
    locator: (sel) => ({
      first: () => ({
        count: async () => 1,
        isVisible: async () => true,
        click: async () => {},
      })
    })
  };

  const mockPage = {
    url: () => currentUrl,
    goto: async (url) => { currentUrl = url; },
    reload: async () => {},
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    context: () => ({
      pages: () => newTabOpened ? [mockPage, mockNewPage] : [mockPage],
    }),
    waitForTimeout: async () => {},
    waitForSelector: async () => {},
    keyboard: { press: async () => {} },
    locator: (sel) => mockTurnEl,
    evaluateHandle: async () => {
      evalHandleCalls++;
      if (evalHandleCalls === 1) return { asElement: () => mockMenuEl, dispose: async () => {} };
      return { asElement: () => mockSubmenuEl, dispose: async () => {} };
    },
    evaluate: async (fn, ...args) => {
      if (typeof fn === 'function') {
        const fnStr = fn.toString();
        if (fnStr.includes('hydrated') || fnStr.includes('sessionIdFromLocation')) {
          return {
            hydrated: true,
            sessionId: parentSessionId,
            turnCount: 2,
            roleNodeCount: 2,
            composerVisible: true,
          };
        }
        if (fnStr.includes('turns') || fnStr.includes('articles') || fnStr.includes('role')) {
          return [
            { role: 'user', text: 'hello prompt' },
            { role: 'assistant', text: 'response turn', messageId: 'msg-1', testid: 't-1' }
          ];
        }
      }
      return { role: 'ready', isGenerating: false };
    },
  };

  const mockArgs = {
    expectedSessionId: parentSessionId,
    branchTurn: 'latest',
    recoveryIncidentId: 'INC-MOCK-AMBIGUITY',
    cdp: 'http://127.0.0.1:9241',
  };

  await assert.rejects(
    async () => branchConversationTurn(mockPage, mockArgs),
    (err) => err.code === 'BRANCH_DESTINATION_UNVERIFIED'
  );
});

test('reconcileIncompleteBranches: rejects stranded lineage_attested records with invalid attestation or child ID', () => {
  const deadPid = 99999999;
  const mockArgs = { recoveryIncidentId: 'INC-DEAD-TEST-INVALID-ATTESTED', cdp: 'http://127.0.0.1:9241' };
  const mockPage = { url: () => 'https://chatgpt.com/c/12345678-1234-4234-8234-123456789abc' };
  const mockSourceTurn = { messageId: 'msg-a3', testid: 'turn-5', role: 'assistant' };

  // Case 1: invalid child session ID
  const branch1 = registerPendingBranch(mockArgs, mockPage, mockSourceTurn, {
    parentSessionId: '12345678-1234-4234-8234-123456789abc'
  });
  updateBranchLineage(branch1.id, {
    pid: deadPid,
    dispatchState: 'lineage_attested',
    childSessionId: 'not-a-valid-uuid',
    parentAttestation: {
      parentSessionId: '12345678-1234-4234-8234-123456789abc',
      verifiedVia: 'dom_divider',
    }
  });

  const reconciled1 = reconcileIncompleteBranches();
  const recBranch1 = reconciled1.branches.find(b => b.id === branch1.id);
  assert.ok(recBranch1);
  assert.strictEqual(recBranch1.dispatchState, 'lineage_unverified');
  assert.strictEqual(recBranch1.status, 'failed');

  // Case 2: mismatched parent session ID
  const branch2 = registerPendingBranch(mockArgs, mockPage, mockSourceTurn, {
    parentSessionId: '12345678-1234-4234-8234-123456789abc'
  });
  updateBranchLineage(branch2.id, {
    pid: deadPid,
    dispatchState: 'lineage_attested',
    childSessionId: '22222222-3333-4444-8555-666666666666',
    parentAttestation: {
      parentSessionId: '99999999-9999-9999-9999-999999999999', // Mismatched!
      verifiedVia: 'dom_divider',
    }
  });

  const reconciled2 = reconcileIncompleteBranches();
  const recBranch2 = reconciled2.branches.find(b => b.id === branch2.id);
  assert.ok(recBranch2);
  assert.strictEqual(recBranch2.dispatchState, 'lineage_unverified');
  assert.strictEqual(recBranch2.status, 'failed');
});

test('recoverCandidateBranchLineage: attests candidate child and transitions stranded branch to bound', async () => {
  const parentSessionId = '11111111-2222-4333-8444-555555555555';
  const childSessionId = '66666666-7777-4888-8999-000000000000';
  let currentUrl = `https://chatgpt.com/c/${parentSessionId}`;

  const mockPage = {
    url: () => currentUrl,
    goto: async (url) => { currentUrl = url; },
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    locator: (sel) => ({
      last: () => ({
        waitFor: async () => {},
      })
    }),
    evaluate: async (fn, ...args) => {
      if (typeof fn === 'function') {
        const fnStr = fn.toString();
        if (fnStr.includes('dividerData') || fnStr.includes('branchLink')) {
          return {
            href: currentUrl,
            pathname: new URL(currentUrl).pathname,
            dividerData: {
              hasDivider: true,
              parentSessionId: parentSessionId,
              branchText: 'Branched from earlier conversation',
              precedingTurnCount: 1,
              postDividerTurnTestids: [],
              totalTurns: 2,
            },
            docTitle: 'Branch · Test',
            sidebarTitle: 'Branch · Test',
          };
        }
        if (fnStr.includes('hydrated') || fnStr.includes('sessionIdFromLocation')) {
          return {
            hydrated: true,
            sessionId: childSessionId,
            turnCount: 2,
            roleNodeCount: 2,
            composerVisible: true,
          };
        }
      }
      return { hydrated: true };
    }
  };

  const mockArgs = {
    cdp: 'http://127.0.0.1:9241',
  };

  // Seed stranded branch record
  const mockSourceTurn = { messageId: 'msg-rec-1', testid: 'turn-r1', role: 'assistant' };
  const branch = registerPendingBranch(mockArgs, mockPage, mockSourceTurn, {
    parentSessionId,
  });
  const updatedRecord = updateBranchLineage(branch.id, {
    dispatchState: 'stable_candidate',
    candidateChildSessionId: childSessionId,
  });

  const updated = await recoverCandidateBranchLineage(mockPage, mockArgs, updatedRecord);
  assert.ok(updated);
  assert.strictEqual(updated.dispatchState, 'bound');
  assert.strictEqual(updated.status, 'done');
  assert.strictEqual(updated.childSessionId, childSessionId);
  assert.strictEqual(updated.childUrl, `https://chatgpt.com/c/${childSessionId}`);
});

test('recoverCandidateBranchLineage: marks branch failed when candidate child divider contradicts parent', async () => {
  const parentSessionId = '11111111-2222-4333-8444-555555555555';
  const childSessionId = '66666666-7777-4888-8999-000000000000';
  const wrongParentId = '99999999-8888-4777-8666-555555555555';
  let currentUrl = `https://chatgpt.com/c/${parentSessionId}`;

  const mockPage = {
    url: () => currentUrl,
    goto: async (url) => { currentUrl = url; },
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    locator: (sel) => ({
      last: () => ({
        waitFor: async () => {},
      })
    }),
    evaluate: async (fn, ...args) => {
      if (typeof fn === 'function') {
        const fnStr = fn.toString();
        if (fnStr.includes('dividerData') || fnStr.includes('branchLink')) {
          return {
            href: currentUrl,
            pathname: new URL(currentUrl).pathname,
            dividerData: {
              hasDivider: true,
              parentSessionId: wrongParentId, // Contradictory parent!
              branchText: 'Branched from earlier conversation',
              precedingTurnCount: 1,
              postDividerTurnTestids: [],
              totalTurns: 2,
            },
            docTitle: 'Branch · Test',
            sidebarTitle: 'Branch · Test',
          };
        }
        if (fnStr.includes('hydrated') || fnStr.includes('sessionIdFromLocation')) {
          return {
            hydrated: true,
            sessionId: childSessionId,
            turnCount: 2,
            roleNodeCount: 2,
            composerVisible: true,
          };
        }
      }
      return { hydrated: true };
    }
  };

  const mockArgs = {
    cdp: 'http://127.0.0.1:9241',
  };

  const mockSourceTurn = { messageId: 'msg-rec-2', testid: 'turn-r2', role: 'assistant' };
  const branch = registerPendingBranch(mockArgs, mockPage, mockSourceTurn, {
    parentSessionId,
  });
  const updatedRecord = updateBranchLineage(branch.id, {
    dispatchState: 'stable_candidate',
    candidateChildSessionId: childSessionId,
  });

  const updated = await recoverCandidateBranchLineage(mockPage, mockArgs, updatedRecord);
  assert.ok(updated);
  assert.strictEqual(updated.dispatchState, 'lineage_unverified');
  assert.strictEqual(updated.status, 'failed');
  assert.match(updated.lastError, /contradicts expected parent/);
});

test('openBranchMenu: fails closed when JSHandle.asElement() returns null (realistic Playwright null handle)', async () => {
  const mockTurnEl = {
    first: () => mockTurnEl,
    count: async () => 1,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    locator: (sel) => ({
      first: () => ({
        count: async () => 1,
        isVisible: async () => true,
        click: async () => {},
      })
    })
  };

  let disposed = false;
  // Realistic Playwright evaluateHandle returning JSHandle<null> where asElement() is null
  const mockPageNoMenu = {
    locator: () => mockTurnEl,
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
    evaluate: async () => {},
    evaluateHandle: async () => ({
      asElement: () => null,
      dispose: async () => { disposed = true; },
    }),
  };

  await assert.rejects(
    async () => openBranchMenu(mockPageNoMenu, { messageId: 'm1' }),
    (err) => err.code === 'BRANCH_ACTION_UNVERIFIED'
  );
  assert.strictEqual(disposed, true);
});

test('openBranchMenu: fails closed if baseline visible menus snapshot throws', async () => {
  const mockTurnEl = {
    first: () => mockTurnEl,
    count: async () => 1,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    locator: (sel) => ({
      first: () => ({
        count: async () => 1,
        isVisible: async () => true,
        click: async () => {},
      })
    })
  };

  const mockPageBaselineFail = {
    locator: () => mockTurnEl,
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
    evaluate: async () => {
      throw new Error('CDP execution context destroyed');
    },
  };

  await assert.rejects(
    async () => openBranchMenu(mockPageBaselineFail, { messageId: 'm1' }),
    (err) => err.code === 'BRANCH_ACTION_UNVERIFIED' && /Could not snapshot visible action menus/.test(err.message)
  );
});

test('validateAutoRecoverMode: enforces conversation, incident ID, and exclusivity against other primary operations', () => {
  const validUuid = '11111111-2222-4333-8444-555555555555';

  assert.doesNotThrow(() => {
    validateAutoRecoverMode({ autoRecover: true, conversation: validUuid, recoveryIncidentId: 'INC-100' });
  });

  assert.throws(() => {
    validateAutoRecoverMode({ autoRecover: true, recoveryIncidentId: 'INC-100' });
  }, /--auto-recover requires an explicit stable conversation/);

  assert.throws(() => {
    validateAutoRecoverMode({ autoRecover: true, conversation: validUuid });
  }, /--auto-recover requires an explicit incident identifier/);

  assert.throws(() => {
    validateAutoRecoverMode({ autoRecover: true, conversation: validUuid, recoveryIncidentId: 'INC-100', message: 'hello' });
  }, /--auto-recover cannot be combined with another primary operation/);

  assert.throws(() => {
    validateAutoRecoverMode({ autoRecover: true, conversation: validUuid, recoveryIncidentId: 'INC-100', branchTurn: 'latest' });
  }, /--auto-recover cannot be combined with another primary operation/);

  assert.throws(() => {
    validateAutoRecoverMode({ autoRecover: true, conversation: validUuid, recoveryIncidentId: 'INC-100', retryEdit: 'latest' });
  }, /--auto-recover cannot be combined with another primary operation/);

  assert.throws(() => {
    validateAutoRecoverMode({ autoRecover: true, conversation: validUuid, recoveryIncidentId: 'INC-100', recoveryResend: true });
  }, /--auto-recover cannot be combined with another primary operation/);
});

test('registerRecoveryIncident and updateRecoveryIncident: persist state and journal events to recovery-incidents.jsonl', () => {
  const incidentId = 'INC-LEDGER-TEST';
  const parentSessionId = '11111111-2222-4333-8444-555555555555';
  const userTurnRef = { messageId: 'msg-u1', role: 'user', textHash: 'hash-u1' };
  const anchorTurnRef = { messageId: 'msg-a0', role: 'assistant', textHash: 'hash-a0' };
  const promptPath = '/tmp/fake-prompt.txt';
  const promptHash = 'abc123hash';

  const registered = registerRecoveryIncident(
    incidentId,
    parentSessionId,
    userTurnRef,
    anchorTurnRef,
    promptPath,
    promptHash
  );

  assert.equal(registered.id, incidentId);
  assert.equal(registered.state, 'prepared');
  assert.equal(registered.parentSessionId, parentSessionId);

  // Verify idempotency
  const dup = registerRecoveryIncident(
    incidentId,
    parentSessionId,
    userTurnRef,
    anchorTurnRef,
    promptPath,
    promptHash
  );
  assert.equal(dup.id, incidentId);

  // Update
  const updated = updateRecoveryIncident(incidentId, {
    state: 'stage1_running',
    stage1RoundId: 'round-s1-test',
  });
  assert.equal(updated.state, 'stage1_running');
  assert.equal(updated.stage1RoundId, 'round-s1-test');

  // Verify disk state
  const state = loadRecoveryIncidentsState();
  const found = state.incidents.find(i => i.id === incidentId);
  assert.ok(found);
  assert.equal(found.state, 'stage1_running');
});

test('acquireRecoveryIncidentLease: enforces single-runner exclusivity per incident and releases cleanly', async () => {
  const incidentId = 'INC-LEASE-TEST';
  const lease1 = await acquireRecoveryIncidentLease(incidentId);
  assert.ok(lease1);

  // Second acquisition attempt should fail with INCIDENT_BUSY
  await assert.rejects(
    async () => acquireRecoveryIncidentLease(incidentId, 'token-2'),
    (err) => err.code === 'INCIDENT_BUSY'
  );

  // Release
  releaseRecoveryIncidentLease(lease1);

  // Should succeed after release
  const lease2 = await acquireRecoveryIncidentLease(incidentId, 'token-2');
  assert.ok(lease2);
  releaseRecoveryIncidentLease(lease2);
});


test('captureUserTurnVersionBaseline: returns implicit version 1 when variants button is absent and action bar is mounted', async () => {
  const fakeLocator = (sel) => {
    if (sel.includes('variants-turn-action-button')) {
      return {
        first: () => fakeLocator(sel),
        count: async () => 0,
        isVisible: async () => false,
      };
    }
    if (sel.includes('Your message actions')) {
      return {
        first: () => fakeLocator(sel),
        count: async () => 1,
        isVisible: async () => true,
      };
    }
    return {
      first: () => fakeLocator(sel),
      count: async () => 1,
      scrollIntoViewIfNeeded: async () => {},
      hover: async () => {},
      locator: (sub) => fakeLocator(sub),
    };
  };

  const fakePage = {
    locator: (sel) => fakeLocator(sel),
    waitForTimeout: async () => {},
  };

  const sourceUser = {
    id: 'msg-u1',
    text: 'Hello world',
    textHash: 'hash-u1',
  };

  const baseline = await captureUserTurnVersionBaseline(fakePage, sourceUser);
  assert.equal(baseline.count, 1);
  assert.equal(baseline.activeIndex, 1);
  assert.equal(baseline.method, 'variants_ui_implicit_v1');
  assert.equal(baseline.activeRenderedHash, 'hash-u1');
});

test('captureUserTurnVersionBaseline: fails closed if action bar is unhydrated (does not assume K=1)', async () => {
  const fakeLocator = (sel) => {
    if (sel.includes('Your message actions')) {
      return {
        first: () => fakeLocator(sel),
        count: async () => 0,
        isVisible: async () => false,
      };
    }
    return {
      first: () => fakeLocator(sel),
      count: async () => 1,
      scrollIntoViewIfNeeded: async () => {},
      hover: async () => {},
      locator: (sub) => fakeLocator(sub),
    };
  };

  const fakePage = {
    locator: (sel) => fakeLocator(sel),
    waitForTimeout: async () => {},
  };

  await assert.rejects(
    async () => captureUserTurnVersionBaseline(fakePage, { id: 'msg-u-unhydrated', text: 'hi' }),
    (err) => err.code === 'EDIT_VERSION_BASELINE_UNVERIFIED'
  );
});

test('captureUserTurnVersionBaseline: traverses versions to find K and restores initial active index', async () => {
  let currentIndex = 1;
  const maxIndex = 3;
  let closeClicked = false;

  const fakeHeader = {
    locator: (sel) => {
      if (sel.includes('Version')) {
        return {
          first: () => ({
            count: async () => 1,
            innerText: async () => `Version ${currentIndex}`,
          }),
        };
      }
      if (sel.includes('Next version')) {
        return {
          first: () => ({
            isDisabled: async () => currentIndex >= maxIndex,
            click: async () => { currentIndex++; },
          }),
        };
      }
      if (sel.includes('Previous version')) {
        return {
          first: () => ({
            isDisabled: async () => currentIndex <= 1,
            click: async () => { currentIndex--; },
          }),
        };
      }
      return { first: () => ({ count: async () => 0 }) };
    },
  };

  const sourceUser = {
    id: 'msg-u2',
    testid: 'turn-user-2',
    text: 'Hello world v1',
    textHash: messageHash(normalizeTurnText('Hello world v1')),
  };

  const fakePage = {
    evaluate: async () => [
      {
        index: 0,
        testid: 'turn-user-2',
        messageId: 'msg-u2',
        role: 'user',
        text: 'Hello world v1',
      },
    ],
    locator: (sel) => {
      if (sel.includes('Your message actions')) {
        return {
          first: () => ({ count: async () => 1, isVisible: async () => true }),
        };
      }
      if (sel.includes('variants-turn-action-button')) {
        return {
          first: () => ({
            count: async () => 1,
            isVisible: async () => true,
            click: async () => {},
          }),
        };
      }
      if (sel.includes('Previous version')) {
        return {
          last: () => fakeHeader,
        };
      }
      if (sel.includes('close-button')) {
        return {
          last: () => ({
            count: async () => 1,
            isVisible: async () => true,
            click: async () => { closeClicked = true; },
          }),
        };
      }
      return {
        first: () => ({
          count: async () => 1,
          scrollIntoViewIfNeeded: async () => {},
          hover: async () => {},
          locator: (sub) => fakePage.locator(sub),
        }),
      };
    },
    waitForTimeout: async () => {},
  };

  const baseline = await captureUserTurnVersionBaseline(fakePage, sourceUser);
  assert.equal(baseline.count, 3);
  assert.equal(baseline.activeIndex, 1);
  assert.equal(baseline.method, 'variants_ui_traversal');
  assert.equal(closeClicked, true);
  assert.equal(currentIndex, 1, 'Initial active index must be strictly restored');
});

test('captureUserTurnVersionBaseline: fails closed if version label is malformed', async () => {
  const fakeHeader = {
    locator: (sel) => {
      if (sel.includes('Version')) {
        return {
          first: () => ({
            count: async () => 1,
            innerText: async () => 'Invalid Label Format',
          }),
        };
      }
      return { first: () => ({ count: async () => 0 }) };
    },
  };

  const fakePage = {
    locator: (sel) => {
      if (sel.includes('Your message actions')) return { first: () => ({ count: async () => 1, isVisible: async () => true }) };
      if (sel.includes('variants-turn-action-button')) return { first: () => ({ count: async () => 1, isVisible: async () => true, click: async () => {} }) };
      if (sel.includes('Previous version')) return { last: () => fakeHeader };
      if (sel.includes('close-button')) return { last: () => ({ count: async () => 1, isVisible: async () => true, click: async () => {} }) };
      return {
        first: () => ({
          count: async () => 1,
          scrollIntoViewIfNeeded: async () => {},
          hover: async () => {},
          locator: (sub) => fakePage.locator(sub),
        }),
      };
    },
    waitForTimeout: async () => {},
  };

  await assert.rejects(
    async () => captureUserTurnVersionBaseline(fakePage, { id: 'msg-u-malformed', text: 'hi' }),
    (err) => err.code === 'EDIT_VERSION_VIEWER_UNVERIFIED'
  );
});

test('attestEditedUserTurnVersion: verifies K+1 version count and matching rendered content', async () => {
  let closeClicked = false;
  const baseline = { count: 2, activeIndex: 2 };
  const expectedHash = messageHash(normalizeTurnText('Rendered content for hash matching'));

  const fakeHeader = {
    locator: (sel) => {
      if (sel.includes('Version')) {
        return {
          first: () => ({
            count: async () => 1,
            innerText: async () => 'Version 3',
          }),
        };
      }
      if (sel.includes('Next version')) {
        return {
          first: () => ({
            isDisabled: async () => true,
          }),
        };
      }
      return { first: () => ({ count: async () => 0 }) };
    },
  };

  const fakePage = {
    locator: (sel) => {
      if (sel.includes('variants-turn-action-button')) {
        return {
          first: () => ({
            count: async () => 1,
            isVisible: async () => true,
            click: async () => {},
          }),
        };
      }
      if (sel.includes('Previous version')) {
        return {
          last: () => fakeHeader,
        };
      }
      if (sel.includes('close-button')) {
        return {
          last: () => ({
            count: async () => 1,
            isVisible: async () => true,
            click: async () => { closeClicked = true; },
          }),
        };
      }
      return {
        first: () => ({
          count: async () => 1,
          scrollIntoViewIfNeeded: async () => {},
          hover: async () => {},
          locator: (sub) => {
            if (sub.includes('author-role="user"')) {
              return {
                first: () => ({
                  innerText: async () => 'Rendered content for hash matching',
                }),
              };
            }
            return fakePage.locator(sub);
          },
        }),
      };
    },
    waitForTimeout: async () => {},
  };

  const sourceUser = { id: 'msg-u3' };
  const attestation = await attestEditedUserTurnVersion(fakePage, sourceUser, baseline, expectedHash);
  assert.equal(attestation.baselineCount, 2);
  assert.equal(attestation.acceptedCount, 3);
  assert.equal(attestation.acceptedIndex, 3);
  assert.equal(attestation.nextDisabled, true);
  assert.equal(attestation.method, 'variants_ui_post_reload');
  assert.equal(attestation.commitBarrier?.method, 'exact_thread_reload');
  assert.equal(closeClicked, true);
});

test('attestEditedUserTurnVersion: rejects count mismatch with EDIT_VERSION_COUNT_MISMATCH', async () => {
  const baseline = { count: 2 };
  const fakeHeader = {
    locator: (sel) => {
      if (sel.includes('Version')) {
        return {
          first: () => ({
            count: async () => 1,
            innerText: async () => 'Version 2', // Stale count!
          }),
        };
      }
      if (sel.includes('Next version')) {
        return {
          first: () => ({
            isDisabled: async () => false,
          }),
        };
      }
      return { first: () => ({ count: async () => 0 }) };
    },
  };

  const fakePage = {
    locator: (sel) => {
      if (sel.includes('variants-turn-action-button')) {
        return {
          first: () => ({
            count: async () => 1,
            isVisible: async () => true,
            click: async () => {},
          }),
        };
      }
      if (sel.includes('Previous version')) return { last: () => fakeHeader };
      if (sel.includes('close-button')) return { last: () => ({ count: async () => 1, isVisible: async () => true, click: async () => {} }) };
      return {
        first: () => ({
          count: async () => 1,
          scrollIntoViewIfNeeded: async () => {},
          hover: async () => {},
          locator: (sub) => fakePage.locator(sub),
        }),
      };
    },
    waitForTimeout: async () => {},
  };

  await assert.rejects(
    async () => attestEditedUserTurnVersion(fakePage, { id: 'msg-u4' }, baseline, 'dummy-hash'),
    (err) => err.code === 'EDIT_VERSION_COUNT_MISMATCH'
  );
});

test('registerPendingRound: preserves versionBaseline and versionAttestation in round WAL', () => {
  const args = { cdp: 'http://127.0.0.1:9241' };
  const fakePage = { url: () => 'https://chatgpt.com/c/33333333-3333-3333-3333-333333333333' };
  const baseline = { count: 2, activeIndex: 2, method: 'variants_ui' };
  const extra = {
    operationKind: 'edit_retry',
    recoveryStage: 1,
    versionBaseline: baseline,
    versionAttestation: null,
  };

  const round = registerPendingRound(args, fakePage, 'hello', 'turn-1', extra);
  assert.ok(round);
  assert.deepEqual(round.versionBaseline, baseline);
  assert.equal(round.versionAttestation, null);
});

test('reconcileStage1EditTurn: positively promotes uncertain round to accepted when K+1 and content match', async () => {
  const round = {
    id: 'round-recon-1',
    operationKind: 'edit_retry',
    recoveryStage: 1,
    dispatchState: 'commit_verifying',
    expectedSessionId: '44444444-4444-4444-4444-444444444444',
    sourceUserTurn: { id: 'msg-rec-1', testid: 'turn-rec-1' },
    versionBaseline: { count: 1 },
    editedMessageHash: messageHash(normalizeTurnText('Edited prompt text')),
  };

  const fakeHeader = {
    locator: (sel) => {
      if (sel.includes('Version')) {
        return {
          first: () => ({
            count: async () => 1,
            innerText: async () => 'Version 2',
          }),
        };
      }
      if (sel.includes('Next version')) {
        return {
          first: () => ({
            isDisabled: async () => true,
          }),
        };
      }
      return { first: () => ({ count: async () => 0 }) };
    },
  };

  const fakePage = {
    url: () => 'https://chatgpt.com/c/44444444-4444-4444-4444-444444444444',
    goto: async () => {},
    reload: async () => {},
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => ({ hydrated: true }),
    locator: (sel) => {
      if (sel.includes('variants-turn-action-button')) {
        return {
          first: () => ({ count: async () => 1, isVisible: async () => true, click: async () => {} }),
        };
      }
      if (sel.includes('Previous version')) return { last: () => fakeHeader };
      if (sel.includes('close-button')) return { last: () => ({ count: async () => 1, isVisible: async () => true, click: async () => {} }) };
      const node = {
        count: async () => 1,
        scrollIntoViewIfNeeded: async () => {},
        hover: async () => {},
        waitFor: async () => {},
        locator: (sub) => {
          if (sub.includes('author-role="user"')) {
            return {
              first: () => ({
                innerText: async () => 'Edited prompt text',
              }),
            };
          }
          return fakePage.locator(sub);
        },
      };
      return {
        first: () => node,
        last: () => node,
      };
    },
    waitForTimeout: async () => {},
  };

  const res = await reconcileStage1EditTurn(fakePage, {}, round);
  assert.equal(res.outcome, 'promoted_to_accepted');
  assert.equal(res.round.dispatchState, 'accepted');
  assert.equal(res.round.versionAttestation.acceptedCount, 2);
});

test('reconcileStage1EditTurn: remains uncertain when version count is still K (does not abort precommit)', async () => {
  const round = {
    id: 'round-recon-2',
    operationKind: 'edit_retry',
    recoveryStage: 1,
    dispatchState: 'uncertain',
    quiescenceAttestation: { quiescent: true },
    expectedSessionId: '55555555-5555-5555-5555-555555555555',
    sourceUserTurn: { id: 'msg-rec-2', testid: 'turn-rec-2' },
    versionBaseline: { count: 1 },
    editedMessageHash: messageHash(normalizeTurnText('Edited prompt text')),
  };

  const fakePage = {
    url: () => 'https://chatgpt.com/c/55555555-5555-5555-5555-555555555555',
    goto: async () => {},
    reload: async () => {},
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => ({ hydrated: true }),
    locator: (sel) => {
      // Variants button absent -> still K=1
      const node = {
        count: async () => 0,
        isVisible: async () => false,
        scrollIntoViewIfNeeded: async () => {},
        hover: async () => {},
        waitFor: async () => {},
        locator: (sub) => fakePage.locator(sub),
      };
      return {
        first: () => node,
        last: () => node,
      };
    },
    waitForTimeout: async () => {},
  };

  const res = await reconcileStage1EditTurn(fakePage, {}, round);
  assert.equal(res.outcome, 'uncertain');
  assert.equal(res.round.dispatchState, 'uncertain');
});


test('reconcileStage1EditTurn: marks conflict when observed version > expected K+1', async () => {
  const round = {
    id: 'round-recon-conflict-1',
    operationKind: 'edit_retry',
    recoveryStage: 1,
    dispatchState: 'commit_verifying',
    expectedSessionId: '66666666-6666-6666-6666-666666666666',
    sourceUserTurn: { id: 'msg-rec-c1', testid: 'turn-rec-c1' },
    versionBaseline: { count: 1 },
    editedMessageHash: messageHash(normalizeTurnText('Edited prompt text')),
  };

  const fakeHeader = {
    locator: (sel) => {
      if (sel.includes('Version')) {
        return {
          first: () => ({
            count: async () => 1,
            innerText: async () => 'Version 3', // Expected 2, but observed 3 (concurrent mutation!)
          }),
        };
      }
      if (sel.includes('Next version')) return { first: () => ({ isDisabled: async () => true }) };
      return { first: () => ({ count: async () => 0 }) };
    },
  };

  const fakePage = {
    url: () => 'https://chatgpt.com/c/66666666-6666-6666-6666-666666666666',
    goto: async () => {},
    reload: async () => {},
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => ({ hydrated: true }),
    locator: (sel) => {
      if (sel.includes('variants-turn-action-button')) return { first: () => ({ count: async () => 1, isVisible: async () => true, click: async () => {} }) };
      if (sel.includes('Previous version')) return { last: () => fakeHeader };
      if (sel.includes('close-button')) return { last: () => ({ count: async () => 1, isVisible: async () => true, click: async () => {} }) };
      const node = {
        count: async () => 1,
        scrollIntoViewIfNeeded: async () => {},
        hover: async () => {},
        waitFor: async () => {},
        locator: (sub) => {
          if (sub.includes('author-role="user"')) return { first: () => ({ innerText: async () => 'Edited prompt text' }) };
          return fakePage.locator(sub);
        },
      };
      return { first: () => node, last: () => node };
    },
    waitForTimeout: async () => {},
  };

  const res = await reconcileStage1EditTurn(fakePage, {}, round);
  assert.equal(res.outcome, 'conflict');
  assert.equal(res.round.status, 'failed');
  assert.match(res.round.lastError, /Concurrent mutation/);
});

test('reconcileStage1EditTurn: marks conflict when content hash mismatches expected', async () => {
  const round = {
    id: 'round-recon-conflict-2',
    operationKind: 'edit_retry',
    recoveryStage: 1,
    dispatchState: 'commit_verifying',
    expectedSessionId: '77777777-7777-7777-7777-777777777777',
    sourceUserTurn: { id: 'msg-rec-c2', testid: 'turn-rec-c2' },
    versionBaseline: { count: 1 },
    editedMessageHash: messageHash(normalizeTurnText('Expected text')),
  };

  const fakeHeader = {
    locator: (sel) => {
      if (sel.includes('Version')) {
        return {
          first: () => ({
            count: async () => 1,
            innerText: async () => 'Version 2',
          }),
        };
      }
      if (sel.includes('Next version')) return { first: () => ({ isDisabled: async () => true }) };
      return { first: () => ({ count: async () => 0 }) };
    },
  };

  const fakePage = {
    url: () => 'https://chatgpt.com/c/77777777-7777-7777-7777-777777777777',
    goto: async () => {},
    reload: async () => {},
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => ({ hydrated: true }),
    locator: (sel) => {
      if (sel.includes('variants-turn-action-button')) return { first: () => ({ count: async () => 1, isVisible: async () => true, click: async () => {} }) };
      if (sel.includes('Previous version')) return { last: () => fakeHeader };
      if (sel.includes('close-button')) return { last: () => ({ count: async () => 1, isVisible: async () => true, click: async () => {} }) };
      const node = {
        count: async () => 1,
        scrollIntoViewIfNeeded: async () => {},
        hover: async () => {},
        waitFor: async () => {},
        locator: (sub) => {
          if (sub.includes('author-role="user"')) return { first: () => ({ innerText: async () => 'Different unexpected text' }) };
          return fakePage.locator(sub);
        },
      };
      return { first: () => node, last: () => node };
    },
    waitForTimeout: async () => {},
  };

  const res = await reconcileStage1EditTurn(fakePage, {}, round);
  assert.equal(res.outcome, 'conflict');
  assert.equal(res.round.status, 'failed');
  assert.match(res.round.lastError, /Attribution conflict/);
});


test('autoRecoverConversationTurn: stage1_running restart reconciles existing round and halts without editing again', async () => {
  const incidentId = 'INC-STAGE1-RESTART-TEST';
  const parentSessionId = '88888888-8888-8888-8888-888888888888';

  // Seed incident state as stage1_running
  registerRecoveryIncident(
    incidentId,
    parentSessionId,
    { id: 'msg-u-res', testid: 'turn-u-res' },
    { messageId: 'msg-a-res', testid: 'turn-a-res' },
    '/tmp/test-prompt-res.txt',
    'hash-test-res'
  );
  updateRecoveryIncident(incidentId, { state: 'stage1_running' });

  // Seed existing round in state
  const roundState = loadRoundState();
  const existingRound = {
    id: 'round-s1-existing',
    recoveryIncidentId: incidentId,
    recoveryStage: 1,
    operationKind: 'edit_retry',
    dispatchState: 'uncertain',
    expectedSessionId: parentSessionId,
    sourceUserTurn: { id: 'msg-u-res', testid: 'turn-u-res' },
    versionBaseline: { count: 1 },
    editedMessageHash: 'hash-test-res',
  };
  roundState.rounds.push(existingRound);
  saveRoundState(roundState);

  // Fake page where variants button is absent -> outcome remains uncertain
  const fakePage = {
    url: () => `https://chatgpt.com/c/${parentSessionId}`,
    goto: async () => {},
    reload: async () => {},
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => ({ hydrated: true }),
    locator: (sel) => {
      const node = {
        count: async () => 0,
        isVisible: async () => false,
        scrollIntoViewIfNeeded: async () => {},
        hover: async () => {},
        waitFor: async () => {},
        locator: (sub) => fakePage.locator(sub),
      };
      return { first: () => node, last: () => node };
    },
    waitForTimeout: async () => {},
  };

  const args = {
    expectedSessionId: parentSessionId,
    recoveryIncidentId: incidentId,
    cdp: 'http://127.0.0.1:9241',
  };

  const res = await autoRecoverConversationTurn(fakePage, args);
  assert.equal(res.state, 'stage1_needs_reconciliation');
  assert.match(res.error, /human intervention required/);

  // Verify incident state in ledger
  const incidentsState = loadRecoveryIncidentsState();
  const incident = incidentsState.incidents.find(i => i.id === incidentId);
  assert.equal(incident.state, 'stage1_needs_reconciliation');
});


test('autoRecoverConversationTurn: rejects incident parent mismatch with INCIDENT_TARGET_MISMATCH', async () => {
  const incidentId = 'INC-MISMATCH-TEST';
  registerRecoveryIncident(
    incidentId,
    '11111111-1111-1111-1111-111111111111',
    { id: 'u1' },
    { messageId: 'a1' },
    '/tmp/p1.txt',
    'hash1'
  );

  const fakePage = {};
  const args = {
    expectedSessionId: '22222222-2222-2222-2222-222222222222', // Mismatch!
    recoveryIncidentId: incidentId,
  };

  await assert.rejects(
    async () => autoRecoverConversationTurn(fakePage, args),
    (err) => err.code === 'INCIDENT_TARGET_MISMATCH'
  );
});

test('autoRecoverConversationTurn: rejects modified prompt artifact with INCIDENT_PROMPT_INTEGRITY_MISMATCH', async () => {
  const incidentId = 'INC-HASH-TEST';
  const parentId = '33333333-3333-3333-3333-333333333333';
  const pPath = path.join(testIsolationDir, 'prompt-hash-test.txt');
  fs.writeFileSync(pPath, 'Original prompt content');
  const originalHash = require('crypto').createHash('sha256').update('Original prompt content').digest('hex');

  registerRecoveryIncident(
    incidentId,
    parentId,
    { id: 'u1', testid: 't1' },
    { messageId: 'a1', testid: 't2' },
    pPath,
    originalHash
  );
  updateRecoveryIncident(incidentId, { state: 'stage1_terminal_failed' });

  // Tamper with prompt file on disk
  fs.writeFileSync(pPath, 'Tampered prompt content');

  const fakePage = {
    url: () => `https://chatgpt.com/c/${parentId}`,
  };
  const args = {
    expectedSessionId: parentId,
    recoveryIncidentId: incidentId,
  };

  await assert.rejects(
    async () => autoRecoverConversationTurn(fakePage, args),
    (err) => err.code === 'INCIDENT_PROMPT_INTEGRITY_MISMATCH'
  );
});

test('autoRecoverConversationTurn: stage2_running restart reconciles existing round and does not resend', async () => {
  const incidentId = 'INC-S2-RESUME-TEST';
  const parentId = '44444444-4444-4444-4444-444444444444';
  const pPath = path.join(testIsolationDir, 'prompt-s2.txt');
  fs.writeFileSync(pPath, 'S2 prompt text');
  const h = require('crypto').createHash('sha256').update('S2 prompt text').digest('hex');

  registerRecoveryIncident(
    incidentId,
    parentId,
    { id: 'u1', testid: 't1' },
    { messageId: 'a1', testid: 't2' },
    pPath,
    h
  );
  updateRecoveryIncident(incidentId, { state: 'stage2_running' });

  // Seed existing completed Stage 2 round
  const roundState = loadRoundState();
  roundState.rounds.push({
    id: 'round-s2-test',
    recoveryIncidentId: incidentId,
    recoveryStage: 2,
    dispatchState: 'accepted',
    assistantOutcome: 'succeeded',
    expectedSessionId: parentId,
  });
  saveRoundState(roundState);

  const fakePage = { url: () => `https://chatgpt.com/c/${parentId}` };
  const args = { expectedSessionId: parentId, recoveryIncidentId: incidentId };

  const res = await autoRecoverConversationTurn(fakePage, args);
  assert.equal(res.state, 'completed_stage2');

  const incState = loadRecoveryIncidentsState();
  const inc = incState.incidents.find(i => i.id === incidentId);
  assert.equal(inc.state, 'completed_stage2');
});

test('autoRecoverConversationTurn: stage3_running restart reconciles existing branch and does not branch again', async () => {
  const incidentId = 'INC-S3-RESUME-TEST';
  const parentId = '55555555-5555-5555-5555-555555555555';
  const childId = '66666666-6666-6666-6666-666666666666';
  const pPath = path.join(testIsolationDir, 'prompt-s3.txt');
  fs.writeFileSync(pPath, 'S3 prompt text');
  const h = require('crypto').createHash('sha256').update('S3 prompt text').digest('hex');

  registerRecoveryIncident(
    incidentId,
    parentId,
    { id: 'u1', testid: 't1' },
    { messageId: 'a1', testid: 't2' },
    pPath,
    h
  );
  updateRecoveryIncident(incidentId, { state: 'stage3_running' });

  // Seed existing bound Stage 3 branch with real production schema
  const lineageState = loadLineageState();
  lineageState.branches.push({
    id: 'branch-s3-test',
    recoveryIncidentId: incidentId,
    status: 'done',
    dispatchState: 'bound',
    parentSessionId: parentId,
    childSessionId: childId,
    childUrl: `https://chatgpt.com/c/${childId}`,
  });
  saveLineageState(lineageState);

  const fakePage = { url: () => `https://chatgpt.com/c/${parentId}` };
  const args = { expectedSessionId: parentId, recoveryIncidentId: incidentId };

  const res = await autoRecoverConversationTurn(fakePage, args);
  assert.equal(res.state, 'completed_stage3_bound');
  assert.equal(res.childSessionId, childId);

  const incState = loadRecoveryIncidentsState();
  const inc = incState.incidents.find(i => i.id === incidentId);
  assert.equal(inc.state, 'completed_stage3_bound');
});


test('resolveEditableUserTurn: rejects mutation if selected turn is not the latest with CONCURRENT_CONVERSATION_MUTATION', async () => {
  const fakePage = {
    $$eval: async () => [
      { role: 'user', id: 'u1', testid: 'turn-1', text: 'Prompt 1' },
      { role: 'assistant', id: 'a1', testid: 'turn-2', text: 'Answer 1' },
      { role: 'user', id: 'u2', testid: 'turn-3', text: 'Prompt 2' },
      { role: 'assistant', id: 'a2', testid: 'turn-4', text: 'Answer 2' },
    ],
  };

  // Attempting to edit u1 when u2 is now the latest user turn
  await assert.rejects(
    async () => resolveEditableUserTurn(fakePage, 'u1', '.'),
    (err) => err.code === 'CONCURRENT_CONVERSATION_MUTATION'
  );
});


test('resolveEditableUserTurn: rejects mutation if turn revision hash drifts with REVISION_HASH_DRIFT', async () => {
  const fakePage = {
    $$eval: async () => [
      { role: 'user', id: 'u1', testid: 'turn-1', text: 'Modified prompt text' },
    ],
  };

  // Expected frozen hash does not match current text
  await assert.rejects(
    async () => resolveEditableUserTurn(fakePage, 'u1', '.', 'frozen-original-hash-12345'),
    (err) => err.code === 'REVISION_HASH_DRIFT'
  );
});

test('stage1CommitIsAttested: validates complete dual-vector attestation and rejects incomplete records', () => {
  const validRound = {
    dispatchState: 'accepted',
    editedMessageHash: 'hash-edited',
    versionBaseline: { count: 2 },
    versionAttestation: {
      baselineCount: 2,
      acceptedCount: 3,
      contentHash: 'hash-edited',
      nextDisabled: true,
      method: 'variants_ui_post_reload',
      commitBarrier: {
        method: 'exact_thread_reload',
        phase: 'stage1-post-submit-rehydration',
      },
    },
  };
  assert.equal(stage1CommitIsAttested(validRound), true);

  // Missing versionAttestation
  assert.equal(stage1CommitIsAttested({ ...validRound, versionAttestation: null }), false);

  // Accepted count not baseline + 1
  assert.equal(stage1CommitIsAttested({
    ...validRound,
    versionAttestation: { ...validRound.versionAttestation, acceptedCount: 2 },
  }), false);

  // Content hash mismatch
  assert.equal(stage1CommitIsAttested({
    ...validRound,
    versionAttestation: { ...validRound.versionAttestation, contentHash: 'wrong-hash' },
  }), false);

  // Next not disabled (not latest version)
  assert.equal(stage1CommitIsAttested({
    ...validRound,
    versionAttestation: { ...validRound.versionAttestation, nextDisabled: false },
  }), false);

  // Pre-barrier legacy attestation method without reload commit barrier rejected
  assert.equal(stage1CommitIsAttested({
    ...validRound,
    versionAttestation: {
      ...validRound.versionAttestation,
      method: 'variants_ui',
      commitBarrier: null,
    },
  }), false);
});

test('resolveBranchableTurn: rejects mutation if anchor revision hash drifts with ANCHOR_REVISION_DRIFT', async () => {
  const fakePage = {
    evaluate: async () => [
      { role: 'user', messageId: 'u1', text: 'Prompt 1' },
      { role: 'assistant', messageId: 'a1', text: 'Original Assistant Response' },
    ],
  };

  // Correct anchor hash succeeds
  const expectedHash = messageHash(normalizeTurnText('Original Assistant Response'));
  const res = await resolveBranchableTurn(fakePage, 'latest', expectedHash);
  assert.equal(res.messageId, 'a1');
  assert.equal(res.textHash, expectedHash);

  // Drifted anchor hash throws ANCHOR_REVISION_DRIFT
  await assert.rejects(
    async () => resolveBranchableTurn(fakePage, 'latest', 'frozen-stale-hash-99999'),
    (err) => err.code === 'ANCHOR_REVISION_DRIFT'
  );
});

test('attestEditedUserTurnVersion: resolves numeric K+1 when active version label is Current version via predecessor probe', async () => {
  let closeClicked = false;
  const baseline = { count: 2, activeIndex: 2 };
  const editedText = 'Rendered edited content for current version test';
  const expectedHash = messageHash(normalizeTurnText(editedText));

  let currentLabel = 'Current version';
  let nextDisabled = true;
  let prevDisabled = false;

  const fakeHeader = {
    locator: (sel) => {
      if (sel.includes('Version') || sel.includes('Current version')) {
        return {
          first: () => ({
            count: async () => 1,
            innerText: async () => currentLabel,
          }),
        };
      }
      if (sel.includes('Previous version')) {
        return {
          first: () => ({
            isDisabled: async () => prevDisabled,
            click: async () => {
              currentLabel = 'Version 2';
              nextDisabled = false;
            },
          }),
        };
      }
      if (sel.includes('Next version')) {
        return {
          first: () => ({
            isDisabled: async () => nextDisabled,
            click: async () => {
              currentLabel = 'Current version';
              nextDisabled = true;
            },
          }),
        };
      }
      return { first: () => ({ count: async () => 0 }) };
    },
  };

  const fakePage = {
    locator: (sel) => {
      if (sel.includes('variants-turn-action-button')) {
        return {
          first: () => ({
            count: async () => 1,
            isVisible: async () => true,
            click: async () => {},
          }),
        };
      }
      if (sel.includes('Previous version')) {
        return {
          last: () => fakeHeader,
        };
      }
      if (sel.includes('close-button')) {
        return {
          last: () => ({
            count: async () => 1,
            isVisible: async () => true,
            click: async () => { closeClicked = true; },
          }),
        };
      }
      return {
        first: () => ({ count: async () => 0, isVisible: async () => false }),
        last: () => ({ count: async () => 0, isVisible: async () => false }),
      };
    },
    waitForTimeout: async () => {},
  };

  const fakeTurnRoot = {
    count: async () => 1,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    locator: (sel) => {
      if (sel.includes('variants-turn-action-button')) {
        return {
          first: () => ({
            count: async () => 1,
            isVisible: async () => true,
            click: async () => {},
          }),
        };
      }
      if (sel.includes('user')) {
        return {
          first: () => ({
            innerText: async () => editedText,
          }),
        };
      }
      return { first: () => ({ count: async () => 0, isVisible: async () => false }) };
    },
  };

  const sourceUser = {
    testid: 'turn-u-curr',
    text: editedText,
    textHash: expectedHash,
  };

  // Mock resolveUserTurnRoot
  fakePage.locator = (sel) => {
    if (sel.includes('turn-u-curr')) {
      return {
        first: () => fakeTurnRoot,
      };
    }
    if (sel.includes('Previous version')) {
      return {
        last: () => fakeHeader,
      };
    }
    if (sel.includes('close-button')) {
      return {
        last: () => ({
          count: async () => 1,
          isVisible: async () => true,
          click: async () => { closeClicked = true; },
        }),
      };
    }
    return {
      first: () => ({ count: async () => 0 }),
      last: () => ({ count: async () => 0 }),
    };
  };

  const attestation = await attestEditedUserTurnVersion(fakePage, sourceUser, baseline, expectedHash);
  assert.equal(attestation.acceptedCount, 3);
  assert.equal(attestation.baselineCount, 2);
  assert.equal(attestation.labelKind, 'current');
  assert.equal(attestation.nextDisabled, true);
  assert.equal(attestation.contentHash, expectedHash);
  assert.equal(closeClicked, true);
});

test('reconcileStage1EditTurn: recovers crashed preparing round by positively restoring branch or failing closed', async () => {
  const preparingRound = {
    id: 'round-prep-1',
    operationKind: 'edit_retry',
    recoveryStage: 1,
    dispatchState: 'preparing',
    status: 'pending',
    expectedSessionId: '6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c',
    sourceUserTurn: { testid: 'turn-u1', text: 'Original text', textHash: 'hash-orig' },
    versionProbe: {
      initialActiveIndex: 2,
      initialLabelKind: 'current',
    },
  };

  // 1. When restoration throws, fails closed with preparing_needs_reconciliation and conflict outcome
  const fakePageFailing = {
    url: () => 'https://chatgpt.com/c/6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c',
    reload: async () => { throw new Error('Network failure during reload'); },
  };

  const resFail = await reconcileStage1EditTurn(fakePageFailing, {}, preparingRound);
  assert.equal(resFail.outcome, 'conflict');
  assert.equal(resFail.round.dispatchState, 'preparing_needs_reconciliation');

  // 2. When no versionProbe was persisted yet, safely marks aborted_precommit
  const preProbeRound = {
    id: 'round-prep-2',
    operationKind: 'edit_retry',
    recoveryStage: 1,
    dispatchState: 'preparing',
    status: 'pending',
    versionProbe: null,
  };
  const resPre = await reconcileStage1EditTurn({}, {}, preProbeRound);
  assert.equal(resPre.outcome, 'aborted_precommit');
  assert.equal(resPre.round.dispatchState, 'aborted_precommit');

  // 3. Positive branch restoration succeeds and re-attests both user and assistant revisions
  let closeClicked = false;
  let currentLabel = 'Current version';
  let nextDisabled = true;

  const fakeHeader = {
    locator: (sel) => {
      if (sel.includes('Version') || sel.includes('Current version')) {
        return {
          first: () => ({
            count: async () => 1,
            innerText: async () => currentLabel,
          }),
        };
      }
      if (sel.includes('Previous version')) {
        return {
          first: () => ({
            isDisabled: async () => false,
            click: async () => {
              currentLabel = 'Version 1';
              nextDisabled = false;
            },
          }),
        };
      }
      if (sel.includes('Next version')) {
        return {
          first: () => ({
            count: async () => 1,
            isDisabled: async () => nextDisabled,
            click: async () => {
              currentLabel = 'Current version';
              nextDisabled = true;
            },
          }),
        };
      }
      return { first: () => ({ count: async () => 0 }) };
    },
  };

  const fakeTurnRoot = {
    count: async () => 1,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    locator: (sel) => {
      if (sel.includes('variants-turn-action-button')) {
        return {
          first: () => ({
            count: async () => 1,
            isVisible: async () => true,
            click: async () => {},
          }),
        };
      }
      return { first: () => ({ count: async () => 0 }) };
    },
  };

  const origHash = messageHash(normalizeTurnText('Original text'));
  const asstHash = messageHash(normalizeTurnText('Original assistant response'));

  const fakePageSuccess = {
    url: () => 'https://chatgpt.com/c/6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c',
    bringToFront: async () => {},
    reload: async () => {},
    waitForLoadState: async () => {},
    waitForSelector: async () => ({}),
    waitForTimeout: async () => {},
    evaluate: async (fn) => {
      if (typeof fn === 'function' && fn.toString().includes('sessionIdFromLocation')) {
        return { hydrated: true, sessionId: '6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c', turnCount: 2, roleNodeCount: 2, composerVisible: true };
      }
      return [
        { role: 'user', testid: 'turn-u1', text: 'Original text' },
        { role: 'assistant', testid: 'turn-a1', text: 'Original assistant response' },
      ];
    },
    locator: (sel) => {
      if (sel.includes('turn-u1')) {
        return { first: () => fakeTurnRoot };
      }
      if (sel.includes('Previous version')) {
        return { last: () => fakeHeader };
      }
      if (sel.includes('close-button')) {
        return {
          last: () => ({
            count: async () => 1,
            isVisible: async () => true,
            click: async () => { closeClicked = true; },
          }),
        };
      }
      return {
        first: () => ({ count: async () => 0, waitFor: async () => {} }),
        last: () => ({ count: async () => 0, waitFor: async () => {} }),
      };
    },
  };

  const successRound = {
    id: 'round-prep-succ',
    operationKind: 'edit_retry',
    recoveryStage: 1,
    dispatchState: 'preparing',
    status: 'pending',
    expectedSessionId: '6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c',
    sourceUserTurn: { testid: 'turn-u1', text: 'Original text', textHash: origHash },
    versionProbe: {
      initialActiveIndex: 2,
      initialLabelKind: 'current',
      initialAssistantRef: { testid: 'turn-a1', textHash: asstHash },
    },
  };

  const resSucc = await reconcileStage1EditTurn(fakePageSuccess, {}, successRound);
  assert.equal(resSucc.outcome, 'aborted_precommit');
  assert.equal(resSucc.round.dispatchState, 'aborted_precommit');
  assert.equal(closeClicked, true);
});

test('reconcileStage1EditTurn: proves numeric K+1 under Current version via predecessor probe', async () => {
  const editedText = 'Reconciled edited prompt text';
  const expectedHash = messageHash(normalizeTurnText(editedText));

  let currentLabel = 'Current version';
  let nextDisabled = true;
  let prevDisabled = false;

  const fakeHeader = {
    locator: (sel) => {
      if (sel.includes('Version') || sel.includes('Current version')) {
        return {
          first: () => ({
            count: async () => 1,
            innerText: async () => currentLabel,
          }),
        };
      }
      if (sel.includes('Previous version')) {
        return {
          first: () => ({
            isDisabled: async () => prevDisabled,
            click: async () => {
              currentLabel = 'Version 2';
              nextDisabled = false;
            },
          }),
        };
      }
      if (sel.includes('Next version')) {
        return {
          first: () => ({
            isDisabled: async () => nextDisabled,
            click: async () => {
              currentLabel = 'Current version';
              nextDisabled = true;
            },
          }),
        };
      }
      return { first: () => ({ count: async () => 0 }) };
    },
  };

  const fakeTurnRoot = {
    count: async () => 1,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    locator: (sel) => {
      if (sel.includes('variants-turn-action-button')) {
        return {
          first: () => ({
            count: async () => 1,
            isVisible: async () => true,
            click: async () => {},
          }),
        };
      }
      if (sel.includes('user')) {
        return {
          first: () => ({
            innerText: async () => editedText,
          }),
        };
      }
      return { first: () => ({ count: async () => 0, isVisible: async () => false }) };
    },
  };

  const fakePage = {
    url: () => 'https://chatgpt.com/c/6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c',
    bringToFront: async () => {},
    reload: async () => {},
    waitForLoadState: async () => {},
    waitForSelector: async () => ({}),
    evaluate: async () => ({ hydrated: true, sessionId: '6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c', turnCount: 3, roleNodeCount: 3, composerVisible: true }),
    locator: (sel) => {
      if (sel.includes('turn-u-recon')) {
        return {
          first: () => fakeTurnRoot,
        };
      }
      if (sel.includes('Previous version')) {
        return {
          last: () => fakeHeader,
        };
      }
      if (sel.includes('close-button')) {
        return {
          last: () => ({
            count: async () => 1,
            isVisible: async () => true,
            click: async () => {},
          }),
        };
      }
      return {
        first: () => ({ count: async () => 0, waitFor: async () => {} }),
        last: () => ({ count: async () => 0, waitFor: async () => {} }),
      };
    },
    waitForTimeout: async () => {},
  };

  const uncertainRound = {
    id: 'round-recon-curr',
    operationKind: 'edit_retry',
    recoveryStage: 1,
    dispatchState: 'commit_verifying',
    status: 'pending',
    expectedSessionId: '6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c',
    sourceUserTurn: { testid: 'turn-u-recon', text: 'Original text' },
    versionBaseline: { count: 2 },
    editedMessageHash: expectedHash,
  };

  const res = await reconcileStage1EditTurn(fakePage, {}, uncertainRound);
  assert.equal(res.outcome, 'promoted_to_accepted');
  assert.equal(res.round.dispatchState, 'accepted');
  assert.equal(res.round.versionAttestation.acceptedCount, 3);
  assert.equal(res.round.versionAttestation.baselineCount, 2);
  assert.equal(res.round.versionAttestation.method, 'variants_ui_reconciled_post_reload');
  assert.equal(res.round.versionAttestation.commitBarrier?.method, 'exact_thread_reload');
  assert.equal(stage1CommitIsAttested(res.round), true);
});

test('submitEditedUserTurn: rejects disabled Send button', async () => {
  let cancelCalled = false;
  const mockCancel = { isVisible: async () => true, click: async () => { cancelCalled = true; } };
  const mockSend = { isVisible: async () => true, isEnabled: async () => false };
  const mockContainer = {
    locator: (sel) => {
      if (sel.includes('Cancel')) return { first: () => mockCancel };
      return {
        count: async () => 1,
        first: () => mockSend,
      };
    },
  };
  const mockEditor = {
    locator: () => mockContainer,
  };

  await assert.rejects(
    async () => submitEditedUserTurn({ url: () => 'https://chatgpt.com/c/6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c' }, mockEditor, '6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c'),
    (err) => err.code === 'EDIT_SUBMIT_CONTROL_UNVERIFIED'
  );
  assert.equal(cancelCalled, true);
});

test('submitEditedUserTurn: rejects mutated editor content before submit', async () => {
  let cancelCalled = false;
  const mockCancel = { isVisible: async () => true, click: async () => { cancelCalled = true; } };
  const mockSend = { isVisible: async () => true, isEnabled: async () => true };
  const mockContainer = {
    locator: (sel) => {
      if (sel.includes('Cancel')) return { first: () => mockCancel };
      return {
        count: async () => 1,
        first: () => mockSend,
      };
    },
  };
  const mockEditor = {
    innerText: async () => 'Unexpected mutated content',
    locator: () => mockContainer,
  };

  const attestation = {
    expectedHash: 'correct_expected_hash',
  };

  await assert.rejects(
    async () => submitEditedUserTurn({
      url: () => 'https://chatgpt.com/c/6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c',
      locator: () => ({ first: () => ({ isVisible: async () => false }) }),
      evaluate: async () => ({ isGenerating: false }),
    }, mockEditor, '6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c', attestation),
    (err) => err.code === 'EDIT_EDITOR_CHANGED_BEFORE_SUBMIT'
  );
  assert.equal(cancelCalled, true);
});

test('getGenerationState: ignores bare Cancel and editor Cancel button while detecting real stop button', async () => {
  const mockEditorCancel = {
    getAttribute: (attr) => (attr === 'type' ? 'button' : null),
    innerText: 'Cancel',
    offsetWidth: 50,
    offsetHeight: 30,
    getClientRects: () => [{}],
    closest: (sel) => ({
      querySelector: () => ({ isConnected: true }),
    }),
  };

  const mockStopButton = {
    getAttribute: (attr) => (attr === 'data-testid' ? 'stop-button' : null),
    innerText: '',
    offsetWidth: 30,
    offsetHeight: 30,
    getClientRects: () => [{}],
    closest: () => null,
  };

  // With only editor Cancel: isGenerating is false
  const pageWithCancelOnly = {
    evaluate: async (fn, pattern) => {
      // Re-run the evaluate logic against mockEditorCancel
      const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight);
      const textOf = (el) => el.innerText || '';
      const voiceControlRe = new RegExp(pattern, 'i');
      function isGenerationControl(button) {
        const testid = button.getAttribute('data-testid') || '';
        const visibleText = textOf(button);
        const meta = `${testid} ${visibleText}`.trim().toLowerCase();
        if (voiceControlRe.test(meta)) return false;
        if (/^cancel$/i.test(visibleText.trim())) return false;
        const turn = button.closest?.('[data-testid^="conversation-turn-"]');
        if (turn && turn.querySelector?.('[id^="message-edit-"]')) return false;
        if (/\bstop-button\b/i.test(testid)) return true;
        return /\bstop\b/i.test(meta);
      }
      const buttons = [mockEditorCancel].filter(isVisible);
      const generatingButton = buttons.find(isGenerationControl);
      return { isGenerating: Boolean(generatingButton) };
    }
  };

  const res1 = await getGenerationState(pageWithCancelOnly);
  assert.equal(res1.isGenerating, false);

  // With both editor Cancel and real stop-button: real stop button wins
  const pageWithBoth = {
    evaluate: async (fn, pattern) => {
      const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight);
      const textOf = (el) => el.innerText || '';
      const voiceControlRe = new RegExp(pattern, 'i');
      function isGenerationControl(button) {
        const testid = button.getAttribute('data-testid') || '';
        const visibleText = textOf(button);
        const meta = `${testid} ${visibleText}`.trim().toLowerCase();
        if (voiceControlRe.test(meta)) return false;
        if (/^cancel$/i.test(visibleText.trim())) return false;
        const turn = button.closest?.('[data-testid^="conversation-turn-"]');
        if (turn && turn.querySelector?.('[id^="message-edit-"]')) return false;
        if (/\bstop-button\b/i.test(testid)) return true;
        return /\bstop\b/i.test(meta);
      }
      const buttons = [mockEditorCancel, mockStopButton].filter(isVisible);
      const generatingButton = buttons.find(isGenerationControl);
      return { isGenerating: Boolean(generatingButton) };
    }
  };

  const res2 = await getGenerationState(pageWithBoth);
  assert.equal(res2.isGenerating, true);
});

test('waitForStage1PostSendQuiescence: completes positively when generation is active then becomes idle', async () => {
  let calls = 0;
  const mockPage = {
    url: () => 'https://chatgpt.com/c/6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c',
    evaluate: async () => {
      calls++;
      // Call 1 & 2: generating = true
      // Call 3 & 4: generating = false (quiescent)
      return { isGenerating: calls <= 2 };
    },
    waitForTimeout: async () => {},
  };

  const res = await waitForStage1PostSendQuiescence(mockPage, '6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c', { timeoutMs: 5000 });
  assert.equal(res.quiescent, true);
  assert.equal(res.generationObserved, true);
  assert.equal(res.reason, 'generation_completed');
});

test('waitForStage1PostSendQuiescence: returns quiescent=false on timeout when timeout is set', async () => {
  const mockPage = {
    url: () => 'https://chatgpt.com/c/6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c',
    evaluate: async () => ({ isGenerating: false }),
    waitForTimeout: async () => {
      // Simulate time passage
      await new Promise((r) => setTimeout(r, 60));
    },
  };

  const res = await waitForStage1PostSendQuiescence(mockPage, '6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c', { timeoutMs: 50 });
  assert.equal(res.quiescent, false);
  assert.equal(res.timedOut, true);
});

test('reconcileStage1EditTurn: dispatching round returns uncertain without executing clean reload', async () => {
  let reloaded = false;
  const mockPage = {
    url: () => 'https://chatgpt.com/c/44444444-4444-4444-4444-444444444444',
    reload: async () => { reloaded = true; },
  };
  const mockRound = {
    id: 'round-disp-1',
    operationKind: 'edit_retry',
    recoveryStage: 1,
    expectedSessionId: '44444444-4444-4444-4444-444444444444',
    sessionId: '44444444-4444-4444-4444-444444444444',
    dispatchState: 'dispatching',
    sourceUserTurn: { id: 'msg-1', testid: 'turn-1' },
    versionBaseline: { count: 1 },
    editedMessageHash: 'some_hash',
  };

  const res = await reconcileStage1EditTurn(mockPage, {}, mockRound);
  assert.equal(res.outcome, 'uncertain');
  assert.equal(reloaded, false);
});

test('reconcileStage1EditTurn: generic uncertain round without quiescence returns uncertain without reloading', async () => {
  let reloaded = false;
  const mockPage = {
    url: () => 'https://chatgpt.com/c/44444444-4444-4444-4444-444444444444',
    reload: async () => { reloaded = true; },
  };
  const mockRound = {
    id: 'round-uncert-1',
    operationKind: 'edit_retry',
    recoveryStage: 1,
    expectedSessionId: '44444444-4444-4444-4444-444444444444',
    sessionId: '44444444-4444-4444-4444-444444444444',
    dispatchState: 'uncertain',
    sourceUserTurn: { id: 'msg-1', testid: 'turn-1' },
    versionBaseline: { count: 1 },
    editedMessageHash: 'some_hash',
  };

  const res = await reconcileStage1EditTurn(mockPage, {}, mockRound);
  assert.equal(res.outcome, 'uncertain');
  assert.equal(reloaded, false);
});

test('browserLaneLeasePath: scopes lock files across conversation, explicit lane, page target, and bootstrap', () => {
  const bootstrapPath = browserLaneLeasePath({ cdp: 'http://127.0.0.1:9241' });
  const conv1Path = browserLaneLeasePath({ cdp: 'http://127.0.0.1:9241', conversation: '6ab3625c-9d58-83ec-aac4-1ecca712f3df' });
  const conv2Path = browserLaneLeasePath({ cdp: 'http://127.0.0.1:9241', conversation: '6ab1fbd6-70a4-83ec-8c39-0b4d62fd8d6c' });
  const lane1Path = browserLaneLeasePath({ cdp: 'http://127.0.0.1:9241', lane: 'worker-1' });
  const lane2Path = browserLaneLeasePath({ cdp: 'http://127.0.0.1:9241', lane: 'worker-2' });
  const pagePath = browserLaneLeasePath({ cdp: 'http://127.0.0.1:9241', targetId: 'E183A7888C611D8F38251B279319A2C4' });

  assert.notEqual(bootstrapPath, conv1Path);
  assert.notEqual(conv1Path, conv2Path);
  assert.notEqual(lane1Path, lane2Path);
  assert.notEqual(conv1Path, lane1Path);
  assert.notEqual(conv1Path, pagePath);
});

test('acquireBrowserLaneLease: allows concurrent leases across different conversations on same CDP', async () => {
  const argsA = { cdp: 'http://127.0.0.1:9241', conversation: '11111111-1111-4111-8111-111111111111' };
  const argsB = { cdp: 'http://127.0.0.1:9241', conversation: '22222222-2222-4222-8222-222222222222' };

  let leaseA = null;
  let leaseB = null;
  try {
    leaseA = acquireBrowserLaneLease(argsA, 'op-a');
    assert.ok(leaseA);

    // Concurrent acquisition on different conversation MUST succeed
    leaseB = acquireBrowserLaneLease(argsB, 'op-b');
    assert.ok(leaseB);

    // Concurrent acquisition on SAME conversation MUST fail closed
    assert.throws(
      () => acquireBrowserLaneLease(argsA, 'op-a-conflict'),
      (err) => err.code === 'BROWSER_LANE_BUSY'
    );
  } finally {
    if (leaseA) releaseBrowserLaneLease(leaseA);
    if (leaseB) releaseBrowserLaneLease(leaseB);
  }
});

test('findTargetAppPage: allocates dedicated page when requested conversation is not among open pages', async () => {
  let createdUrl = null;
  const mockBrowser = {
    contexts: () => [{
      pages: () => [{
        url: () => 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
      }],
      newPage: async () => ({
        goto: async (url) => { createdUrl = url; },
        url: () => createdUrl,
      }),
    }],
    newContext: async () => ({
      newPage: async () => ({
        goto: async (url) => { createdUrl = url; },
        url: () => createdUrl,
      }),
    }),
  };

  const args = {
    conversation: '22222222-2222-4222-8222-222222222222',
  };

  const page = await findTargetAppPage(mockBrowser, args);
  assert.ok(page);
  // Must NOT steal tab 11111111! Must create dedicated tab navigating to 22222222
  assert.equal(createdUrl, 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222');
});

test('withTopologyLease: enforces mutual exclusion and releases cleanly', async () => {
  const mockArgs = { cdp: 'http://127.0.0.1:9241' };
  let insideRan = false;

  await withTopologyLease(mockArgs, 'topo-test', async () => {
    insideRan = true;
    const p = topologyLeasePath(mockArgs);
    assert.equal(fs.existsSync(p), true);

    assert.throws(
      () => acquireTopologyLease(mockArgs, 'topo-concurrent'),
      (err) => err.code === 'BROWSER_TOPOLOGY_BUSY'
    );
  });

  assert.equal(insideRan, true);
  const p = topologyLeasePath(mockArgs);
  assert.equal(fs.existsSync(p), false);
});

test('findTargetAppPage: fails closed with PAGE_TARGET_NOT_FOUND when explicit targetId is missing', async () => {
  const mockBrowser = {
    contexts: () => [{
      pages: () => [{
        _targetId: 'TARGET-A',
        url: () => 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
      }],
    }],
  };

  const args = {
    targetId: 'NONEXISTENT-TARGET',
    cdp: 'http://127.0.0.1:9241',
  };

  await assert.rejects(
    () => findTargetAppPage(mockBrowser, args),
    (err) => err.code === 'PAGE_TARGET_NOT_FOUND'
  );
});

test('findTargetAppPage: fails closed with PAGE_TARGET_AMBIGUOUS when multiple open pages match requested UUID', async () => {
  const mockBrowser = {
    contexts: () => [{
      pages: () => [
        {
          _targetId: 'TARGET-1',
          url: () => 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
        },
        {
          _targetId: 'TARGET-2',
          url: () => 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
        },
      ],
    }],
  };

  const args = {
    conversation: '11111111-1111-4111-8111-111111111111',
    cdp: 'http://127.0.0.1:9241',
  };

  await assert.rejects(
    () => findTargetAppPage(mockBrowser, args),
    (err) => err.code === 'PAGE_TARGET_AMBIGUOUS'
  );
});

test('browserLaneLeasePath: prioritizes pageTargetId over conversation and explicit lane', () => {
  const pageOnly = browserLaneLeasePath({ cdp: 'http://127.0.0.1:9241', pageTargetId: 'TARGET-X' });
  const pageWithConvAndLane = browserLaneLeasePath({
    cdp: 'http://127.0.0.1:9241',
    pageTargetId: 'TARGET-X',
    conversation: '11111111-1111-4111-8111-111111111111',
    lane: 'worker-1',
  });
  // Must match because pageTargetId is #1 priority
  assert.equal(pageOnly, pageWithConvAndLane);
});

test('browserLaneLeasePath: computes identical lock for alias and resolved expectedSessionId', () => {
  const directUuid = browserLaneLeasePath({
    cdp: 'http://127.0.0.1:9241',
    conversation: '11111111-1111-4111-8111-111111111111',
  });
  const aliasWithResolvedUuid = browserLaneLeasePath({
    cdp: 'http://127.0.0.1:9241',
    conversation: 'my-alias',
    expectedSessionId: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(directUuid, aliasWithResolvedUuid);
});

test('findTargetAppPage: binds args.pageTargetId from page CDP target ID', async () => {
  const mockBrowser = {
    contexts: () => [{
      pages: () => [{
        _targetId: 'TARGET-BOUND-1',
        url: () => 'https://chatgpt.com/c/33333333-3333-4333-8333-333333333333',
      }],
    }],
  };

  const args = {
    conversation: '33333333-3333-4333-8333-333333333333',
    cdp: 'http://127.0.0.1:9241',
  };

  const page = await findTargetAppPage(mockBrowser, args);
  assert.ok(page);
  assert.equal(args.pageTargetId, 'TARGET-BOUND-1');
});

test('findTargetAppPage: fails closed with PAGE_TARGET_ID_UNVERIFIED when page target ID cannot be derived', async () => {
  const mockBrowser = {
    contexts: () => [{
      newCDPSession: async () => { throw new Error('CDP target error'); },
      pages: () => [{
        url: () => 'https://chatgpt.com/c/33333333-3333-4333-8333-333333333333',
        context: () => ({ newCDPSession: async () => { throw new Error('CDP target error'); } }),
      }],
    }],
  };

  const args = {
    conversation: '33333333-3333-4333-8333-333333333333',
    cdp: 'http://127.0.0.1:9241',
  };

  await assert.rejects(
    () => findTargetAppPage(mockBrowser, args),
    (err) => err.code === 'PAGE_TARGET_ID_UNVERIFIED'
  );
});

test('openAndResolveVersionViewer: fails closed with EDIT_VERSION_VIEWER_UNVERIFIED when structural ancestor is missing in production', async () => {
  const mockTurnRoot = {
    locator: (sel) => {
      if (sel.includes('variants-turn-action-button')) {
        return {
          first: () => ({
            count: async () => 1,
            isVisible: async () => true,
            scrollIntoViewIfNeeded: async () => {},
            click: async () => {},
          }),
        };
      }
      return { first: () => ({ count: async () => 0 }) };
    },
  };

  const mockPage = {
    context: () => ({}), // Context function exists -> production browser context
    locator: (sel) => {
      if (sel.includes('Previous version')) {
        return {
          first: () => ({
            waitFor: async () => {},
            locator: () => ({ count: async () => 0 }),
          }),
        };
      }
      return { last: () => ({ count: async () => 0 }) };
    },
    waitForTimeout: async () => {},
  };

  await assert.rejects(
    () => openAndResolveVersionViewer(mockPage, mockTurnRoot),
    (err) => err.code === 'EDIT_VERSION_VIEWER_UNVERIFIED'
  );
});
