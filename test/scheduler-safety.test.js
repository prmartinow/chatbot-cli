const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');

// Strictly isolate test outputs to our dedicated scratch directory before requiring CB.js
const testIsolationDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'cb-safety-tests-')
);
process.env.CHATBOT_TRANSCRIPT_DIR = testIsolationDir;
process.env.CHATBOT_STATE_DIR = path.join(testIsolationDir, 'scheduler');

test.after(() => {
  try {
    fs.rmSync(testIsolationDir, { recursive: true, force: true });
  } catch {}
});

const {
  acquireSchedulerLock,
  withSchedulerLock,
  processExists,
  isProcessAlive,
  getProcessStartTime,
  computeJobSerializationKey,
  takeNextScheduledJob,
  markJobRunning,
  finishScheduledJob,
  enqueueScheduledJob,
  recoverQueueStateFromRounds,
  saveQueueState,
  loadQueueState,
  saveConversationIndex,
  loadConversationIndex,
  saveRoundState,
  loadRoundState,
} = require('../CB.js');

const SCHEDULER_DIR = path.join(testIsolationDir, 'scheduler');
const SCHEDULER_LOCK_PATH = path.join(SCHEDULER_DIR, '.lock');

function resetTestState() {
  fs.mkdirSync(SCHEDULER_DIR, { recursive: true });
  try { fs.unlinkSync(SCHEDULER_LOCK_PATH); } catch {}
  saveQueueState({ version: 1, updatedAt: '', jobs: [] });
  saveConversationIndex({ version: 1, updatedAt: '', conversations: [] });
  saveRoundState({ version: 1, updatedAt: '', rounds: [] });
}

test('Mutex: Ownership-safe exclusive lock, token validation on release, and empty-file protection', async () => {
  resetTestState();

  // 1. Acquire scheduler lock
  const release1 = acquireSchedulerLock({ timeoutMs: 500 });
  assert.ok(fs.existsSync(SCHEDULER_LOCK_PATH), 'Lock file should exist');
  assert.ok(release1.token, 'Release function should have token');

  const lockContent1 = JSON.parse(fs.readFileSync(SCHEDULER_LOCK_PATH, 'utf8'));
  assert.equal(lockContent1.pid, process.pid);
  assert.equal(lockContent1.token, release1.token);

  // 2. Another process/attempt with zero/low timeout should fail due to contention while holder is live
  assert.throws(
    () => acquireSchedulerLock({ timeoutMs: 100, retryIntervalMs: 20 }),
    /Scheduler state is locked by another CB process/
  );

  // 3. Stale token release protection: another releaser with wrong token cannot delete the lock
  const fakeReleaser = () => {
    try {
      if (fs.existsSync(SCHEDULER_LOCK_PATH)) {
        const cur = JSON.parse(fs.readFileSync(SCHEDULER_LOCK_PATH, 'utf8'));
        if (cur.token === 'fake-token-xyz') {
          fs.unlinkSync(SCHEDULER_LOCK_PATH);
        }
      }
    } catch {}
  };
  fakeReleaser();
  assert.ok(fs.existsSync(SCHEDULER_LOCK_PATH), 'Lock file must still exist after invalid release');

  // 4. Proper release removes the lock
  release1();
  assert.equal(fs.existsSync(SCHEDULER_LOCK_PATH), false, 'Lock file should be unlinked by legitimate owner');

  // 5. Empty-file stealing protection: an empty/in-flight file within grace period must NOT be stolen immediately
  fs.writeFileSync(SCHEDULER_LOCK_PATH, '', 'utf8');
  const emptyStat = fs.statSync(SCHEDULER_LOCK_PATH);
  // An attempt with timeout < grace period must fail and NOT delete the fresh empty lock
  assert.throws(
    () => acquireSchedulerLock({ timeoutMs: 80, retryIntervalMs: 20, unparseableGraceMs: 5000 }),
    /Scheduler state is locked by another CB process/
  );
  assert.ok(fs.existsSync(SCHEDULER_LOCK_PATH), 'Brand new empty lock must not be deleted as stale within grace period');

  // Clean up empty lock
  try { fs.unlinkSync(SCHEDULER_LOCK_PATH); } catch {}
});

