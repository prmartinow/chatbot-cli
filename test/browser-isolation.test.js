const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, fork } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright-core');

const executable = process.env.CB_TEST_CHROMIUM_PATH;
test('real CDP: background tabs, two profiles, competing processes and crash reclamation', { skip: !executable, timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-browser-fixture-'));
  const children = new Set();
  const browsers = [];
  const processes = [];
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/') { res.end(fs.readFileSync(path.join(__dirname, 'fixtures/chat-page.html'))); return; }
    res.end('<!doctype html><title>Concurrency fixture</title><div id="prompt-textarea" contenteditable="true"></div><div data-turn-key="fixture" data-turn="assistant"><div data-message-author-role="assistant">Completed review: running jobs should be serialized.</div></div>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.CHATBOT_TRANSCRIPT_DIR = path.join(root, 'outputs');
  process.env.CHATBOT_STATE_DIR = path.join(root, 'state');
  process.env.CHATBOT_WEB_URL = origin;
  process.env.CHATBOT_PLAYWRIGHT_PACKAGE = 'playwright-core';
  const cb = require('../CB.js');
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    for (const browser of browsers) await browser.close().catch(() => {});
    for (const proc of processes) if (proc.exitCode === null) {
      const exited = once(proc, 'exit'); proc.kill('SIGTERM'); await exited;
    }
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function launch(name) {
    const profile = path.join(root, name);
    fs.mkdirSync(profile);
    const proc = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    processes.push(proc);
    const activePort = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(activePort)) {
      if (proc.exitCode !== null || Date.now() > deadline) throw new Error('Fixture Chromium did not expose CDP');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const port = fs.readFileSync(activePort, 'utf8').split('\n')[0];
    const cdp = `http://127.0.0.1:${port}`;
    const browser = await chromium.connectOverCDP(cdp);
    browsers.push(browser);
    return { cdp, browser, context: browser.contexts()[0] };
  }
  function worker(args) {
    const child = fork(path.join(__dirname, 'fixtures/binding-worker.cjs'), [], { env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.add(child);
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture worker timed out')), 15000);
      child.once('message', value => { clearTimeout(timer); resolve(value); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { if (code) { clearTimeout(timer); reject(new Error(`Fixture worker exited ${code}`)); } });
    });
    child.send({ action: 'acquire', args });
    return { child, result };
  }
  async function release(w) {
    const exited = once(w.child, 'exit');
    w.child.send({ action: 'release' });
    await exited;
  }
  const [a, b] = await Promise.all([launch('profile-a'), launch('profile-b')]);
  const sessionA = '11111111-1111-4111-8111-111111111111';
  const sessionB = '22222222-2222-4222-8222-222222222222';
  const pageA = await a.context.newPage(); await pageA.goto(`${origin}/c/${sessionA}`);
  const pageB = await a.context.newPage(); await pageB.goto(`${origin}/c/${sessionB}`);
  const other = await a.context.newPage(); await other.goto('about:blank');
  const pageAcrossProfile = await b.context.newPage(); await pageAcrossProfile.goto(`${origin}/c/${sessionA}`);
  const idA = await cb.getPageTargetId(pageA);
  const idB = await cb.getPageTargetId(pageB);
  const idAcross = await cb.getPageTargetId(pageAcrossProfile);
  const discovery = await require('../lib/browser-targets').inspectBrowser(a.cdp);
  assert.ok(discovery.browserInstanceId.includes('/devtools/browser/'));
  assert.equal(discovery.pages.find(item => item.targetId === idA).url, pageA.url());
  const windowA = discovery.pages.find(item => item.targetId === idA).windowId;
  assert.equal(typeof windowA, 'number');
  const browserSession = await a.browser.newBrowserCDPSession();
  const extraWindow = await browserSession.send('Target.createTarget', { url: `${origin}/c/33333333-3333-4333-8333-333333333333`, newWindow: true });
  const windowOther = (await browserSession.send('Browser.getWindowForTarget', { targetId: extraWindow.targetId })).windowId;
  await browserSession.detach();
  assert.notEqual(windowOther, windowA);
  await assert.rejects(cb.findTargetAppPage(a.browser, { cdp: a.cdp, targetId: idA, windowId: windowOther, status: true }), { code: 'PAGE_WINDOW_MISMATCH' });

  const wA = worker({ cdp: a.cdp, targetId: idA, conversation: sessionA });
  assert.equal((await wA.result).type, 'acquired');
  const wB = worker({ cdp: a.cdp, targetId: idB, conversation: sessionB });
  assert.equal((await wB.result).type, 'acquired', 'different tab/conversation runs concurrently');
  const duplicate = worker({ cdp: a.cdp, targetId: idA });
  assert.equal((await duplicate.result).code, 'BROWSER_LANE_BUSY');
  const sameThread = worker({ cdp: b.cdp, targetId: idAcross, conversation: sessionA });
  assert.equal((await sameThread.result).code, 'CONVERSATION_LEASE_BUSY', 'logical ownership crosses profile/CDP boundaries');
  await release(wB);
  const exited = once(wA.child, 'exit'); wA.child.kill('SIGKILL'); await exited;
  const reclaimed = worker({ cdp: a.cdp, targetId: idA, conversation: sessionA });
  assert.equal((await reclaimed.result).type, 'acquired');
  await release(reclaimed);

  const args = { cdp: a.cdp, targetId: idA, conversation: sessionA };
  const binding = await cb.findTargetAppPage(a.browser, args);
  try {
    assert.equal(binding.targetId, idA);
    await binding.page.locator('#prompt-textarea').focus();
    await binding.page.keyboard.insertText('owned-target-only');
    assert.equal(await pageA.locator('#prompt-textarea').innerText(), 'owned-target-only');
    assert.equal(await pageB.locator('#prompt-textarea').innerText(), '');
    assert.equal(other.url(), 'about:blank');
    const state = await cb.getTargetAppState(pageA);
    assert.equal(state.turnCount, 1);
    assert.equal(cb.buildStateEvent(state).activeProgress, false);
  } finally { cb.releasePageBinding(binding); }
  // Exercise the actual CLI allocation -> ask -> staged publication -> finish path.
  const jobs = [a, b].map((profile, i) => cb.enqueueScheduledJob({ cdp: profile.cdp, newConversation: true, alias: `fixture-queue-${i}`, message: `queue integration sentinel ${i}`, attachments: [], timeout: 15000, timeoutExplicit: true }));
  const runCli = async profile => {
    const cli = spawn(process.execPath, [path.join(__dirname, '../CB.js'), '--cdp', profile.cdp, '--run-queue', '--queue-limit', '1'], {
      env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(cli);
    let output = '';
    cli.stdout.on('data', data => { output += data; });
    cli.stderr.on('data', data => { output += data; });
    const deadline = setTimeout(() => cli.kill('SIGKILL'), 40000);
    const [exit] = await once(cli, 'exit');
    clearTimeout(deadline);
    assert.equal(exit, 0, output);
    return output;
  };
  const cliOutput = (await Promise.all([runCli(a), runCli(b)])).join('\n');
  const results = jobs.map(scheduled => {
    const finished = cb.loadQueueState().jobs.find(item => item.id === scheduled.id);
    assert.equal(finished.status, 'done', cliOutput);
    const canonical = fs.readFileSync(finished.result.transcript, 'utf8');
    const staged = fs.readFileSync(path.join(cb.jobStagingDir(scheduled.id, finished.claim?.fence || finished.fence || 1), 'transcript.pending.txt'), 'utf8');
    assert.equal(canonical, staged);
    assert.ok(canonical.includes(`Fixture completed: ${scheduled.message}`));
    return finished.result;
  });
  assert.notEqual(results[0].sessionId, results[1].sessionId);
  const journal = fs.readFileSync(path.join(root, 'state', 'queue.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const firstCompletion = journal.findIndex(event => event.type === 'job_completed');
  assert.equal(journal.slice(0, firstCompletion).filter(event => event.type === 'job_started').length, 2,
    'both real CLI workers must run concurrently before either completes');
  assert.equal(pageB.url(), `${origin}/c/${sessionB}`);
  assert.equal(other.url(), 'about:blank');
  await assert.rejects(cb.findTargetAppPage(a.browser, { cdp: a.cdp, conversation: 'current', status: true }), { code: 'PAGE_TARGET_AMBIGUOUS' });
  await assert.rejects(cb.findTargetAppPage(a.browser, { cdp: a.cdp, targetId: await cb.getPageTargetId(other), status: true }), { code: 'PAGE_ORIGIN_MISMATCH' });
});
