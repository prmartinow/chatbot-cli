const cb = require('../../CB.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
process.on('message', async ({ action, workerId }) => {
  try {
    if (action === 'hold-lock') {
      const release = cb.acquireSchedulerLock();
      process.send({ held: true, token: release.token });
      setInterval(() => {}, 1000);
      return;
    }
    if (action === 'hold-claim' || action === 'hold-running') {
      const { job } = cb.takeNextScheduledJob({ workerId });
      if (action === 'hold-running') cb.markJobRunning(job.id, job.claim);
      process.send({ job });
      setInterval(() => {}, 1000);
      return;
    }
    let count = 0;
    while (true) {
      const { job } = cb.takeNextScheduledJob({ workerId });
      if (!job) break;
      cb.markJobRunning(job.id, job.claim);
      await delay(2 + (job.seq * 7 % 11));
      cb.finishScheduledJob(job.id, { status: 'done', result: { workerId } }, 'job_completed', job.claim);
      count++;
    }
    process.send({ count });
    process.disconnect();
  } catch (error) {
    process.send({ error: error.message, code: error.code });
    process.exitCode = 1;
    process.disconnect();
  }
});