test('Mutex: Reclaims stale lock when holding PID is dead or PID was recycled', () => {
  resetTestState();

  // Create lock file held by non-existent dead PID
  const deadPid = 9999999;
  fs.writeFileSync(SCHEDULER_LOCK_PATH, JSON.stringify({
    pid: deadPid,
    startTime: '12345',
    token: 'dead-process-token',
    at: new Date().toISOString(),
  }), 'utf8');

  // isProcessAlive check
  assert.equal(isProcessAlive(deadPid, '12345'), false);

  // Should successfully reclaim without throwing
  const release = acquireSchedulerLock({ timeoutMs: 500 });
  assert.ok(release);
  const currentLock = JSON.parse(fs.readFileSync(SCHEDULER_LOCK_PATH, 'utf8'));
  assert.equal(currentLock.pid, process.pid);
  release();
  assert.equal(fs.existsSync(SCHEDULER_LOCK_PATH), false);
});

test('Dispatcher: Precomputes active domains and prevents claiming seq1 (pending) when seq2 is running', () => {
  resetTestState();

  const queue = {
    jobs: [
      {
        id: 'job-seq-1',
        seq: 1,
        serializationKey: 'convstream:lane-active-test',
        workerLane: 'default',
        status: 'pending',
        target: { sessionId: 'lane-active-test' },
      },
      {
        id: 'job-seq-2',
        seq: 2,
        serializationKey: 'convstream:lane-active-test',
        workerLane: 'default',
        status: 'running',
        claim: { workerId: 'worker-active-1', token: 'token-active-1', fence: 1, pid: process.pid },
        run: { startedAt: new Date().toISOString(), pid: process.pid },
      },
    ],
  };
  saveQueueState(queue);

  // takeNextScheduledJob must NOT return job-seq-1 because lane-active-test is active (seq 2 running)
  const { job, blocked } = takeNextScheduledJob({ workerId: 'worker-prober' });
  assert.equal(job, null, 'Cannot claim seq 1 pending while seq 2 is active on same serialization key');
  assert.equal(blocked, null);
});

test('Dispatcher: FIFO head-of-stream before worker affinity prevents skipping head to claim later job', () => {
  resetTestState();

  const queue = {
    jobs: [
      {
        id: 'job-head-alpha',
        seq: 1,
        serializationKey: 'convstream:stream-fifo-test',
        workerLane: 'lane-alpha',
        status: 'pending',
        target: { sessionId: 'stream-fifo-test' },
      },
      {
        id: 'job-subsequent-beta',
        seq: 2,
        serializationKey: 'convstream:stream-fifo-test',
        workerLane: 'lane-beta',
        status: 'pending',
        target: { sessionId: 'stream-fifo-test' },
      },
    ],
  };
  saveQueueState(queue);

  // Worker for lane-beta arrives. Even though job #2 has workerLane: 'lane-beta',
  // job #1 is the HEAD of the stream. Worker cannot skip job #1!
  const { job: betaJob } = takeNextScheduledJob({ lane: 'lane-beta', workerId: 'worker-beta' });
  assert.equal(betaJob, null, 'Worker-beta must not skip head job-head-alpha in the same serialization stream');

  // Worker for lane-alpha arrives. Matches head job!
  const { job: alphaJob } = takeNextScheduledJob({ lane: 'lane-alpha', workerId: 'worker-alpha' });
  assert.ok(alphaJob, 'Worker-alpha should claim head job');
  assert.equal(alphaJob.id, 'job-head-alpha');
  assert.equal(alphaJob.status, 'claimed');

  // Once alpha job finishes, subsequent beta job becomes head and can be claimed by worker-beta
  markJobRunning(alphaJob.id, alphaJob.claim);
  finishScheduledJob(alphaJob.id, { status: 'done' }, 'job_completed', alphaJob.claim);

  const { job: betaJobAfter } = takeNextScheduledJob({ lane: 'lane-beta', workerId: 'worker-beta' });
  assert.ok(betaJobAfter, 'Worker-beta can now claim subsequent job after head completed');
  assert.equal(betaJobAfter.id, 'job-subsequent-beta');
  markJobRunning(betaJobAfter.id, betaJobAfter.claim);
  finishScheduledJob(betaJobAfter.id, { status: 'done' }, 'job_completed', betaJobAfter.claim);
});

