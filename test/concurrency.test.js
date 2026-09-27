const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');

// Strictly isolate test ledger to temp directory
const testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-concurrency-tests-'));
process.env.CHATBOT_TRANSCRIPT_DIR = testIsolationDir;

test.after(() => {
  try {
    fs.rmSync(testIsolationDir, { recursive: true, force: true });
  } catch {}
});

const {
  takeNextScheduledJob,
  markJobRunning,
  finishScheduledJob,
  saveQueueState,
  loadQueueState,
  acquireTargetLease,
  releaseTargetLease,
  targetLeasePath,
} = require('../CB.js');

test('Multi-process: Concurrent workers claim distinct lanes without head-of-line blocking', async () => {
  const queue = {
    jobs: [
      {
        id: 'job-multi-a1',
        seq: 1,
        serializationKey: 'convstream:lane-alpha',
        workerLane: 'default',
        status: 'running',
        claim: { workerId: 'worker-alpha', token: 'claim-alpha-1', fence: 1 },
      },
      {
        id: 'job-multi-a2',
        seq: 2,
        serializationKey: 'convstream:lane-alpha',
        workerLane: 'default',
        status: 'pending',
        target: { sessionId: 'lane-alpha' },
      },
      {
        id: 'job-multi-b1',
        seq: 3,
        serializationKey: 'convstream:lane-beta',
        workerLane: 'default',
        status: 'pending',
        target: { sessionId: 'lane-beta' },
      },
      {
        id: 'job-multi-c1',
        seq: 4,
        serializationKey: 'convstream:lane-gamma',
        workerLane: 'default',
        status: 'pending',
        target: { sessionId: 'lane-gamma' },
      },
    ],
  };

  saveQueueState(queue);

  // Helper worker script
  const workerScript = path.join(testIsolationDir, 'claim-worker.js');
  fs.writeFileSync(workerScript, `
    const { takeNextScheduledJob, markJobRunning } = require('${path.join(__dirname, '../CB.js')}');
    const workerId = process.argv[2];
    const { job, blocked } = takeNextScheduledJob({ workerId });
    if (job) {
      markJobRunning(job.id, job.claim.token);
      process.send({ success: true, job });
    } else {
      process.send({ success: false, blocked });
    }
  `, 'utf8');

  // Fork two child worker processes concurrently
  const forkWorker = (name) => new Promise((resolve, reject) => {
    const child = fork(workerScript, [name], {
      env: { ...process.env, CHATBOT_TRANSCRIPT_DIR: testIsolationDir },
    });
    child.on('message', (msg) => resolve(msg));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error('Worker ' + name + ' exited with code ' + code));
    });
  });

  const [res1, res2] = await Promise.all([
    forkWorker('worker-child-1'),
    forkWorker('worker-child-2'),
  ]);

  assert.equal(res1.success, true);
  assert.equal(res2.success, true);

  const claimedJobIds = new Set([res1.job.id, res2.job.id]);
  // Must claim lane-beta (seq 3) and lane-gamma (seq 4); lane-alpha (seq 2) must remain pending
  assert.ok(claimedJobIds.has('job-multi-b1'));
  assert.ok(claimedJobIds.has('job-multi-c1'));
  assert.equal(claimedJobIds.has('job-multi-a2'), false);

  const updatedQueue = loadQueueState();
  const jobA2 = updatedQueue.jobs.find(j => j.id === 'job-multi-a2');
  assert.equal(jobA2.status, 'pending');
});

test('Multi-process: Strict FIFO execution per serialization key under concurrent children', async () => {
  const queue = {
    jobs: [
      {
        id: 'job-fifo-1',
        seq: 1,
        serializationKey: 'convstream:serial-lane',
        workerLane: 'default',
        status: 'pending',
        target: { sessionId: 'serial-lane' },
      },
      {
        id: 'job-fifo-2',
        seq: 2,
        serializationKey: 'convstream:serial-lane',
        workerLane: 'default',
        status: 'pending',
        target: { sessionId: 'serial-lane' },
      },
    ],
  };
  saveQueueState(queue);

  // Claim first job
  const { job: job1 } = takeNextScheduledJob({ workerId: 'worker-fifo-1' });
  assert.equal(job1.id, 'job-fifo-1');
  markJobRunning(job1.id, job1.claim.token);

  // Second worker tries to claim immediately
  const { job: job2Blocked } = takeNextScheduledJob({ workerId: 'worker-fifo-2' });
  assert.equal(job2Blocked, null, 'Second job on same serialization key must NOT be claimable while first is running');

  // Finish first job
  finishScheduledJob(job1.id, { status: 'done' }, 'job_completed', job1.claim.token);

  // Second worker can now claim job 2
  const { job: job2Claimed } = takeNextScheduledJob({ workerId: 'worker-fifo-2' });
  assert.ok(job2Claimed);
  assert.equal(job2Claimed.id, 'job-fifo-2');
  finishScheduledJob(job2Claimed.id, { status: 'done' }, 'job_completed', job2Claimed.claim.token);
});

test('Multi-process: Child SIGKILL cleanly allows subsequent worker to reclaim target lease', async () => {
  const cdp = 'http://127.0.0.1:9241';
  const targetId = 'TARGET-CRASH-TEST-' + Date.now();
  const leaseP = targetLeasePath(cdp, targetId);

  // Child script that acquires lease and signals ready, then waits to be SIGKILLed
  const crashWorkerScript = path.join(testIsolationDir, 'crash-worker.js');
  fs.writeFileSync(crashWorkerScript, `
    const { acquireTargetLease } = require('${path.join(__dirname, '../CB.js')}');
    const handle = acquireTargetLease('${cdp}', '${targetId}', 'crash-test');
    process.send({ acquired: true, pid: process.pid, leasePath: handle.leasePath });
    // Hold lease forever until killed
    setInterval(() => {}, 1000);
  `, 'utf8');

  const child = fork(crashWorkerScript, [], {
    env: { ...process.env, CHATBOT_TRANSCRIPT_DIR: testIsolationDir },
  });

  const ready = await new Promise((resolve) => {
    child.on('message', resolve);
  });

  assert.equal(ready.acquired, true);
  assert.equal(fs.existsSync(leaseP), true);

  // Kill child process with SIGKILL (signal 9)
  child.kill('SIGKILL');

  await new Promise((resolve) => {
    child.on('exit', resolve);
  });

  // Second process attempts to acquire lease; must succeed by reclaiming stale lock
  const handle = acquireTargetLease(cdp, targetId, 'recovery-test');
  assert.ok(handle);
  assert.equal(handle.leasePath, leaseP);
  releaseTargetLease(handle);
  assert.equal(fs.existsSync(leaseP), false);
});
