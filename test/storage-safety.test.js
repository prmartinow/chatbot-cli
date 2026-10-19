const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-storage-safety-'));
process.env.CHATBOT_TRANSCRIPT_DIR = root;
process.env.CHATBOT_STATE_DIR = path.join(root, 'shared-state');
const cb = require('../CB.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const session = '55555555-5555-4555-8555-555555555555';
const transcript = path.join(root, `${session}.txt`);
const content = turns => turns.map(([role, text]) => cb.formatTranscriptEntry(role, text)).join('');
const original = content([['user', 'original prompt'], ['assistant', 'original answer']]);
const page = (turns, mutate = () => {}) => ({
  url: () => `https://chatgpt.com/c/${session}`,
  evaluate: async fn => {
    if (fn.toString().includes('extracted')) { mutate(); return turns; }
    return { isFork: false };
  },
});

test('divergence preserves canonical content and inode, records a separate candidate', async () => {
  fs.writeFileSync(transcript, original);
  const before = fs.statSync(transcript).ino;
  const result = await cb.syncTranscriptFromPage(page([{ role: 'user', text: 'different prompt' }, { role: 'assistant', text: 'different answer' }]),
    { expectedSessionId: session, transcript }, { generation: { isGenerating: false } });
  assert.equal(result.divergence.code, 'TRANSCRIPT_DIVERGENCE');
  assert.deepEqual(result.appended, []);
  assert.equal(fs.readFileSync(transcript, 'utf8'), original);
  assert.equal(fs.statSync(transcript).ino, before);
  assert.ok(fs.existsSync(result.divergence.candidatePath));
  assert.equal(fs.readdirSync(root).some(name => name.includes('.stale-')), false);
});

test('sync detects a write during browser extraction and does not clobber it', async () => {
  fs.writeFileSync(transcript, original);
  const changed = original + content([['user', 'concurrent turn']]);
  const result = await cb.syncTranscriptFromPage(page([{ role: 'user', text: 'original prompt' }, { role: 'assistant', text: 'original answer' }], () => fs.writeFileSync(transcript, changed)),
    { expectedSessionId: session, transcript }, { generation: { isGenerating: false } });
  assert.equal(result.divergence.reason, 'version_changed');
  assert.equal(fs.readFileSync(transcript, 'utf8'), changed);
});

test('publication rejects busy ownership and diverging history, accepts only an extension', () => {
  const staged = path.join(root, 'staged.txt');
  fs.writeFileSync(transcript, original);
  const next = original + content([['user', 'followup'], ['assistant', 'followup answer']]);
  fs.writeFileSync(staged, next);
  const held = cb.acquireConversationLease(session, 'other-owner');
  try {
    assert.throws(() => cb.publishStagedTranscript(staged, transcript, session), { code: 'CONVERSATION_LEASE_BUSY' });
    assert.equal(fs.readFileSync(transcript, 'utf8'), original);
  } finally { cb.releaseConversationLease(held); }
  assert.equal(cb.publishStagedTranscript(staged, transcript, session).published, true);
  assert.equal(fs.readFileSync(transcript, 'utf8'), next);
  fs.writeFileSync(staged, content([['user', 'unrelated'], ['assistant', 'same length is not safety']]));
  assert.throws(() => cb.publishStagedTranscript(staged, transcript, session), { code: 'TRANSCRIPT_DIVERGENCE' });
  assert.equal(fs.readFileSync(transcript, 'utf8'), next);
});

test('staging identifiers cannot escape the staging root', () => {
  assert.notEqual(cb.jobStagingDir('job-a'), cb.jobStagingDir('job-b'));
  assert.throws(() => cb.jobStagingDir('../canonical'), { code: 'INVALID_JOB_ID' });
});