test('Identity: Stable stream mapping through unresolved alias -> UUID resolution', () => {
  resetTestState();

  const index = loadConversationIndex();

  // Enqueue job with unresolved alias
  const job1 = {
    id: 'job-alias-1',
    seq: 1,
    target: { newConversation: true, alias: 'research-stream-x', sessionId: '' },
    serializationKey: 'alias:research-stream-x',
  };
  const job2 = {
    id: 'job-alias-2',
    seq: 2,
    target: { alias: 'research-stream-x', sessionId: '' },
    serializationKey: 'alias:research-stream-x',
  };

  // Before index resolves alias:
  assert.equal(computeJobSerializationKey(job1, index), 'alias:research-stream-x');
  assert.equal(computeJobSerializationKey(job2, index), 'alias:research-stream-x');

  // Index resolves alias to stable UUID
  const resolvedSessionId = '2a3b4c5d-6e7f-8a9b-0c1d-2e3f4a5b6c7d';
  index.conversations.push({
    alias: 'research-stream-x',
    sessionId: resolvedSessionId,
    streamId: resolvedSessionId,
    status: 'active',
  });
  saveConversationIndex(index);

  // After index resolves, both existing alias jobs must dynamically resolve to convstream:<UUID>
  const key1 = computeJobSerializationKey(job1, index);
  const key2 = computeJobSerializationKey(job2, index);
  assert.equal(key1, `convstream:${resolvedSessionId}`);
  assert.equal(key2, `convstream:${resolvedSessionId}`);

  // A follow-up job targeting the resolved sessionId directly must match the exact same key
  const job3 = {
    id: 'job-alias-3',
    seq: 3,
    target: { sessionId: resolvedSessionId },
  };
  assert.equal(computeJobSerializationKey(job3, index), `convstream:${resolvedSessionId}`);
});

test('Claim: Mandatory token and fence validation', () => {
  resetTestState();

  const queue = {
    jobs: [
      {
        id: 'job-fence-validation',
        seq: 1,
        serializationKey: 'convstream:fence-lane',
        status: 'claimed',
        claim: {
          workerId: 'worker-fencer',
          token: 'token-valid-xyz',
          fence: 3,
          pid: process.pid,
        },
      },
    ],
  };
  saveQueueState(queue);

  // 1. Missing token rejection
  assert.throws(
    () => markJobRunning('job-fence-validation'),
    (err) => err.code === 'CLAIM_TOKEN_REQUIRED'
  );
  assert.throws(
    () => finishScheduledJob('job-fence-validation', { status: 'done' }, 'job_completed'),
    (err) => err.code === 'CLAIM_TOKEN_REQUIRED'
  );

  // 2. Token mismatch rejection
  assert.throws(
    () => markJobRunning('job-fence-validation', 'token-wrong'),
    (err) => err.code === 'STALE_JOB_CLAIM'
  );
  assert.throws(
    () => finishScheduledJob('job-fence-validation', { status: 'done' }, 'job_completed', 'token-wrong'),
    (err) => err.code === 'STALE_JOB_CLAIM'
  );

  // 3. Fence mismatch rejection
  assert.throws(
    () => markJobRunning('job-fence-validation', { token: 'token-valid-xyz', fence: 2 }),
    (err) => err.code === 'STALE_JOB_CLAIM'
  );
  assert.throws(
    () => finishScheduledJob('job-fence-validation', { status: 'done' }, 'job_completed', 'token-valid-xyz', 1),
    (err) => err.code === 'STALE_JOB_CLAIM'
  );

  // 4. Valid claim object with matching fence transitions to running
  const running = markJobRunning('job-fence-validation', { token: 'token-valid-xyz', fence: 3 });
  assert.equal(running.status, 'running');

  // 5. Valid finish with claim object
  const finished = finishScheduledJob(
    'job-fence-validation',
    { status: 'done', result: { ok: true } },
    'job_completed',
    { token: 'token-valid-xyz', fence: 3 }
  );
  assert.equal(finished.status, 'done');
});

