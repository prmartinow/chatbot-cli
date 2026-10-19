const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-queue-process-'));
process.env.CHATBOT_TRANSCRIPT_DIR = path.join(root, 'outputs');
process.env.CHATBOT_STATE_DIR = path.join(root, 'state');
const cb = require('../CB.js');
const children = new Set();
test.after(async () => {
  await Promise.all([...children].filter(child => child.exitCode === null && child.signalCode === null).map(async child => {
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }));
  fs.rmSync(root, { recursive: true, force: true });
});
function job(seq, stream) {
  return { id: `job-${seq}`, seq, status: 'pending', workerLane: 'default',
    serializationKey: `convstream:${stream}`, target: { sessionId: stream } };
}
function worker(action, workerId) {
  const child = fork(path.join(__dirname, 'fixtures/queue-worker.cjs'), [], {
    env: process.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  children.add(child);
  const exited = once(child, 'exit');
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Queue worker timeout')); }, 20000);
    child.once('message', message => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${message.code}: ${message.error}`));
      else resolve(message);
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (code) reject(new Error(`Queue worker exit ${code}`)); });
  });
  child.send({ action, workerId });
  return { child, result, exited };
}

test('eight real workers drain shared streams exactly once with FIFO and no overlapping starts', { timeout: 30000 }, async () => {
  const jobs = Array.from({ length: 48 }, (_, i) => job(i + 1, `stream-${i % 6}`));
  cb.saveQueueState({ jobs });
  const workers = Array.from({ length: 8 }, (_, i) => worker('drain', `worker-${i}`));
  const receipts = await Promise.all(workers.map(w => w.result));
  await Promise.all(workers.map(w => w.exited));
  assert.equal(receipts.reduce((sum, item) => sum + item.count, 0), jobs.length);
  assert.ok(cb.loadQueueState().jobs.every(item => item.status === 'done'));
  const events = fs.readFileSync(path.join(root, 'state', 'queue.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const active = new Map();
  const completed = new Set();
  const lastSeq = new Map();
  const byId = new Map(jobs.map(item => [item.id, item]));
  for (const event of events) {
    const item = byId.get(event.jobId);
    if (!item) continue;
    const stream = item.serializationKey;
    if (event.type === 'job_started') {
      assert.equal(active.has(stream), false, `overlapping stream ${stream}`);
      assert.ok(item.seq > (lastSeq.get(stream) || 0));
      assert.equal(completed.has(item.id), false);
      active.set(stream, item.id);
      lastSeq.set(stream, item.seq);
    } else if (event.type === 'job_completed') {
      assert.equal(active.get(stream), item.id);
      assert.equal(completed.has(item.id), false);
      active.delete(stream);
      completed.add(item.id);
    }
  }
  assert.equal(active.size, 0);
  assert.equal(completed.size, jobs.length);
});

test('SIGKILL before dispatch reclaims with a higher fence; after dispatch holds the stream', { timeout: 30000 }, async () => {
  cb.saveQueueState({ jobs: [job(100, 'crash-claimed')] });
  const claimant = worker('hold-claim', 'claimant');
  const old = (await claimant.result).job;
  claimant.child.kill('SIGKILL'); await claimant.exited;
  const reclaimed = cb.takeNextScheduledJob({ workerId: 'replacement' }).job;
  assert.equal(reclaimed.id, old.id);
  assert.ok(reclaimed.claim.fence > old.claim.fence);
  assert.throws(() => cb.markJobRunning(old.id, old.claim), { code: 'STALE_JOB_CLAIM' });
  cb.markJobRunning(reclaimed.id, reclaimed.claim);
  cb.finishScheduledJob(reclaimed.id, { status: 'done' }, 'job_completed', reclaimed.claim);

  cb.saveQueueState({ jobs: [job(101, 'crash-running'), job(102, 'crash-running')] });
  const runner = worker('hold-running', 'runner');
  await runner.result;
  runner.child.kill('SIGKILL'); await runner.exited;
  assert.equal(cb.takeNextScheduledJob({ workerId: 'replacement' }).job, null);
  const states = cb.loadQueueState().jobs.map(item => item.status);
  assert.deepEqual(states, ['needs_recovery', 'pending']);
});


test('kernel mutex releases on SIGKILL; orphaned legacy reaper cannot wedge recovery', { timeout: 30000 }, async () => {
  const holder = worker('hold-lock', 'mutex-holder');
  assert.equal((await holder.result).held, true);
  assert.throws(() => cb.acquireSchedulerLock({ timeoutMs: 50 }), { code: 'SCHEDULER_LOCK_BUSY' });
  holder.child.kill('SIGKILL'); await holder.exited;
  const reaper = path.join(root, 'state', '.lock.reaper');
  fs.writeFileSync(reaper, JSON.stringify({ pid: 99999999, startTime: 'dead', token: 'orphan' }));
  const release = cb.acquireSchedulerLock({ timeoutMs: 500 });
  assert.equal(typeof release, 'function');
  release();
  assert.ok(fs.existsSync(path.join(root, 'state', '.lock.guard')), 'stable guard inode must never be unlinked');
});