test('State: State-monotonic transition enforcement', () => {
  resetTestState();

  const queue = {
    jobs: [
      {
        id: 'job-terminal-done',
        seq: 1,
        status: 'done',
        claim: { workerId: 'w1', token: 'tok-done', fence: 1, pid: process.pid },
      },
      {
        id: 'job-terminal-failed',
        seq: 2,
        status: 'failed',
        claim: { workerId: 'w1', token: 'tok-failed', fence: 1, pid: process.pid },
      },
    ],
  };
  saveQueueState(queue);

  // Cannot mark done -> running
  assert.throws(
    () => markJobRunning('job-terminal-done', 'tok-done', 1),
    (err) => err.code === 'INVALID_STATE_TRANSITION'
  );

  // Cannot finish done -> running or failed
  assert.throws(
    () => finishScheduledJob('job-terminal-done', { status: 'running' }, 'job_started', 'tok-done', 1),
    (err) => err.code === 'INVALID_STATE_TRANSITION'
  );

  // Cannot mark failed -> running without reset
  assert.throws(
    () => markJobRunning('job-terminal-failed', 'tok-failed', 1),
    (err) => err.code === 'INVALID_STATE_TRANSITION'
  );
});

test('Dead owners: Claimed dead reclaim safe vs Running uncertainty needs_recovery', () => {
  resetTestState();

  const deadPid = 9999998;
  const queue = {
    jobs: [
      {
        id: 'job-dead-claim',
        seq: 1,
        serializationKey: 'convstream:lane-dead-claim',
        workerLane: 'default',
        status: 'claimed',
        claim: {
          workerId: 'worker-dead-1',
          token: 'tok-dead-1',
          fence: 1,
          pid: deadPid,
          startTime: '9999',
        },
        target: { sessionId: 'lane-dead-claim' },
      },
      {
        id: 'job-dead-running',
        seq: 2,
        serializationKey: 'convstream:lane-dead-running',
        workerLane: 'default',
        status: 'running',
        claim: {
          workerId: 'worker-dead-2',
          token: 'tok-dead-2',
          fence: 1,
          pid: deadPid,
          startTime: '9999',
        },
        run: {
          startedAt: new Date().toISOString(),
          pid: deadPid,
          startTime: '9999',
        },
        target: { sessionId: 'lane-dead-running' },
      },
    ],
  };
  saveQueueState(queue);

  // Worker asks for next job
  // 1) job-dead-claim was only 'claimed' when worker died -> safely reset to pending and claimed by live worker
  const { job: reclaimedJob } = takeNextScheduledJob({ workerId: 'worker-alive' });
  assert.ok(reclaimedJob);
  assert.equal(reclaimedJob.id, 'job-dead-claim');
  assert.equal(reclaimedJob.claim.workerId, 'worker-alive');
  assert.equal(reclaimedJob.claim.pid, process.pid);

  // 2) job-dead-running was 'running' when worker died -> must NOT be claimed! Must transition to needs_recovery
  const updatedQueue = loadQueueState();
  const runningJob = updatedQueue.jobs.find((j) => j.id === 'job-dead-running');
  assert.equal(runningJob.status, 'needs_recovery', 'Dead running job must transition to needs_recovery');
  assert.ok(runningJob.lastError.includes('Worker process died'));

  markJobRunning(reclaimedJob.id, reclaimedJob.claim);
  finishScheduledJob(reclaimedJob.id, { status: 'done' }, 'job_completed', reclaimedJob.claim);
});

test('Ledger Recovery: No false completion without round and no mutating live owners', () => {
  resetTestState();

  const sessionUuidLive = '11111111-2222-3333-4444-555555555555';
  const sessionUuidDone = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  const sessionUuidNoRound = 'aaaaaaaa-1111-2222-3333-444444444444';

  const queue = {
    jobs: [
      {
        id: 'job-no-round',
        seq: 1,
        message: 'Prompt without any corresponding round in rounds ledger',
        status: 'needs_recovery',
        result: { sessionId: sessionUuidNoRound },
      },
      {
        id: 'job-live-owner',
        seq: 2,
        message: 'Prompt with live running owner',
        status: 'running',
        claim: {
          workerId: 'live-worker-1',
          token: 'tok-live',
          fence: 1,
          pid: process.pid,
          startTime: getProcessStartTime(process.pid),
        },
        run: {
          startedAt: new Date().toISOString(),
          pid: process.pid,
          startTime: getProcessStartTime(process.pid),
        },
        result: { sessionId: sessionUuidLive },
      },
      {
        id: 'job-recoverable',
        seq: 3,
        message: 'Prompt that completed successfully and has valid round',
        status: 'needs_recovery',
        result: { sessionId: sessionUuidDone },
      },
    ],
  };
  saveQueueState(queue);

  const roundState = {
    rounds: [
      // Matching round for job-live-owner (done in round ledger, but job is currently running with live owner)
      {
        id: 'round-live-owner',
        jobId: 'job-live-owner',
        sessionId: sessionUuidLive,
        message: 'Prompt with live running owner',
        status: 'done',
        dispatchState: 'accepted',
        responseChars: 50,
        completedAt: new Date().toISOString(),
      },
      // Matching round for job-recoverable (job needs recovery, round is done with substantive chars)
      {
        id: 'round-recoverable',
        jobId: 'job-recoverable',
        sessionId: sessionUuidDone,
        message: 'Prompt that completed successfully and has valid round',
        status: 'done',
        dispatchState: 'accepted',
        responseChars: 120,
        completedAt: new Date().toISOString(),
      },
    ],
  };
  saveRoundState(roundState);

  const recoveryResult = recoverQueueStateFromRounds(null, { cdp: '', transcript: '' }, {
    activeSessionId: '',
    isGenerating: false,
    url: '',
  });

  const updatedQueue = loadQueueState();

  // 1. Job without any round in rounds.json must NEVER be marked done!
  const noRoundJob = updatedQueue.jobs.find((j) => j.id === 'job-no-round');
  assert.equal(noRoundJob.status, 'needs_recovery', 'Job with no round must NOT be marked done');

  // 2. Job with live running owner must NOT be modified by recovery!
  const liveOwnerJob = updatedQueue.jobs.find((j) => j.id === 'job-live-owner');
  assert.equal(liveOwnerJob.status, 'running', 'Job with live owner must stay running, not touched by recovery');

  // 3. Legitimately completed round with substantive response recovers the matching needs_recovery job to done
  const recoveredJob = updatedQueue.jobs.find((j) => j.id === 'job-recoverable');
  assert.equal(recoveredJob.status, 'done', 'Job with confirmed done round must recover to done');
  assert.equal(recoveredJob.result?.responseChars, 120);
});


test('distinct aliases resolving to one UUID share FIFO before worker affinity', () => {
  resetTestState();
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const index = { conversations: [
    { alias: 'first', sessionId, streamId: 'stream-first' },
    { alias: 'second', sessionId, streamId: 'stream-second' },
  ] };
  saveConversationIndex(index);
  const earlier = { id: 'alias-earlier', seq: 1, status: 'pending', workerLane: 'other', target: { alias: 'second' } };
  const later = { id: 'uuid-later', seq: 2, status: 'pending', workerLane: 'default', target: { sessionId } };
  assert.equal(computeJobSerializationKey(earlier, index), computeJobSerializationKey(later, index));
  saveQueueState({ jobs: [earlier, later] });
  assert.equal(takeNextScheduledJob({ workerId: 'default-worker' }).job, null);
});

test('claim transitions reject omitted fence and a dead owner', () => {
  resetTestState();
  saveQueueState({ jobs: [{ id: 'fenced', seq: 1, status: 'pending', workerLane: 'default', target: { sessionId: 'fenced-stream' } }] });
  const { job } = takeNextScheduledJob({ workerId: 'owner' });
  assert.throws(() => markJobRunning(job.id, job.claim.token), { code: 'STALE_JOB_CLAIM' });
  const queue = loadQueueState();
  queue.jobs[0].claim.pid = 99999999;
  saveQueueState(queue);
  assert.throws(() => markJobRunning(job.id, job.claim), { code: 'STALE_JOB_CLAIM' });
});

test('recovery incident leases carry process identity and reject stale releases', async () => {
  resetTestState();
  const cb = require('../CB.js');
  const first = await cb.acquireRecoveryIncidentLease('incident-fenced');
  const record = JSON.parse(fs.readFileSync(first.leasePath, 'utf8'));
  assert.equal(record.startTime, getProcessStartTime(process.pid));
  assert.ok(first.fence > 0);
  cb.releaseRecoveryIncidentLease({ ...first, fence: first.fence + 1 });
  assert.ok(fs.existsSync(first.leasePath));
  cb.releaseRecoveryIncidentLease(first);
  const second = await cb.acquireRecoveryIncidentLease('incident-fenced');
  assert.ok(second.fence > first.fence);
  cb.releaseRecoveryIncidentLease(first);
  assert.ok(fs.existsSync(second.leasePath));
  cb.releaseRecoveryIncidentLease(second);
});
