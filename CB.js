#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

function loadPlaywright() {
  const override = process.env.CHATBOT_PLAYWRIGHT_CORE_PATH;
  if (override) return require(override);
  const packageName = process.env.CHATBOT_PLAYWRIGHT_PACKAGE || 'rebrowser-playwright-core';
  try {
    return require(packageName);
  } catch (error) {
    if (packageName !== 'playwright-core') {
      throw new Error(`Unable to load ${packageName}. Install it or set CHATBOT_PLAYWRIGHT_PACKAGE=playwright-core to use the unpatched driver. ${error.message || error}`);
    }
    throw error;
  }
}

const { chromium } = loadPlaywright();
const APP_DIR = process.env.CHATBOT_CLI_HOME || __dirname;
const OUTPUT_DIR = process.env.CHATBOT_TRANSCRIPT_DIR || path.join(APP_DIR, 'outputs');
const DEFAULT_CDP = process.env.CHATBOT_CDP_URL || 'http://127.0.0.1:9222';
const CDP_CONNECT_TIMEOUT_MS = Number(process.env.CHATBOT_CDP_CONNECT_TIMEOUT_MS || 60000);
const SESSION_ID_RE = /^[a-f0-9-]{20,}$/i;
const PASTE_SETTLE_MS = 1000;
const RESPONSE_POLL_MS = 3000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 180000;
const RESPONSE_STABLE_FALLBACK_MS = 30000;
const SEND_READY_TIMEOUT_MS = 120000;
const NO_RESPONSE_RELOAD_MS = 90000;
const CONVERSATION_HYDRATION_TIMEOUT_MS = 15000;
const COMPOSER_INSERT_TIMEOUT_MS = 10000;
const PROMPT_ACCEPTED_TIMEOUT_MS = 30000;
const ARTIFACT_ROOT = path.join(OUTPUT_DIR, 'artifacts');
const SCHEDULER_DIR = path.join(OUTPUT_DIR, 'scheduler');
const QUEUE_STATE_PATH = path.join(SCHEDULER_DIR, 'queue.json');
const QUEUE_EVENTS_PATH = path.join(SCHEDULER_DIR, 'queue.jsonl');
const CONVERSATION_INDEX_PATH = path.join(SCHEDULER_DIR, 'conversation-index.json');
const CONVERSATION_EVENTS_PATH = path.join(SCHEDULER_DIR, 'conversation-index.jsonl');
const ROUND_STATE_PATH = path.join(SCHEDULER_DIR, 'rounds.json');
const ROUND_EVENTS_PATH = path.join(SCHEDULER_DIR, 'rounds.jsonl');
const SCHEDULER_LOCK_PATH = path.join(SCHEDULER_DIR, '.lock');
const BRACKETED_PASTE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_OFF = '\x1b[?2004l';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const COMMAND_PREFIXES = [
  '/attach ',
  '/model ',
  '/reasoning ',
  '/status ',
  '/stream ',
];
const COMMANDS = new Set([
  '/exit',
  '/quit',
  '/transcript',
  '/multi',
  '/status',
  '/models',
  '/reasoning',
  '/artifacts',
  '/download',
  '/stop',
]);
const BLOCKING_MODAL_SELECTORS = [
  '#modal-conversation-history-rate-limit',
  '[data-testid="modal-conversation-history-rate-limit"]',
  '#modal-subscription-failure',
  '[data-testid="modal-subscription-failure"]',
  '[id^="modal-"][id*="rate-limit"]',
  '[data-testid^="modal-"][data-testid*="rate-limit"]',
  '[id^="modal-"][id*="subscription"]',
  '[data-testid^="modal-"][data-testid*="subscription"]',
];

function usage() {
  console.log(`Usage:
  CB
  CB --message "your prompt"
  echo "your prompt" | CB --message -

Options:
  --message, -m   Send one message, print the response, append transcript, then exit.
                 Use "-" to read the message from stdin.
  --timeout       Response timeout in ms. Default: 180000 for one-shot prompts;
                  default is no timeout for --run-queue. Use 0 for no timeout.
  --cdp           Chromium DevTools URL. Default: ${DEFAULT_CDP}
  --new-tab       Open a separate target app tab for this invocation.
  --transcript    Transcript path override. Default: outputs/<session-id>.txt
  --attach        File path to attach before sending. Repeat for multiple files.
  --model         Select a model by visible label before sending.
  --reasoning     Select a reasoning mode by visible label before sending.
  --status        Print current target app page state and exit.
  --deep-status   With --status, inspect the model picker/configurator.
                  This opens UI menus; do not use for passive state checks.
  --watch-state   Poll target app state continuously for external orchestration.
  --wait-ready    With --watch-state, exit once a new assistant answer is complete.
  --state-jsonl   Emit state updates as JSON Lines instead of human text.
  --state-interval
                  Poll interval in ms for state watching. Default: ${RESPONSE_POLL_MS}
  --sync-transcript
                  Append any completed live DOM turns missing from the session transcript.
  --latest-assistant
                  Print the full latest assistant response from the live DOM, then exit.
  --schedule      Enqueue --message for later sequential execution, then exit.
  --run-queue     Run scheduled prompts sequentially, waiting for each answer.
  --queue-watch   With --run-queue, keep polling for newly scheduled jobs.
  --queue-status  Print scheduled job and conversation-index state, then exit.
  --recover-queue
                  Sync the active conversation and reconcile queued/running job state.
  --queue-limit   With --run-queue, stop after this many jobs. Default: all.
  --conversation  Target session id or scheduled alias. Use "current" for the active tab.
  --new-conversation
                  Start a new target app conversation before the prompt.
  --alias         Alias to assign to a new or existing conversation in the scheduler index.
  --models        Print visible model picker options and exit.
  --stop          Click the visible stop/interrupt control, if target app is generating.
  --download-artifacts
                  Save artifacts from the latest assistant turn, or after the reply.
  --show-artifacts
                  Print saved text/code artifacts after downloading them.
  --no-stream     Wait silently and print the final response at the end.
  --help, -h      Show this help.

Interactive commands:
  /exit           Quit.
  /quit           Quit.
  /transcript     Print the transcript path.
  /multi          Optional manual multiline mode; paste at CB> works by default.
  /status         Print passive composer, generation, and artifact state.
  /status deep    Also inspect model picker/configurator; opens UI menus.
  /models         Open the model picker and list visible options.
  /reasoning      List visible reasoning controls.
  /model <text>   Select a model by visible label.
  /reasoning <text>
                  Select a reasoning option by visible label.
  /attach <path>  Attach a file to the next message.
  /artifacts      Print links/images/download controls from the latest assistant turn.
  /download       Download visible artifacts from the latest assistant turn.
  /stop           Stop the current generation if a stop/interrupt control is visible.
  /stream on|off  Toggle live response streaming.
`);
}

function parseArgs(argv) {
  const args = {
    message: null,
    timeout: DEFAULT_RESPONSE_TIMEOUT_MS,
    timeoutExplicit: false,
    cdp: DEFAULT_CDP,
    newTab: false,
    transcript: null,
    transcriptOverride: false,
    attachments: [],
    model: '',
    reasoning: '',
    status: false,
    deepStatus: false,
    watchState: false,
    waitReady: false,
    stateJsonl: false,
    stateInterval: RESPONSE_POLL_MS,
    syncTranscript: false,
    latestAssistant: false,
    schedule: false,
    runQueue: false,
    queueWatch: false,
    queueStatus: false,
    recoverQueue: false,
    queueLimit: 0,
    conversation: '',
    newConversation: false,
    alias: '',
    models: false,
    stop: false,
    downloadArtifacts: false,
    showArtifacts: false,
    stream: true,
    scriptedInput: null,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };

    if (arg === '--message' || arg === '-m') args.message = next();
    else if (arg === '--timeout') {
      args.timeout = Number(next());
      args.timeoutExplicit = true;
    }
    else if (arg === '--cdp') args.cdp = next();
    else if (arg === '--new-tab') args.newTab = true;
    else if (arg === '--transcript') {
      args.transcript = next();
      args.transcriptOverride = true;
    }
    else if (arg === '--attach') args.attachments.push(next());
    else if (arg === '--model') args.model = next();
    else if (arg === '--reasoning') args.reasoning = next();
    else if (arg === '--status') args.status = true;
    else if (arg === '--deep-status' || arg === '--inspect-model-config') args.deepStatus = true;
    else if (arg === '--watch-state') args.watchState = true;
    else if (arg === '--wait-ready') args.waitReady = true;
    else if (arg === '--state-jsonl') args.stateJsonl = true;
    else if (arg === '--state-interval') args.stateInterval = Number(next());
    else if (arg === '--sync-transcript') args.syncTranscript = true;
    else if (arg === '--latest-assistant') args.latestAssistant = true;
    else if (arg === '--schedule') args.schedule = true;
    else if (arg === '--run-queue') args.runQueue = true;
    else if (arg === '--queue-watch') args.queueWatch = true;
    else if (arg === '--queue-status') args.queueStatus = true;
    else if (arg === '--recover-queue') args.recoverQueue = true;
    else if (arg === '--queue-limit') args.queueLimit = Number(next());
    else if (arg === '--conversation') args.conversation = next();
    else if (arg === '--new-conversation') args.newConversation = true;
    else if (arg === '--alias') args.alias = next();
    else if (arg === '--models') args.models = true;
    else if (arg === '--stop') args.stop = true;
    else if (arg === '--download-artifacts') args.downloadArtifacts = true;
    else if (arg === '--show-artifacts') args.showArtifacts = true;
    else if (arg === '--no-stream') args.stream = false;
    else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.timeout) || args.timeout < 0) {
    throw new Error('--timeout must be zero or a positive number');
  }
  if (!Number.isFinite(args.stateInterval) || args.stateInterval <= 0) {
    throw new Error('--state-interval must be a positive number');
  }
  if (!Number.isFinite(args.queueLimit) || args.queueLimit < 0) {
    throw new Error('--queue-limit must be zero or a positive number');
  }
  if (args.waitReady) args.watchState = true;
  if (args.queueWatch) args.runQueue = true;

  if (args.transcript) args.transcript = path.resolve(args.transcript);
  args.attachments = args.attachments.map((filePath) => path.resolve(filePath));
  return args;
}

function isInteractiveCommand(text) {
  if (COMMANDS.has(text)) return true;
  return COMMAND_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function isPassiveCurrentPageRead(args) {
  const currentConversation = !args.conversation || isCurrentConversationRef(args.conversation);
  return currentConversation
    && !args.deepStatus
    && !args.newTab
    && !args.newConversation
    && !args.syncTranscript
    && !args.latestAssistant
    && !args.recoverQueue
    && !args.runQueue
    && !args.models
    && !args.stop
    && !args.downloadArtifacts
    && typeof args.message !== 'string'
    && (args.status || args.watchState);
}

function useColor() {
  return process.stderr.isTTY && !process.env.NO_COLOR;
}

function color(text, code) {
  if (!useColor()) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function info(text) {
  console.error(color(text, '36'));
}

function formatSavedArtifact(item) {
  if (item.path) return `${item.type}: ${item.path}`;
  if (item.reason) return `${item.type}: ${item.reason}`;
  return `${item.type || 'artifact'}: ${JSON.stringify(item)}`;
}

function readDisplayFile(filePath, maxChars = 50000) {
  const stat = fs.statSync(filePath);
  if (stat.size > maxChars * 4) {
    return `${fs.readFileSync(filePath, 'utf8').slice(0, maxChars)}\n[truncated: ${stat.size} bytes total]`;
  }
  return fs.readFileSync(filePath, 'utf8');
}

function printSavedArtifacts(saved) {
  const printable = saved.filter((item) => item.path && [
    'code',
    'code-truncated',
    'links',
  ].includes(item.type));

  if (!printable.length) {
    console.log('No text/code artifacts to display.');
    return;
  }

  for (const item of printable) {
    console.log(`\n--- ${item.type}: ${item.path} ---`);
    try {
      console.log(readDisplayFile(item.path));
    } catch (error) {
      console.log(`[could not read artifact: ${error.message || error}]`);
    }
  }
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function ensureTranscript(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `ChatBot CLI transcript\nStarted: ${new Date().toISOString()}\n\n`, 'utf8');
  }
}

function appendTranscript(filePath, role, text) {
  const label = role === 'user' ? 'USER' : 'ASSISTANT';
  const entry = `[${new Date().toISOString()}] ${label}\n${text.trim()}\n\n`;
  fs.appendFileSync(filePath, entry, 'utf8');
}

function parseTranscriptEntries(text) {
  const matches = [...String(text || '').matchAll(/^\[([^\]]+)\] (USER|ASSISTANT)\n/gm)];
  return matches.map((match, index) => {
    const contentStart = match.index + match[0].length;
    const contentEnd = index + 1 < matches.length ? matches[index + 1].index : text.length;
    return {
      at: match[1],
      role: match[2].toLowerCase(),
      text: text.slice(contentStart, contentEnd).replace(/\s+$/g, ''),
    };
  }).filter((entry) => entry.role && entry.text);
}

function transcriptEntryMatchesTurn(entry, turn) {
  if (!entry || !turn || entry.role !== turn.role) return false;
  if (entry.role === 'assistant' && isProgressOnlyText(entry.text)) return false;
  if (entry.role === 'assistant') return turnMatchesMessage(entry.text, turn.text);
  return turnMatchesMessage(turn.text, entry.text);
}

function findTranscriptSyncStart(entries, turns) {
  if (!entries.length) return 0;

  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex--) {
    const entry = entries[entryIndex];
    for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
      if (transcriptEntryMatchesTurn(entry, turns[turnIndex])) return turnIndex + 1;
    }
  }

  return -1;
}

function transcriptAlreadyHasTurn(entries, turn) {
  return entries.some((entry) => {
    if (entry.role !== turn.role) return false;
    if (turn.role === 'assistant') return turnMatchesMessage(entry.text, turn.text);
    return turnMatchesMessage(turn.text, entry.text);
  });
}

async function getCombinedGenerationState(page, state = null) {
  const generation = await getGenerationState(page);
  const controls = (state?.generationControls || [])
    .map((item) => item.text || item.testid || '')
    .filter(Boolean);
  return {
    isGenerating: Boolean(state?.isGenerating || controls.length || generation.isGenerating),
    control: generation.control || controls.join(' | '),
  };
}

async function syncTranscriptFromPage(page, args, options = {}) {
  refreshSessionTranscript(page, args);
  ensureTranscript(args.transcript);

  const generation = options.generation || await getCombinedGenerationState(page, options.state || null);
  let turns = (await getConversationTurns(page))
    .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
    .filter((turn) => turn.role !== 'assistant' || !isProgressOnlyText(turn.text));
  const skipped = [];
  if (generation.isGenerating && turns[turns.length - 1]?.role === 'assistant') {
    const [turn] = turns.splice(turns.length - 1, 1);
    skipped.push({
      role: turn.role,
      chars: turn.text.length,
      testid: turn.testid || '',
      reason: 'active_generation',
    });
  }
  const transcriptText = fs.readFileSync(args.transcript, 'utf8');
  const entries = parseTranscriptEntries(transcriptText);
  const startIndex = findTranscriptSyncStart(entries, turns);

  if (startIndex === -1) {
    throw new Error(`Could not match existing transcript tail to live target app turns: ${args.transcript}`);
  }

  const appended = [];
  for (const turn of turns.slice(startIndex)) {
    if (transcriptAlreadyHasTurn(entries, turn)) continue;
    appendTranscript(args.transcript, turn.role, turn.text);
    entries.push({ role: turn.role, text: turn.text, at: new Date().toISOString() });
    appended.push({
      role: turn.role,
      chars: turn.text.length,
      testid: turn.testid || '',
    });
  }

  return {
    transcript: args.transcript,
    sessionId: sessionIdFromUrl(page.url()),
    turnCount: turns.length,
    appended,
    skipped,
  };
}

async function latestAssistantText(page) {
  const turns = await getConversationTurns(page);
  const turn = [...turns].reverse()
    .find((item) => item.role === 'assistant' && item.text && !isProgressOnlyText(item.text));
  return turn?.text || '';
}

function messageHash(message) {
  return crypto.createHash('sha256').update(String(message || '')).digest('hex');
}

function sessionIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const cIndex = parts.indexOf('c');
    if (cIndex !== -1 && parts[cIndex + 1] && SESSION_ID_RE.test(parts[cIndex + 1])) {
      return parts[cIndex + 1];
    }
  } catch {}

  return '';
}

function transcriptPathForSession(sessionId) {
  const safeId = sessionId || 'new-chat';
  return path.join(OUTPUT_DIR, `${safeId}.txt`);
}

function refreshSessionTranscript(page, args) {
  if (args.transcriptOverride) return args.transcript;

  const sessionId = sessionIdFromUrl(page.url());
  const nextTranscript = transcriptPathForSession(sessionId);

  if (args.transcript !== nextTranscript) {
    args.transcript = nextTranscript;
    ensureTranscript(args.transcript);
  }

  return args.transcript;
}

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureSchedulerDir() {
  fs.mkdirSync(SCHEDULER_DIR, { recursive: true });
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function loadQueueState() {
  const state = readJsonFile(QUEUE_STATE_PATH, { version: 1, updatedAt: '', jobs: [] });
  if (!Array.isArray(state.jobs)) state.jobs = [];
  return state;
}

function saveQueueState(state) {
  state.version = 1;
  state.updatedAt = nowIso();
  atomicWriteJson(QUEUE_STATE_PATH, state);
}

function loadConversationIndex() {
  const index = readJsonFile(CONVERSATION_INDEX_PATH, { version: 1, updatedAt: '', conversations: [] });
  if (!Array.isArray(index.conversations)) index.conversations = [];
  return index;
}

function saveConversationIndex(index) {
  index.version = 1;
  index.updatedAt = nowIso();
  atomicWriteJson(CONVERSATION_INDEX_PATH, index);
}

function loadRoundState() {
  const state = readJsonFile(ROUND_STATE_PATH, { version: 1, updatedAt: '', rounds: [] });
  if (!Array.isArray(state.rounds)) state.rounds = [];
  return state;
}

function saveRoundState(state) {
  state.version = 1;
  state.updatedAt = nowIso();
  atomicWriteJson(ROUND_STATE_PATH, state);
}

function processExists(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireSchedulerLock() {
  ensureSchedulerDir();
  try {
    const fd = fs.openSync(SCHEDULER_LOCK_PATH, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }), 'utf8');
    return () => {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(SCHEDULER_LOCK_PATH); } catch {}
    };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let stale = false;
    try {
      const lock = JSON.parse(fs.readFileSync(SCHEDULER_LOCK_PATH, 'utf8'));
      stale = !processExists(Number(lock.pid));
    } catch {
      stale = true;
    }
    if (!stale) {
      throw new Error(`Scheduler state is locked by another CB process (${SCHEDULER_LOCK_PATH})`);
    }
    fs.unlinkSync(SCHEDULER_LOCK_PATH);
    return acquireSchedulerLock();
  }
}

function withSchedulerLock(fn) {
  const release = acquireSchedulerLock();
  try {
    return fn();
  } finally {
    release();
  }
}

function normalizeAlias(alias, label = 'alias') {
  const value = String(alias || '').trim();
  if (!value) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${label}: use 1-128 characters from letters, numbers, dot, underscore, colon, or dash`);
  }
  return value;
}

function isCurrentConversationRef(ref) {
  return /^(current|active|this)$/i.test(String(ref || '').trim());
}

function findConversationByAlias(index, alias) {
  if (!alias) return null;
  return index.conversations.find((item) => item.alias === alias) || null;
}

function findConversationBySessionId(index, sessionId) {
  if (!sessionId) return null;
  return index.conversations.find((item) => item.sessionId === sessionId) || null;
}

function sessionIdFromTranscriptPath(transcriptPath) {
  const id = path.basename(String(transcriptPath || ''), path.extname(String(transcriptPath || '')));
  return SESSION_ID_RE.test(id) ? id : '';
}

function upsertConversation(index, patch) {
  const now = nowIso();
  const alias = patch.alias || '';
  const sessionId = patch.sessionId || '';
  const aliasRecord = alias ? findConversationByAlias(index, alias) : null;
  const sessionRecords = sessionId ? index.conversations.filter((item) => item.sessionId === sessionId) : [];
  const sessionRecord = sessionRecords[0] || null;
  let record = aliasRecord || sessionRecord || null;

  if (!record) {
    record = {
      alias,
      sessionId,
      status: sessionId ? 'active' : 'pending',
      createdAt: now,
      updatedAt: now,
      url: '',
      title: '',
      transcript: '',
      cdp: '',
      firstJobId: '',
      lastJobId: '',
    };
    index.conversations.push(record);
  } else {
    const duplicates = index.conversations.filter((item) => item !== record && (
      (sessionId && item.sessionId === sessionId && (!item.alias || item.alias === alias))
      || (alias && item.alias === alias)
    ));
    for (const duplicate of duplicates) {
      for (const [key, value] of Object.entries(duplicate)) {
        if (value && (record[key] === '' || record[key] === null || record[key] === undefined)) {
          record[key] = value;
        }
      }
    }
    index.conversations = index.conversations.filter((item) => !duplicates.includes(item));
  }

  Object.assign(record, patch, {
    alias: alias || record.alias || '',
    sessionId: sessionId || record.sessionId || '',
    status: patch.status || (sessionId || record.sessionId ? 'active' : 'pending'),
    updatedAt: now,
  });
  return record;
}

async function indexCurrentConversation(page, args, event = 'conversation_observed', extra = {}) {
  const { suppressAlias = false, indexAlias, ...recordExtra } = extra;
  const sessionId = sessionIdFromUrl(page.url());
  if (!sessionId) return null;

  refreshSessionTranscript(page, args);
  const title = await page.title().catch(() => '');
  const turns = await getConversationTurns(page).catch(() => []);
  const latestAssistant = [...turns].reverse()
    .find((turn) => turn.role === 'assistant' && turn.text && !isProgressOnlyText(turn.text));

  return withSchedulerLock(() => {
    const index = loadConversationIndex();
    const record = upsertConversation(index, {
      alias: normalizeAlias(suppressAlias ? '' : ((indexAlias ?? args.alias) || ''), 'conversation alias'),
      sessionId,
      status: 'active',
      url: page.url(),
      title,
      transcript: args.transcript || transcriptPathForSession(sessionId),
      cdp: args.cdp,
      turnCount: turns.length,
      latestAssistantChars: latestAssistant?.text?.length || 0,
      lastObservedAt: nowIso(),
      ...recordExtra,
    });
    saveConversationIndex(index);
    appendJsonl(CONVERSATION_EVENTS_PATH, {
      type: event,
      at: record.updatedAt,
      conversation: record,
    });
    return record;
  });
}

function registerPendingRound(args, page, message, baselineLastTurnId) {
  const sessionId = sessionIdFromUrl(page.url());
  const transcript = args.transcript || (sessionId ? transcriptPathForSession(sessionId) : '');
  const id = randomId('round');
  const now = nowIso();
  const round = {
    id,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    pid: process.pid,
    sessionId,
    url: page.url(),
    transcript,
    cdp: args.cdp,
    baselineLastTurnId,
    messageHash: messageHash(message),
    messageChars: message.length,
    messageHead: normalizeTurnText(message).slice(0, 240),
    messageTail: normalizeTurnText(message).slice(-240),
    responseChars: 0,
    lastError: '',
  };

  withSchedulerLock(() => {
    const state = loadRoundState();
    state.rounds.push(round);
    saveRoundState(state);
    appendJsonl(ROUND_EVENTS_PATH, {
      type: 'round_pending',
      at: now,
      round,
    });
  });
  return round;
}

function updateRound(roundId, patch, eventType = 'round_updated') {
  if (!roundId) return null;
  return withSchedulerLock(() => {
    const state = loadRoundState();
    const round = state.rounds.find((item) => item.id === roundId);
    if (!round) return null;
    Object.assign(round, patch, { updatedAt: nowIso() });
    saveRoundState(state);
    appendJsonl(ROUND_EVENTS_PATH, {
      type: eventType,
      at: round.updatedAt,
      round,
    });
    return round;
  });
}

function transcriptUserEntryMatchesRound(entry, round) {
  if (!entry || entry.role !== 'user') return false;
  if (messageHash(entry.text) === round.messageHash) return true;
  const text = normalizeTurnText(entry.text);
  const head = normalizeTurnText(round.messageHead || '');
  const tail = normalizeTurnText(round.messageTail || '');
  if (head && tail && text.includes(head) && text.includes(tail)) return true;
  return head && head.length < 240 && text.includes(head);
}

function responseAfterRound(entries, round) {
  let userIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (transcriptUserEntryMatchesRound(entries[i], round)) {
      userIndex = i;
      break;
    }
  }
  if (userIndex === -1) return '';

  return entries.slice(userIndex + 1)
    .filter((entry) => entry.role === 'assistant' && entry.text && !isProgressOnlyText(entry.text))
    .reduce((best, entry) => (entry.text.length >= best.length ? entry.text : best), '');
}

function reconcilePendingRoundsFromTranscript(args, options = {}) {
  if (!args.transcript || !fs.existsSync(args.transcript)) return [];
  const sessionId = path.basename(args.transcript, path.extname(args.transcript));
  const skipSessionIds = new Set(options.skipSessionIds || []);
  const entries = parseTranscriptEntries(fs.readFileSync(args.transcript, 'utf8'));
  if (!entries.length) return [];

  return withSchedulerLock(() => {
    const state = loadRoundState();
    const completed = [];
    for (const round of state.rounds) {
      if (round.status !== 'pending') continue;
      const roundSessionId = round.sessionId || sessionId;
      if (skipSessionIds.has(roundSessionId)) continue;
      if (round.sessionId && round.sessionId !== sessionId) continue;
      const finalResponse = responseAfterRound(entries, round);
      if (!finalResponse) continue;
      Object.assign(round, {
        status: 'done',
        responseChars: finalResponse.length,
        transcript: args.transcript,
        completedAt: nowIso(),
        updatedAt: nowIso(),
        lastError: '',
      });
      completed.push(round);
      appendJsonl(ROUND_EVENTS_PATH, {
        type: 'round_recovered',
        at: round.updatedAt,
        round,
      });
    }
    if (completed.length) saveRoundState(state);
    return completed;
  });
}

async function reconcileCurrentConversation(page, args, options = {}) {
  refreshSessionTranscript(page, args);
  const state = await getTargetAppState(page).catch(() => null);
  const generation = await getCombinedGenerationState(page, state);
  const activeSessionId = sessionIdFromUrl(page.url());
  let sync = null;
  try {
    sync = await syncTranscriptFromPage(page, args, { state, generation });
  } catch (error) {
    if (options.verbose) info(`[sync] ${error.message || error}`);
  }
  const recoveredRounds = reconcilePendingRoundsFromTranscript(args, {
    skipSessionIds: generation.isGenerating && activeSessionId ? [activeSessionId] : [],
  });
  const conversation = await indexCurrentConversation(page, args, 'conversation_observed', {
    suppressAlias: Boolean(options.suppressAlias),
    recoveredRoundCount: recoveredRounds.length,
    syncedTurnCount: sync?.appended?.length || 0,
  }).catch((error) => {
    if (options.verbose) info(`[index] ${error.message || error}`);
    return null;
  });
  return { sync, recoveredRounds, conversation };
}

function parseConversationRef(ref, index) {
  const value = String(ref || '').trim();
  if (!value || isCurrentConversationRef(value)) {
    return { kind: 'current', ref: value || 'current', alias: '', sessionId: '' };
  }
  if (SESSION_ID_RE.test(value)) {
    return { kind: 'session', ref: value, alias: '', sessionId: value };
  }
  const alias = normalizeAlias(value, 'conversation alias');
  const record = findConversationByAlias(index, alias);
  return {
    kind: 'alias',
    ref: alias,
    alias,
    sessionId: record?.sessionId || '',
  };
}

function scheduleNeedsCurrentPage(args) {
  if (!args.schedule) return false;
  if (args.newConversation) return false;
  if (!args.conversation) return true;
  return isCurrentConversationRef(args.conversation);
}

function targetDescription(target) {
  if (target.newConversation) return `new conversation alias=${target.alias}`;
  if (target.sessionId && target.alias) return `${target.alias} (${target.sessionId})`;
  if (target.sessionId) return target.sessionId;
  if (target.alias) return `${target.alias} (pending)`;
  return 'current';
}

function isDoneScheduledJob(job) {
  return job?.status === 'done' || job?.status === 'skipped';
}

function enqueueScheduledJob(args, page = null) {
  const message = String(args.message || '').trim();
  if (!message) throw new Error('No message provided');
  const jobId = randomId('job');

  return withSchedulerLock(() => {
    const queue = loadQueueState();
    const index = loadConversationIndex();
    let target = null;
    let conversationRecord = null;

    if (args.newConversation) {
      const ref = args.conversation && !SESSION_ID_RE.test(args.conversation) && !isCurrentConversationRef(args.conversation)
        ? args.conversation
        : '';
      const alias = normalizeAlias(args.alias || ref || `new-${jobId}`, 'conversation alias');
      target = {
        newConversation: true,
        alias,
        sessionId: '',
      };
      conversationRecord = upsertConversation(index, {
        alias,
        sessionId: '',
        status: 'pending',
        cdp: args.cdp,
        firstJobId: findConversationByAlias(index, alias)?.firstJobId || jobId,
        lastJobId: jobId,
      });
    } else {
      const parsed = parseConversationRef(args.conversation || 'current', index);
      let sessionId = parsed.sessionId;
      if (parsed.kind === 'current') {
        if (!page) throw new Error('Scheduling for the current conversation requires a live target app page');
        sessionId = sessionIdFromUrl(page.url());
        if (!sessionId) {
          throw new Error('The active target app tab has no conversation id yet. Use --new-conversation --alias <name> to schedule a future conversation.');
        }
      }

      const alias = normalizeAlias(args.alias || parsed.alias || '', 'conversation alias');
      target = {
        newConversation: false,
        alias,
        sessionId,
      };
      if (sessionId || alias) {
        conversationRecord = upsertConversation(index, {
          alias,
          sessionId,
          status: sessionId ? 'active' : 'pending',
          url: sessionId ? `https://configured-target.invalid/c/${sessionId}` : '',
          transcript: sessionId ? transcriptPathForSession(sessionId) : '',
          cdp: args.cdp,
          firstJobId: findConversationByAlias(index, alias)?.firstJobId || findConversationBySessionId(index, sessionId)?.firstJobId || jobId,
          lastJobId: jobId,
        });
      }
    }

    const seq = queue.jobs.reduce((max, job) => Math.max(max, Number(job.seq) || 0), 0) + 1;
    const now = nowIso();
    const job = {
      id: jobId,
      seq,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      target,
      message,
      attachments: args.attachments || [],
      model: args.model || '',
      reasoning: args.reasoning || '',
      cdp: args.cdp,
      options: {
        timeout: args.timeout,
        timeoutExplicit: Boolean(args.timeoutExplicit),
        downloadArtifacts: Boolean(args.downloadArtifacts),
        showArtifacts: Boolean(args.showArtifacts),
        stream: Boolean(args.stream),
      },
      attempts: 0,
      lastError: '',
      result: null,
    };

    queue.jobs.push(job);
    saveQueueState(queue);
    appendJsonl(QUEUE_EVENTS_PATH, {
      type: 'job_enqueued',
      at: now,
      job,
    });
    if (conversationRecord) {
      saveConversationIndex(index);
      appendJsonl(CONVERSATION_EVENTS_PATH, {
        type: 'conversation_scheduled',
        at: now,
        conversation: conversationRecord,
        jobId,
      });
    }
    return job;
  });
}

function printScheduledJob(job, jsonl = false) {
  if (jsonl) {
    console.log(JSON.stringify({ type: 'scheduled_job', job }));
    return;
  }
  console.log(`Scheduled ${job.id} #${job.seq} -> ${targetDescription(job.target)}`);
}

function queueSnapshot() {
  return {
    queue: loadQueueState(),
    conversations: loadConversationIndex(),
    rounds: loadRoundState(),
  };
}

function printQueueStatus(args) {
  const snapshot = queueSnapshot();
  if (args.stateJsonl) {
    console.log(JSON.stringify({
      type: 'scheduler_status',
      at: nowIso(),
      queue: snapshot.queue,
      conversations: snapshot.conversations,
      rounds: snapshot.rounds,
    }));
    return;
  }

  const jobs = snapshot.queue.jobs.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const counts = jobs.reduce((acc, job) => {
    acc[job.status] = (acc[job.status] || 0) + 1;
    return acc;
  }, {});
  console.log(`Scheduler: ${jobs.length} job(s) pending=${counts.pending || 0} running=${counts.running || 0} waiting=${counts.waiting || 0} needs_recovery=${counts.needs_recovery || 0} done=${counts.done || 0} failed=${counts.failed || 0}`);
  const recentJobs = jobs.slice(-20);
  const firstOpen = jobs.find((job) => !isDoneScheduledJob(job));
  const visibleJobs = firstOpen && !recentJobs.some((job) => job.id === firstOpen.id)
    ? [firstOpen, ...recentJobs]
    : recentJobs;
  for (const job of visibleJobs) {
    const suffix = job.lastError ? ` error=${job.lastError}` : '';
    console.log(`#${job.seq} ${job.id} ${job.status} target=${targetDescription(job.target)} chars=${(job.message || '').length}${suffix}`);
  }

  const conversations = snapshot.conversations.conversations.slice()
    .sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
  console.log(`Conversations: ${conversations.length}`);
  for (const item of conversations.slice(-20)) {
    console.log(`${item.alias || '(no alias)'} status=${item.status} session=${item.sessionId || '(pending)'} transcript=${item.transcript || ''}`);
  }

  const rounds = snapshot.rounds.rounds.slice()
    .sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
  const roundCounts = rounds.reduce((acc, round) => {
    acc[round.status] = (acc[round.status] || 0) + 1;
    return acc;
  }, {});
  console.log(`Rounds: ${rounds.length} pending=${roundCounts.pending || 0} done=${roundCounts.done || 0} failed=${roundCounts.failed || 0}`);
  for (const round of rounds.slice(-20)) {
    const suffix = round.lastError ? ` error=${round.lastError}` : '';
    console.log(`${round.id} ${round.status} session=${round.sessionId || '(pending)'} chars=${round.messageChars || 0} response=${round.responseChars || 0}${suffix}`);
  }
}

async function findTargetAppPage(browser, args = {}) {
  const context = browser.contexts()[0] || await browser.newContext();
  if (args.newTab) {
    const page = await context.newPage();
    await page.goto('https://configured-target.invalid/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    return page;
  }

  for (const candidateContext of browser.contexts()) {
    const page = candidateContext.pages().find((candidate) => candidate.url().startsWith('https://configured-target.invalid/'));
    if (page) return page;
  }

  const page = await context.newPage();
  await page.goto('https://configured-target.invalid/', { waitUntil: 'domcontentloaded' });
  return page;
}

async function getConversationTurns(page) {
  const turns = await page.evaluate(() => {
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('[data-testid^="conversation-turn-"]')]
      .map((turn, index) => {
        const roleEls = turn.matches('[data-message-author-role]')
          ? [turn]
          : [...turn.querySelectorAll('[data-message-author-role]')];
        const role = roleEls[0]?.getAttribute('data-message-author-role')
          || turn.getAttribute('data-turn')
          || '';
        const roleTexts = roleEls.map(textOf).filter(Boolean);
        return {
          index,
          testid: turn.getAttribute('data-testid') || '',
          role,
          text: roleTexts[0] || textOf(turn),
          roleTexts,
          turnText: textOf(turn),
        };
      })
      .filter((turn) => turn.role && (turn.text || turn.turnText));
  });
  return turns
    .map((turn) => ({
      index: turn.index,
      testid: turn.testid,
      role: turn.role,
      text: turn.role === 'assistant'
        ? assistantResponseText(turn.roleTexts?.length ? turn.roleTexts : turn.text, turn.turnText)
        : turn.text,
    }))
    .filter((turn) => turn.role && turn.text);
}

async function getAssistantTurns(page) {
  return (await getConversationTurns(page)).filter((turn) => turn.role === 'assistant');
}

async function findComposer(page) {
  const selectors = [
    '#prompt-textarea',
    '[data-testid="composer-input"]',
    'textarea[placeholder]',
    'div[contenteditable="true"]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).last();
    try {
      await locator.waitFor({ state: 'visible', timeout: 3000 });
      return locator;
    } catch {}
  }

  throw new Error('No visible target app composer input found');
}

async function getSendButtonState(page) {
  return page.evaluate(() => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const button = [...document.querySelectorAll([
      '#composer-submit-button',
      '[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
    ].join(','))]
      .find(isVisible);

    if (!button) return { exists: false, disabled: false, label: '' };
    return {
      exists: true,
      disabled: Boolean(button.disabled || button.getAttribute('aria-disabled') === 'true'),
      label: [
        button.getAttribute('data-testid') || '',
        button.getAttribute('aria-label') || '',
        button.getAttribute('title') || '',
        button.innerText || '',
      ].join(' ').replace(/\s+/g, ' ').trim(),
    };
  }).catch(() => ({ exists: false, disabled: false, label: '' }));
}

async function waitForSendReady(page, timeout = SEND_READY_TIMEOUT_MS) {
  const start = Date.now();
  let lastState = null;
  let lastButton = null;

  while (Date.now() - start < timeout) {
    lastButton = await getSendButtonState(page);
    lastState = await getTargetAppState(page).catch(() => null);
    if (lastState?.blockingModal) {
      throw new Error(blockingModalErrorMessage(lastState.blockingModal, 'while waiting for the send button'));
    }
    if (!lastButton.exists || !lastButton.disabled) {
      return { button: lastButton, state: lastState };
    }
    await page.waitForTimeout(1000);
  }

  const attachmentSummary = lastState?.composer?.attachments?.length
    ? ` Attachments: ${lastState.composer.attachments.map((item) => item.text || item.aria || item.testid).join(' | ')}.`
    : '';
  const longTextSummary = lastState?.composer?.textChars >= 10000
    ? ` Composer contains long text (${lastState.composer.textChars} chars).`
    : '';
  const label = lastButton?.label ? ` Last send control: ${lastButton.label}.` : '';
  throw new Error(`Prompt was not submitted because the send button stayed disabled after ${timeout}ms. Files may still be uploading or unsupported by this browser profile.${label}${attachmentSummary}${longTextSummary}`);
}

async function getComposerDraftState(page) {
  return page.evaluate(() => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || el?.value || '').replace(/\s+/g, ' ').trim();
    const candidates = [...document.querySelectorAll('#prompt-textarea, [data-testid="composer-input"], textarea[placeholder], div[contenteditable="true"]')];
    const visibleCandidates = candidates.filter(isVisible);
    const composer = visibleCandidates[visibleCandidates.length - 1] || candidates[candidates.length - 1] || null;
    const composerRoot = composer?.closest('form')
      || composer?.closest('[data-testid*="composer"]')
      || composer?.parentElement?.parentElement
      || null;
    const text = textOf(composer);
    const attachments = composerRoot
      ? [...composerRoot.querySelectorAll('[data-testid], [aria-label], button, [role="button"]')]
        .filter(isVisible)
        .map((el) => ({
          testid: el.getAttribute('data-testid') || '',
          aria: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '',
          text: textOf(el),
        }))
        .filter((item) => {
          const joined = [item.testid, item.aria, item.title, item.text].join(' ');
          if (/\b(add files|start dictation|dictation|start voice|use voice|voice mode|chat with targetapp|microphone|mic)\b/i.test(joined)) return false;
          return /\b(pasted text|pasted|attachment|file|upload|remove|pdf|docx?|image|csv|txt|\.txt|\.pdf|\.csv|\.png|\.jpe?g|\.webp)\b/i.test(joined);
        })
        .slice(0, 20)
      : [];

    return {
      exists: Boolean(composer),
      visible: isVisible(composer),
      text,
      textChars: text.length,
      textPreview: text.slice(0, 240),
      textTail: text.slice(-240),
      attachments,
    };
  }).catch(() => ({
    exists: false,
    visible: false,
    text: '',
    textChars: 0,
    textPreview: '',
    textTail: '',
    attachments: [],
  }));
}

function composerDraftMatchesMessage(state, message) {
  if (turnMatchesMessage(state?.text || '', message)) {
    return { ok: true, kind: 'composer_text' };
  }

  const normalizedMessage = normalizeTurnText(message);
  const attachmentText = (state?.attachments || [])
    .map((item) => [item.testid, item.aria, item.title, item.text].filter(Boolean).join(' '))
    .join(' ');
  if (normalizedMessage.length >= 4000 && /\bpasted(?:\s+text)?\b/i.test(attachmentText)) {
    return { ok: true, kind: 'pasted_text_attachment' };
  }

  return { ok: false, kind: '' };
}

function composerDraftSummary(state) {
  if (!state) return 'composer state unavailable';
  const attachments = (state.attachments || [])
    .map((item) => item.text || item.aria || item.title || item.testid)
    .filter(Boolean)
    .join(' | ');
  return [
    `${state.textChars || 0} chars`,
    state.textPreview ? `preview="${state.textPreview}"` : '',
    state.textTail && state.textTail !== state.textPreview ? `tail="${state.textTail}"` : '',
    attachments ? `attachments="${attachments}"` : '',
  ].filter(Boolean).join(', ');
}

async function waitForComposerInsertion(page, message, timeout = COMPOSER_INSERT_TIMEOUT_MS) {
  const start = Date.now();
  let lastState = null;
  let lastMatch = { ok: false, kind: '' };

  while (Date.now() - start < timeout) {
    await assertNoBlockingModal(page, 'while verifying inserted prompt text');
    lastState = await getComposerDraftState(page);
    lastMatch = composerDraftMatchesMessage(lastState, message);
    if (lastMatch.ok) return { state: lastState, match: lastMatch };
    await page.waitForTimeout(250);
  }

  throw new Error(`Prompt text insertion could not be verified after ${timeout}ms. Composer: ${composerDraftSummary(lastState)}. No prompt was submitted.`);
}

function findUserTurnAfterBaseline(turns, message, baselineLastTurnId) {
  const baselineIndex = baselineLastTurnId
    ? turns.findIndex((turn) => turn.testid === baselineLastTurnId)
    : -1;
  return turns.find((turn, index) => index > baselineIndex
    && turn.role === 'user'
    && turnMatchesMessage(turn.text, message)) || null;
}

async function waitForPromptAccepted(page, message, baselineLastTurnId, timeout = PROMPT_ACCEPTED_TIMEOUT_MS) {
  const start = Date.now();
  let lastTurns = [];
  let lastComposer = null;

  while (Date.now() - start < timeout) {
    await assertNoBlockingModal(page, 'while verifying the prompt was accepted');
    lastTurns = await getConversationTurns(page).catch(() => []);
    const userTurn = findUserTurnAfterBaseline(lastTurns, message, baselineLastTurnId);
    if (userTurn) return userTurn;
    lastComposer = await getComposerDraftState(page);
    await page.waitForTimeout(500);
  }

  const latest = lastTurns.length ? lastTurns[lastTurns.length - 1] : null;
  const latestSummary = latest ? `${latest.role || 'unknown'}:${latest.testid || latest.index}:${(latest.text || '').slice(0, 240)}` : 'none';
  throw new Error(`Prompt was not accepted by target app after ${timeout}ms: no matching user turn appeared after the baseline. Composer: ${composerDraftSummary(lastComposer)}. Latest turn: ${latestSummary}.`);
}

async function sendMessage(page, message, baselineLastTurnId = '') {
  await assertNoBlockingModal(page, 'before finding the composer');
  const composer = await findComposer(page);
  try {
    await assertNoBlockingModal(page, 'before focusing the composer');
    await composer.click({ timeout: 10000 });
  } catch (error) {
    const modal = await getBlockingModal(page);
    if (modal) throw new Error(blockingModalErrorMessage(modal, 'while focusing the composer'));
    throw error;
  }
  await page.keyboard.insertText(message);
  await waitForComposerInsertion(page, message);

  const ready = await waitForSendReady(page);

  if (!ready.button.exists) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    return waitForPromptAccepted(page, message, baselineLastTurnId);
  }

  try {
    await assertNoBlockingModal(page, 'before clicking the send button');
    await page.locator('#composer-submit-button, [data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]')
      .first()
      .click({ timeout: 5000 });
  } catch (error) {
    const modal = await getBlockingModal(page);
    if (modal) throw new Error(blockingModalErrorMessage(modal, 'while clicking the send button'));
    throw error;
  }
  await page.waitForTimeout(700);
  return waitForPromptAccepted(page, message, baselineLastTurnId);
}

function responseAfterMessage(turns, message, baselineLastTurnId) {
  let userIndex = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role === 'user' && turnMatchesMessage(turn.text, message)) {
      userIndex = i;
      break;
    }
  }

  if (userIndex === -1 && baselineLastTurnId) {
    const baselineIndex = turns.findIndex((turn) => turn.testid === baselineLastTurnId);
    if (baselineIndex !== -1) userIndex = baselineIndex;
  }

  if (userIndex === -1) return '';

  const assistant = turns.slice(userIndex + 1)
    .find((turn) => turn.role === 'assistant' && turn.text && !isProgressOnlyText(turn.text));
  return assistant ? assistant.text : '';
}

function hasUserTurnAfterBaseline(turns, message, baselineLastTurnId) {
  return Boolean(findUserTurnAfterBaseline(turns, message, baselineLastTurnId));
}

function normalizeTurnText(text) {
  return (text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function isProgressOnlyText(text) {
  const normalized = normalizeTurnText(text).replace(/[.。…]+$/g, '').trim();
  if (!normalized) return true;
  if (normalized.length > 180) return false;

  return /^(targetapp|(?:pro\s+)?thinking|finalizing answer|looking for available tools|called tool)$/i.test(normalized)
    || /^thought for (?:a couple of seconds|\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes))(?:\s*[›>])?(?:\s+edit)?$/i.test(normalized)
    || /^(searching|searched|reading|analyzing|working|creating|generating|running|uploading|processing|finalizing)(?:\s+(?:answer|response|file|image|results?|the web|online|tool|tools?))?$/i.test(normalized)
    || /^using (?:a |the )?.{1,80}\btool$/i.test(normalized);
}

function blockingModalKindFromMeta(meta) {
  const joined = [
    meta?.id || '',
    meta?.testid || '',
    meta?.role || '',
    meta?.text || '',
  ].join(' ');
  if (/conversation-history-rate-limit|conversation\s+history.*rate\s+limit|rate\s+limit|too many requests|limit reached/i.test(joined)) {
    return 'conversation_history_rate_limit';
  }
  if (/modal-subscription-failure|subscription|upgrade|plan limit/i.test(joined)) {
    return 'subscription_modal';
  }
  return 'blocking_modal';
}

function blockingModalSummary(modal) {
  if (!modal) return '';
  const text = normalizeTurnText(modal.text || '').slice(0, 500);
  const name = modal.kind || blockingModalKindFromMeta(modal);
  const id = modal.id ? `#${modal.id}` : '';
  const testid = modal.testid ? `data-testid="${modal.testid}"` : '';
  const labels = [id, testid].filter(Boolean).join(' ');
  return [name, labels, text ? `text="${text}"` : ''].filter(Boolean).join(' ');
}

function blockingModalErrorMessage(modal, context = 'before sending') {
  const summary = blockingModalSummary(modal) || 'blocking modal';
  return `target app UI blocker detected ${context}: ${summary}. No prompt was submitted; wait for the modal to clear, then recover or resume the queue.`;
}

async function getBlockingModal(page) {
  return page.evaluate((selectors) => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const kindOf = (meta) => {
      const joined = [meta.id || '', meta.testid || '', meta.role || '', meta.text || ''].join(' ');
      if (/conversation-history-rate-limit|conversation\s+history.*rate\s+limit|rate\s+limit|too many requests|limit reached/i.test(joined)) {
        return 'conversation_history_rate_limit';
      }
      if (/modal-subscription-failure|subscription|upgrade|plan limit/i.test(joined)) {
        return 'subscription_modal';
      }
      return 'blocking_modal';
    };

    for (const selector of selectors) {
      for (const candidate of document.querySelectorAll(selector)) {
        const modal = candidate.closest('[role="dialog"],[aria-modal="true"],[id^="modal-"],[data-testid^="modal-"]') || candidate;
        if (!isVisible(modal)) continue;
        const result = {
          id: modal.id || candidate.id || '',
          testid: modal.getAttribute('data-testid') || candidate.getAttribute('data-testid') || '',
          role: modal.getAttribute('role') || '',
          ariaModal: modal.getAttribute('aria-modal') || '',
          text: textOf(modal),
        };
        return { ...result, kind: kindOf(result) };
      }
    }

    return null;
  }, BLOCKING_MODAL_SELECTORS).catch(() => null);
}

async function assertNoBlockingModal(page, context) {
  const modal = await getBlockingModal(page);
  if (modal) throw new Error(blockingModalErrorMessage(modal, context));
  return null;
}

function stripLeadingProgressPrefix(text) {
  const normalized = normalizeTurnText(text);
  const thought = normalized.match(/^thought for (?:a couple of seconds|\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes))(?:\s*[›>])?(?:\s+edit)?\s+(.+)$/i);
  if (thought && !isProgressOnlyText(thought[1])) return thought[1].trim();
  return normalized;
}

function substantiveAssistantTexts(roleTexts) {
  const texts = (Array.isArray(roleTexts) ? roleTexts : [roleTexts])
    .map(normalizeTurnText)
    .filter((text) => text && !isProgressOnlyText(text));
  const deduped = [];
  for (const text of texts) {
    const existingIndex = deduped.findIndex((existing) => existing === text
      || existing.includes(text)
      || text.includes(existing));
    if (existingIndex === -1) {
      deduped.push(text);
    } else if (text.length > deduped[existingIndex].length) {
      deduped[existingIndex] = text;
    }
  }
  return deduped;
}

function assistantResponseText(roleTexts, turnText) {
  const substantive = substantiveAssistantTexts(roleTexts);
  if (substantive.length) return substantive.join('\n\n');
  return stripLeadingProgressPrefix(turnText);
}

function turnMatchesMessage(turnText, message) {
  const normalizedTurn = normalizeTurnText(turnText);
  const normalizedMessage = normalizeTurnText(message);
  if (!normalizedTurn || !normalizedMessage) return false;
  if (normalizedTurn === normalizedMessage || normalizedTurn.includes(normalizedMessage)) return true;
  if (normalizedMessage.length < 1000) return false;

  const head = normalizedMessage.slice(0, 200);
  const tail = normalizedMessage.slice(-200);
  return normalizedTurn.includes(head) && normalizedTurn.includes(tail);
}

async function getGenerationState(page) {
  return page.evaluate(() => {
    const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const buttons = [...document.querySelectorAll('button')].filter(isVisible);
    const generatingButton = buttons.find((button) => {
      const text = [
        button.getAttribute('data-testid') || '',
        button.getAttribute('aria-label') || '',
        button.getAttribute('title') || '',
        button.innerText || '',
      ].join(' ').toLowerCase();

      return /\b(stop|interrupt|cancel)\b/.test(text)
        && !/\b(share|copy|close|cancel dictation|start dictation|start voice|use voice|voice mode|chat with targetapp|microphone|mic)\b/.test(text);
    });

    return {
      isGenerating: Boolean(generatingButton),
      control: generatingButton
        ? (generatingButton.getAttribute('data-testid')
          || generatingButton.getAttribute('aria-label')
          || generatingButton.getAttribute('title')
          || generatingButton.innerText
          || 'generation-control')
        : '',
    };
  }).catch(() => ({ isGenerating: false, control: '' }));
}

async function getTargetAppState(page) {
  return page.evaluate((blockingModalSelectors) => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || el?.value || '').replace(/\s+/g, ' ').trim();
    const blockingModalKindOf = (meta) => {
      const joined = [meta.id || '', meta.testid || '', meta.role || '', meta.text || ''].join(' ');
      if (/conversation-history-rate-limit|conversation\s+history.*rate\s+limit|rate\s+limit|too many requests|limit reached/i.test(joined)) {
        return 'conversation_history_rate_limit';
      }
      if (/modal-subscription-failure|subscription|upgrade|plan limit/i.test(joined)) {
        return 'subscription_modal';
      }
      return 'blocking_modal';
    };
    const blockingModal = (() => {
      for (const selector of blockingModalSelectors) {
        for (const candidate of document.querySelectorAll(selector)) {
          const modal = candidate.closest('[role="dialog"],[aria-modal="true"],[id^="modal-"],[data-testid^="modal-"]') || candidate;
          if (!isVisible(modal)) continue;
          const result = {
            id: modal.id || candidate.id || '',
            testid: modal.getAttribute('data-testid') || candidate.getAttribute('data-testid') || '',
            role: modal.getAttribute('role') || '',
            ariaModal: modal.getAttribute('aria-modal') || '',
            text: textOf(modal),
          };
          return { ...result, kind: blockingModalKindOf(result) };
        }
      }
      return null;
    })();
    const isProgressOnly = (text) => {
      const normalized = (text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.。…]+$/g, '').trim();
      if (!normalized) return true;
      if (normalized.length > 180) return false;
      return /^(targetapp|(?:pro\s+)?thinking|finalizing answer|looking for available tools|called tool)$/i.test(normalized)
        || /^thought for (?:a couple of seconds|\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes))(?:\s*[›>])?(?:\s+edit)?$/i.test(normalized)
        || /^(searching|searched|reading|analyzing|working|creating|generating|running|uploading|processing|finalizing)(?:\s+(?:answer|response|file|image|results?|the web|online|tool|tools?))?$/i.test(normalized)
        || /^using (?:a |the )?.{1,80}\btool$/i.test(normalized);
    };
    const stripProgressPrefix = (text) => {
      const normalized = (text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const thought = normalized.match(/^thought for (?:a couple of seconds|\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes))(?:\s*[›>])?(?:\s+edit)?\s+(.+)$/i);
      if (thought && !isProgressOnly(thought[1])) return thought[1].trim();
      return normalized;
    };
    const assistantTextOf = (roleTexts, turnText) => {
      const deduped = [];
      for (const text of roleTexts.map((item) => (item || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean)) {
        if (isProgressOnly(text)) continue;
        const existingIndex = deduped.findIndex((existing) => existing === text
          || existing.includes(text)
          || text.includes(existing));
        if (existingIndex === -1) {
          deduped.push(text);
        } else if (text.length > deduped[existingIndex].length) {
          deduped[existingIndex] = text;
        }
      }
      return deduped.length ? deduped.join('\n\n') : stripProgressPrefix(turnText);
    };
    const roleElsOf = (turn) => (turn.matches('[data-message-author-role]')
      ? [turn]
      : [...turn.querySelectorAll('[data-message-author-role]')]);
    const controlText = (el) => [
      el.getAttribute('data-testid') || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      textOf(el),
    ].join(' ').replace(/\s+/g, ' ').trim();

    const controls = [...document.querySelectorAll('button,[role="button"],a')]
      .filter(isVisible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        testid: el.getAttribute('data-testid') || '',
        aria: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        text: textOf(el),
        href: el.href || '',
      }))
      .filter((item) => item.testid || item.aria || item.title || item.text || item.href);

    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(isVisible);
    const generationControls = buttons
      .map((button) => ({ text: controlText(button), testid: button.getAttribute('data-testid') || '' }))
      .filter((item) => /\b(stop|interrupt|cancel)\b/i.test(item.text)
        && !/\b(share|copy|close|cancel dictation|start dictation|start voice|use voice|voice mode|chat with targetapp|microphone|mic)\b/i.test(item.text));

    const voiceControls = controls
      .filter((item) => /\b(start dictation|dictation|start voice|use voice|voice mode|chat with targetapp|microphone|mic)\b/i.test([
        item.testid,
        item.aria,
        item.title,
        item.text,
      ].join(' ')))
      .slice(0, 20);

    const turns = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')]
      .map((turn, index) => {
        const roleEls = roleElsOf(turn);
        const role = roleEls[0]?.getAttribute('data-message-author-role')
          || turn.getAttribute('data-turn')
          || '';
        const roleTexts = roleEls.map(textOf).filter(Boolean);
        const turnText = textOf(turn);
        const text = role === 'assistant'
          ? assistantTextOf(roleTexts, turnText)
          : (roleTexts[0] || turnText);
        return {
          index,
          testid: turn.getAttribute('data-testid') || '',
          role,
          text,
          roleNodeCount: roleTexts.length,
        };
      })
      .filter((turn) => turn.role || turn.text);

    const latestAssistantTurn = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')]
      .reverse()
      .find((turn) => {
        const roleEls = roleElsOf(turn);
        const role = roleEls[0]?.getAttribute('data-message-author-role')
          || turn.getAttribute('data-turn')
          || '';
        return role === 'assistant';
      });

    const scoped = latestAssistantTurn;
    const latestAssistantRoleTexts = latestAssistantTurn ? roleElsOf(latestAssistantTurn).map(textOf).filter(Boolean) : [];
    const latestAssistantText = latestAssistantTurn ? assistantTextOf(latestAssistantRoleTexts, textOf(latestAssistantTurn)) : '';
    const seenImageSrcs = new Set();
    const links = scoped
      ? [...scoped.querySelectorAll('a[href]')]
        .filter(isVisible)
        .map((a) => ({ text: textOf(a), href: a.href, download: a.getAttribute('download') || '' }))
        .filter((link) => link.href)
        .slice(0, 50)
      : [];
    const images = scoped
      ? [...scoped.querySelectorAll('img[src]')]
        .filter(isVisible)
        .map((img) => ({
          alt: img.getAttribute('alt') || '',
          src: img.currentSrc || img.src,
          width: img.naturalWidth || img.width || 0,
          height: img.naturalHeight || img.height || 0,
        }))
        .filter((img) => img.src)
        .filter((img) => {
          if (seenImageSrcs.has(img.src)) return false;
          seenImageSrcs.add(img.src);
          return true;
        })
        .slice(0, 50)
      : [];
    const downloadControls = scoped
      ? [...scoped.querySelectorAll('button,[role="button"],a')]
        .filter(isVisible)
        .map((el) => controlText(el))
        .filter((text) => /\b(download|save|export)\b/i.test(text))
        .slice(0, 20)
      : [];
    const codeTexts = scoped
      ? [...scoped.querySelectorAll('pre')]
        .filter(isVisible)
        .map((el) => textOf(el.querySelector('code') || el))
        .filter(Boolean)
      : [];
    const dedupedCodeTexts = [];
    for (const text of codeTexts) {
      const existingIndex = dedupedCodeTexts.findIndex((existing) => existing === text
        || existing.endsWith(text)
        || text.endsWith(existing));
      if (existingIndex === -1) {
        dedupedCodeTexts.push(text);
      } else if (text.length < dedupedCodeTexts[existingIndex].length) {
        dedupedCodeTexts[existingIndex] = text;
      }
    }
    const codeBlocks = scoped
      ? dedupedCodeTexts.map((text) => ({
        chars: text.length,
        preview: text.slice(0, 160),
        text: text.slice(0, 200000),
        truncated: text.length > 200000,
      })).slice(0, 20)
      : [];

    const composerCandidates = [...document.querySelectorAll('#prompt-textarea, [data-testid="composer-input"], textarea[placeholder], div[contenteditable="true"]')];
    const composer = composerCandidates.find(isVisible) || composerCandidates[0] || null;
    const composerRoot = composer?.closest('form')
      || composer?.closest('[data-testid*="composer"]')
      || composer?.parentElement?.parentElement
      || null;
    const composerText = textOf(composer);
    const composerAttachments = composerRoot
      ? [...composerRoot.querySelectorAll('[data-testid], [aria-label], button, [role="button"]')]
        .filter(isVisible)
        .map((el) => ({
          testid: el.getAttribute('data-testid') || '',
          aria: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '',
          text: textOf(el),
        }))
        .filter((item) => {
          const meta = [item.testid, item.aria, item.title].join(' ');
          const body = item.text;
          const joined = [meta, body].join(' ');
          if (/\b(add files|start dictation|dictation|start voice|use voice|voice mode|chat with targetapp|microphone|mic)\b/i.test(joined)) return false;
          if (/\b(file|attachment|upload|remove|pasted text|pasted|pdf|doc|image|csv|txt)\b/i.test(meta)) return true;
          return body.length <= 240
            && /\b(pasted text|attachment|file|pdf|docx?|image|csv|\.txt|\.pdf|\.csv|\.png|\.jpe?g|\.webp)\b/i.test(body);
        })
        .slice(0, 20)
      : [];

    const activityTexts = [...document.querySelectorAll('main *, [data-testid^="conversation-turn-"] *')]
      .filter(isVisible)
      .map(textOf)
      .filter((text) => text && text.length <= 180)
      .filter((text) => /\b(thinking|thought|reasoning|searching|searched|browsing|reading|analyzing|working|creating|generating|running|tool|uploading|processing|finalizing|attached)\b/i.test(text))
      .filter((text, index, arr) => arr.indexOf(text) === index)
      .slice(-20);

    const modelButton = controls.find((item) => item.testid === 'model-switcher-dropdown-button'
      || /model selector/i.test(item.aria)
      || (item.tag === 'button'
        && item.text.length <= 80
        && /\b(gpt|latest|instant|thinking|extended|pro)\b/i.test(item.text)
        && !/\b(targetapp pro|search|project|history|pin|temporary|profile|account)\b/i.test([item.aria, item.title, item.text].join(' '))));
    const reasoningControls = controls
      .filter((item) => /\b(reasoning|think|thinking|extended|fast|auto)\b/i.test([item.testid, item.aria, item.title, item.text].join(' ')))
      .slice(0, 20);

    return {
      url: location.href,
      title: document.title,
      model: modelButton ? (modelButton.text || modelButton.aria || modelButton.testid) : '',
      blockingModal,
      reasoningControls,
      isGenerating: generationControls.length > 0,
      generationControls,
      voiceControls,
      composer: {
        visible: isVisible(composer),
        textChars: composerText.length,
        textPreview: composerText.slice(0, 160),
        attachments: composerAttachments,
        fileInputCount: document.querySelectorAll('input[type="file"]').length,
      },
      activityTexts,
      turnCount: turns.length,
      lastTurns: turns.slice(-6).map((turn) => ({
        index: turn.index,
        testid: turn.testid,
        role: turn.role,
        roleNodeCount: turn.roleNodeCount || 0,
        chars: turn.text.length,
        preview: turn.text.slice(0, 240),
      })),
      latestAssistant: {
        chars: latestAssistantText.length,
        preview: latestAssistantText.slice(0, 400),
      },
      artifacts: {
        links,
        images,
        downloadControls,
        codeBlocks,
      },
    };
  }, BLOCKING_MODAL_SELECTORS);
}

function compactModelConfig(config) {
  if (!config) return null;
  if (config.error) return { error: config.error };
  return {
    button: config.button || '',
    current: {
      label: config.current?.label || '',
      model: config.current?.model || '',
    },
    modes: (config.modes || []).map((row) => ({
      label: row.label || '',
      mode: row.mode || '',
      effort: row.effort || '',
      checked: row.checked || '',
      effortOptions: row.effortOptions || [],
    })),
    configureAvailable: Boolean(config.configureAvailable),
    configure: config.configure ? {
      title: config.configure.title || '',
      model: config.configure.model || '',
      modelOptions: config.configure.modelOptions || [],
      modes: config.configure.modes || [],
      selectedMode: config.configure.selectedMode || '',
      effort: config.configure.effort || '',
      effortOptions: config.configure.effortOptions || [],
    } : null,
  };
}

function summarizeState(state, modelConfig = null) {
  const lines = [];
  const config = compactModelConfig(modelConfig);
  lines.push(`URL: ${state.url}`);
  lines.push(`Model: ${state.model || 'unknown'}`);
  if (config?.error) {
    lines.push(`Model config: unavailable (${config.error})`);
  } else if (config) {
    const current = config.current?.label || config.current?.model || '';
    const selected = config.button || state.model || '';
    const modeLabels = (config.modes || [])
      .map((row) => {
        if (!row.label) return '';
        const suffix = row.effortOptions?.length ? ` (efforts: ${row.effortOptions.join(', ')})` : '';
        return `${row.label}${suffix}`;
      })
      .filter(Boolean);
    if (current || selected) {
      lines.push(`Model config: ${[current, selected ? `selected ${selected}` : ''].filter(Boolean).join('; ')}`);
    }
    if (modeLabels.length) lines.push(`Model modes: ${modeLabels.join(' | ')}`);
    if (config.configure?.modelOptions?.length) {
      lines.push(`Available models: ${config.configure.modelOptions.join(', ')}`);
    }
    if (config.configure?.modes?.length) {
      lines.push(`Configure modes: ${config.configure.modes.join(', ')}`);
    }
    if (config.configure?.effortOptions?.length) {
      lines.push(`Configure effort options: ${config.configure.effortOptions.join(', ')}`);
    }
  }
  lines.push(`Generating: ${state.isGenerating ? 'yes' : 'no'}`);
  if (state.blockingModal) {
    lines.push(`UI blocker: ${blockingModalSummary(state.blockingModal)}`);
  }
  if (state.generationControls.length) {
    lines.push(`Generation controls: ${state.generationControls.map((item) => item.text).join(' | ')}`);
  }
  if (state.voiceControls.length) {
    lines.push(`Voice/dictation controls: recognized, not used (${state.voiceControls.map((item) => item.aria || item.title || item.text || item.testid).join(' | ')})`);
  }
  lines.push(`Composer: ${state.composer.visible ? 'visible' : 'not visible'}, ${state.composer.textChars} chars`);
  if (state.composer.textChars >= 10000) {
    lines.push(`Composer long text: yes (${state.composer.textChars} chars)`);
  }
  if (state.composer.attachments.length) {
    lines.push(`Composer attachments: ${state.composer.attachments.map((item) => item.text || item.aria || item.testid).join(' | ')}`);
  }
  if (state.activityTexts.length) {
    lines.push(`Activity: ${state.activityTexts.slice(-5).join(' | ')}`);
  }
  const artifacts = state.artifacts;
  lines.push(`Artifacts: ${artifacts.links.length} links, ${artifacts.images.length} images, ${artifacts.downloadControls.length} download controls, ${artifacts.codeBlocks.length} code blocks`);
  if (state.latestAssistant.preview) {
    lines.push(`Latest assistant: ${state.latestAssistant.preview}`);
  }
  return lines.join('\n');
}

function latestTurnByRole(state, role) {
  return [...(state.lastTurns || [])].reverse().find((turn) => turn.role === role) || null;
}

function compactTurn(turn) {
  if (!turn) return null;
  return {
    index: turn.index,
    testid: turn.testid,
    role: turn.role,
    roleNodeCount: turn.roleNodeCount || 0,
    chars: turn.chars,
    preview: turn.preview,
  };
}

function turnSignature(turn) {
  if (!turn) return '';
  return [turn.testid || turn.index, turn.role, turn.chars].join(':');
}

function stateBaseline(state) {
  const latestTurn = state.lastTurns?.[state.lastTurns.length - 1] || null;
  const latestAssistant = latestTurnByRole(state, 'assistant');
  return {
    turnCount: state.turnCount || 0,
    latestTurnIndex: latestTurn?.index ?? -1,
    latestAssistantSignature: turnSignature(latestAssistant),
    latestAssistantChars: latestAssistant?.chars || 0,
  };
}

function buildStateEvent(state, baseline = null, transcriptPath = '') {
  const latestTurn = state.lastTurns?.[state.lastTurns.length - 1] || null;
  const latestAssistant = latestTurnByRole(state, 'assistant');
  const modelSelection = parseModelSelection(state.model || '');
  const modelConfig = compactModelConfig(state.modelConfig || null);
  const latestAssistantSignature = turnSignature(latestAssistant);
  const assistantAdvanced = Boolean(latestAssistant && baseline && (
    latestAssistantSignature !== baseline.latestAssistantSignature
    || latestAssistant.chars > baseline.latestAssistantChars
    || latestAssistant.index > baseline.latestTurnIndex
  ));
  const progressOnlyAssistant = Boolean(assistantAdvanced
    && isProgressOnlyText(latestAssistant?.preview || state.latestAssistant?.preview || ''));
  const progressActivityWithoutAssistant = Boolean(!assistantAdvanced
    && latestTurn?.role !== 'assistant'
    && (state.activityTexts || []).some(isProgressOnlyText));
  const blockedByModal = Boolean(state.blockingModal);
  const activeProgress = Boolean(state.isGenerating
    || state.generationControls?.length
    || progressOnlyAssistant
    || progressActivityWithoutAssistant);
  const ready = Boolean(!activeProgress && assistantAdvanced);
  const composerBusy = Boolean(state.composer?.textChars || state.composer?.attachments?.length);
  const phase = ready
    ? 'ready'
    : blockedByModal
      ? 'blocked'
      : activeProgress
      ? 'generating'
      : latestTurn?.role === 'user'
        ? 'waiting'
        : composerBusy
          ? 'composing'
          : 'idle';

  return {
    type: 'target_app_state',
    at: new Date().toISOString(),
    phase,
    ready,
    sessionId: sessionIdFromUrl(state.url),
    url: state.url,
    title: state.title,
    transcript: transcriptPath,
    model: state.model || '',
    modelSelection: {
      button: state.model || '',
      model: modelSelection.model || modelConfig?.current?.model || modelConfig?.configure?.model || '',
      mode: modelSelection.mode || '',
      effort: modelSelection.effort || '',
    },
    modelConfig,
    blockingModal: state.blockingModal ? {
      kind: state.blockingModal.kind || blockingModalKindFromMeta(state.blockingModal),
      id: state.blockingModal.id || '',
      testid: state.blockingModal.testid || '',
      text: normalizeTurnText(state.blockingModal.text || '').slice(0, 500),
    } : null,
    generating: state.isGenerating,
    generationControls: (state.generationControls || []).map((item) => item.text).filter(Boolean),
    voiceControls: (state.voiceControls || []).map((item) => item.aria || item.title || item.text || item.testid).filter(Boolean),
    activity: (state.activityTexts || []).slice(-5),
    composer: {
      visible: Boolean(state.composer?.visible),
      textChars: state.composer?.textChars || 0,
      attachments: (state.composer?.attachments || []).map((item) => item.text || item.aria || item.testid).filter(Boolean),
      fileInputCount: state.composer?.fileInputCount || 0,
    },
    turns: {
      count: state.turnCount || 0,
      latest: compactTurn(latestTurn),
      latestAssistant: compactTurn(latestAssistant),
    },
    artifacts: {
      links: state.artifacts?.links?.length || 0,
      images: state.artifacts?.images?.length || 0,
      downloadControls: state.artifacts?.downloadControls?.length || 0,
      codeBlocks: state.artifacts?.codeBlocks?.length || 0,
    },
  };
}

function stateEventKey(event) {
  return [
    event.phase,
    event.ready ? 'ready' : '',
    event.generating ? 'generating' : '',
    event.turns.count,
    event.turns.latest?.testid || '',
    event.turns.latest?.chars || 0,
    event.turns.latestAssistant?.testid || '',
    event.turns.latestAssistant?.chars || 0,
    event.composer.textChars,
    event.composer.attachments.join('|'),
    event.model,
    event.modelSelection.model,
    event.modelSelection.mode,
    event.modelSelection.effort,
    event.blockingModal?.kind || '',
    event.blockingModal?.id || '',
    event.blockingModal?.testid || '',
    event.blockingModal?.text || '',
    event.generationControls.join('|'),
    event.activity.join('|'),
    event.artifacts.links,
    event.artifacts.images,
    event.artifacts.downloadControls,
    event.artifacts.codeBlocks,
  ].join('::');
}

function formatStateEvent(event) {
  const parts = [
    `phase=${event.phase}`,
    `ready=${event.ready ? 'yes' : 'no'}`,
    `generating=${event.generating ? 'yes' : 'no'}`,
  ];
  if (event.sessionId) parts.push(`session=${event.sessionId}`);
  if (event.model) parts.push(`model=${event.model}`);
  if (event.modelSelection.mode) parts.push(`mode=${event.modelSelection.mode}`);
  if (event.modelSelection.effort) parts.push(`effort=${event.modelSelection.effort}`);
  if (event.blockingModal) parts.push(`blocker=${blockingModalSummary(event.blockingModal)}`);
  if (event.generationControls.length) parts.push(`control=${event.generationControls.join(' | ')}`);
  if (event.activity.length) parts.push(`activity=${event.activity.join(' | ')}`);
  if (event.turns.latest) parts.push(`latest=${event.turns.latest.role || 'unknown'}:${event.turns.latest.chars}`);
  if (event.artifacts.links || event.artifacts.images || event.artifacts.downloadControls || event.artifacts.codeBlocks) {
    parts.push(`artifacts links=${event.artifacts.links} images=${event.artifacts.images} downloads=${event.artifacts.downloadControls} code=${event.artifacts.codeBlocks}`);
  }
  return `[state] ${parts.join(' ')}`;
}

function createStateEmitter({ jsonl = false, stream = process.stderr, baseline = null, transcriptPath = '', getTranscriptPath = null } = {}) {
  let lastKey = '';
  return {
    emit(state, force = false) {
      const event = buildStateEvent(state, baseline, getTranscriptPath ? getTranscriptPath() : transcriptPath);
      const key = stateEventKey(event);
      if (!force && key === lastKey) return event;
      lastKey = key;
      if (jsonl) {
        stream.write(`${JSON.stringify(event)}\n`);
      } else {
        stream.write(`${formatStateEvent(event)}\n`);
      }
      return event;
    },
  };
}

function artifactDir(args) {
  const transcript = args.transcript || transcriptPathForSession('new-chat');
  const base = path.basename(transcript, path.extname(transcript));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(ARTIFACT_ROOT, base, stamp);
}

async function writeArtifactMetadata(page, args) {
  const dir = artifactDir(args);
  fs.mkdirSync(dir, { recursive: true });
  const state = await getTargetAppState(page);
  const filePath = path.join(dir, 'metadata.json');
  fs.writeFileSync(filePath, JSON.stringify({
    savedAt: new Date().toISOString(),
    url: state.url,
    artifacts: state.artifacts,
    latestAssistant: state.latestAssistant,
  }, null, 2), 'utf8');
  return { dir, filePath, state };
}

async function markLatestAssistantTurn(page) {
  return page.evaluate(() => {
    document.querySelectorAll('[data-cb-latest-assistant]').forEach((el) => {
      el.removeAttribute('data-cb-latest-assistant');
    });
    const latest = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')]
      .reverse()
      .find((turn) => {
        const roleEl = turn.matches('[data-message-author-role]')
          ? turn
          : turn.querySelector('[data-message-author-role]');
        const role = roleEl?.getAttribute('data-message-author-role')
          || turn.getAttribute('data-turn')
          || '';
        return role === 'assistant';
      });
    if (!latest) return false;
    latest.setAttribute('data-cb-latest-assistant', 'true');
    return true;
  });
}

function safeArtifactName(name, fallback) {
  const base = path.basename(name || fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || fallback;
}

function extensionForMime(mime, fallback = '.bin') {
  const normalized = (mime || '').split(';')[0].trim().toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/svg+xml') return '.svg';
  if (normalized === 'text/plain') return '.txt';
  if (normalized === 'application/json') return '.json';
  return fallback;
}

async function extractLatestAssistantFiles(page) {
  return page.evaluate(async () => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const root = document.querySelector('[data-cb-latest-assistant="true"]');
    if (!root) return [];

    const toBase64 = (buffer) => {
      const bytes = new Uint8Array(buffer);
      const chunks = [];
      for (let i = 0; i < bytes.length; i += 0x8000) {
        chunks.push(String.fromCharCode(...bytes.slice(i, i + 0x8000)));
      }
      return btoa(chunks.join(''));
    };

    const files = [];
    const seenImageSrcs = new Set();
    const images = [...root.querySelectorAll('img[src]')]
      .filter(isVisible)
      .filter((img) => (img.naturalWidth || img.width || 0) >= 64 || (img.naturalHeight || img.height || 0) >= 64)
      .filter((img) => {
        const src = img.currentSrc || img.src;
        if (!src || seenImageSrcs.has(src)) return false;
        seenImageSrcs.add(src);
        return true;
      })
      .slice(0, 10);

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const src = img.currentSrc || img.src;
      try {
        const response = await fetch(src, { credentials: 'include' });
        const blob = await response.blob();
        if (blob.size > 25 * 1024 * 1024) {
          files.push({
            type: 'skipped-image',
            index: i + 1,
            src,
            reason: `image is too large (${blob.size} bytes)`,
          });
          continue;
        }
        const buffer = await blob.arrayBuffer();
        files.push({
          type: 'image',
          index: i + 1,
          src,
          alt: img.getAttribute('alt') || '',
          width: img.naturalWidth || img.width || 0,
          height: img.naturalHeight || img.height || 0,
          mime: blob.type || response.headers.get('content-type') || '',
          base64: toBase64(buffer),
        });
      } catch (error) {
        files.push({
          type: 'skipped-image',
          index: i + 1,
          src,
          reason: error.message || String(error),
        });
      }
    }

    const codeItems = [...root.querySelectorAll('pre')]
      .filter(isVisible)
      .map((el, index) => {
        const code = el.querySelector('code');
        const text = code ? (code.innerText || code.textContent || '') : (el.innerText || el.textContent || '');
        const language = (code?.className || '').match(/language-([a-zA-Z0-9_-]+)/)?.[1] || '';
        let suggestedName = '';
        let cursor = el.previousElementSibling;
        for (let i = 0; cursor && i < 5; i++) {
          const previousText = textOf(cursor);
          const match = previousText.match(/FILE:\s*([^\s`]+(?:\.[^\s`]+)?)/i);
          if (match) {
            suggestedName = match[1];
            break;
          }
          cursor = cursor.previousElementSibling;
        }
        if (!suggestedName && language) {
          const ext = {
            markdown: 'md',
            md: 'md',
            javascript: 'js',
            js: 'js',
            json: 'json',
            html: 'html',
            xml: 'xml',
            text: 'txt',
            txt: 'txt',
          }[language.toLowerCase()] || 'txt';
          suggestedName = `code-block-${index + 1}.${ext}`;
        }
        return {
          text,
          suggestedName: suggestedName || `code-block-${index + 1}.txt`,
        };
      })
      .map((item) => ({ ...item, text: item.text.trim() }))
      .filter((item) => item.text);
    const dedupedCodeItems = [];
    for (const item of codeItems) {
      const existingIndex = dedupedCodeItems.findIndex((existing) => existing.text === item.text
        || existing.text.endsWith(item.text)
        || item.text.endsWith(existing.text));
      if (existingIndex === -1) {
        dedupedCodeItems.push(item);
      } else if (item.text.length < dedupedCodeItems[existingIndex].text.length) {
        dedupedCodeItems[existingIndex] = item;
      }
    }

    dedupedCodeItems
      .slice(0, 20)
      .forEach((item, index) => {
        files.push({
          type: 'code',
          index: index + 1,
          suggestedName: item.suggestedName || `code-block-${index + 1}.txt`,
          text: item.text.slice(0, 1000000),
          truncated: item.text.length > 1000000,
        });
      });

    [...root.querySelectorAll('a[href]')]
      .filter(isVisible)
      .map((a, index) => ({
        type: 'link',
        index: index + 1,
        text: textOf(a),
        href: a.href,
        download: a.getAttribute('download') || '',
      }))
      .filter((item) => item.href)
      .slice(0, 100)
      .forEach((item) => files.push(item));

    return files;
  });
}

async function downloadLatestArtifacts(page, args) {
  const { dir, filePath } = await writeArtifactMetadata(page, args);
  const saved = [{ type: 'metadata', path: filePath }];
  const hasTurn = await markLatestAssistantTurn(page);
  if (!hasTurn) return saved;

  const extracted = await extractLatestAssistantFiles(page).catch((error) => ([{
    type: 'extraction-error',
    reason: error.message || String(error),
  }]));

  const links = [];
  for (const item of extracted) {
    if (item.type === 'image' && item.base64) {
      const ext = extensionForMime(item.mime);
      const target = path.join(dir, safeArtifactName(`image-${item.index}${ext}`, `image-${item.index}${ext}`));
      fs.writeFileSync(target, Buffer.from(item.base64, 'base64'));
      saved.push({
        type: 'image',
        path: target,
        mime: item.mime,
        width: item.width,
        height: item.height,
        source: item.src,
      });
    } else if (item.type === 'code') {
      const target = path.join(dir, safeArtifactName(item.suggestedName, `code-block-${item.index}.txt`));
      fs.writeFileSync(target, item.text, 'utf8');
      saved.push({
        type: item.truncated ? 'code-truncated' : 'code',
        path: target,
      });
    } else if (item.type === 'link') {
      links.push(item);
    } else if (item.type && item.type.startsWith('skipped')) {
      saved.push({ type: item.type, reason: item.reason, source: item.src });
    }
  }

  if (links.length) {
    const linksPath = path.join(dir, 'links.json');
    fs.writeFileSync(linksPath, JSON.stringify(links, null, 2), 'utf8');
    saved.push({ type: 'links', path: linksPath });
  }

  const root = page.locator('[data-cb-latest-assistant="true"]');
  const candidates = root.locator('a[download], a:has-text("Download"), button:has-text("Download"), [role="button"]:has-text("Download")');
  const count = Math.min(await candidates.count().catch(() => 0), 10);
  for (let i = 0; i < count; i++) {
    const candidate = candidates.nth(i);
    try {
      const downloadPromise = page.waitForEvent('download', { timeout: 5000 });
      await candidate.click({ timeout: 5000 });
      const download = await downloadPromise;
      const suggested = download.suggestedFilename() || `artifact-${i + 1}`;
      const target = path.join(dir, suggested);
      await download.saveAs(target);
      saved.push({ type: 'download', path: target });
    } catch {}
  }
  return saved;
}

async function stopGeneration(page) {
  const controlText = await page.evaluate(() => {
    const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    document.querySelectorAll('[data-cb-stop-generation]').forEach((el) => {
      el.removeAttribute('data-cb-stop-generation');
    });
    const control = [...document.querySelectorAll('button,[role="button"]')]
      .filter(isVisible)
      .find((el) => {
        const text = [
          el.getAttribute('data-testid') || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          textOf(el),
        ].join(' ');
        return /\b(stop|interrupt|cancel)\b/i.test(text)
          && !/\b(share|copy|close|cancel dictation|start dictation|start voice|use voice|voice mode|chat with targetapp|microphone|mic)\b/i.test(text);
      });
    if (!control) return '';
    control.setAttribute('data-cb-stop-generation', 'true');
    return [
      control.getAttribute('data-testid') || '',
      control.getAttribute('aria-label') || '',
      control.getAttribute('title') || '',
      textOf(control),
    ].join(' ').replace(/\s+/g, ' ').trim();
  });

  if (!controlText) return false;
  await page.locator('[data-cb-stop-generation="true"]').click({ timeout: 5000 });
  return controlText;
}

async function markModelSwitcher(page) {
  return page.evaluate(() => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    document.querySelectorAll('[data-cb-model-switcher]').forEach((el) => {
      el.removeAttribute('data-cb-model-switcher');
    });

    const candidates = [...document.querySelectorAll('button,[role="button"]')]
      .filter(isVisible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = textOf(el);
        const meta = [
          el.getAttribute('data-testid') || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          text,
        ].join(' ');
        let score = 0;
        if (el.getAttribute('data-testid') === 'model-switcher-dropdown-button') score += 100;
        if (/model selector/i.test(el.getAttribute('aria-label') || '')) score += 100;
        if (text.length <= 80 && /\b(gpt|latest|instant|thinking|extended|pro)\b/i.test(text)) score += 50;
        if (rect.x > 250 && rect.y > 100) score += 20;
        if (/\b(search|project|history|pin|temporary|profile|account|download|apps|library)\b/i.test(meta)) score -= 100;
        if (/^targetapp pro$/i.test(text)) score -= 100;
        return { el, text, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    if (!best) return '';
    best.el.setAttribute('data-cb-model-switcher', 'true');
    return best.text || best.el.getAttribute('aria-label') || best.el.getAttribute('data-testid') || 'model-switcher';
  });
}

async function hasOpenModelMenu(page) {
  return page.evaluate(() => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [data-testid^="model-switcher-"], [data-testid="model-configure-modal"]')]
      .some((el) => isVisible(el) && /\b(latest|instant|thinking|pro|configure|intelligence|model)\b/i.test([
        el.getAttribute('data-testid') || '',
        el.getAttribute('aria-label') || '',
        textOf(el),
      ].join(' ')));
  }).catch(() => false);
}

async function waitForModelMenu(page, timeout = 5000) {
  await page.waitForFunction(() => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('[role="menu"], [data-testid^="model-switcher-"], [data-testid="model-configure-modal"]')]
      .some((el) => isVisible(el) && /\b(latest|instant|thinking|pro|configure)\b/i.test([
        el.getAttribute('data-testid') || '',
        textOf(el),
      ].join(' ')));
  }, null, { timeout });
}

async function openModelSwitcher(page) {
  if (await hasOpenModelMenu(page)) return 'open';
  const label = await markModelSwitcher(page);
  if (!label) return '';
  await page.locator('[data-cb-model-switcher="true"]').click({ timeout: 5000 });
  await waitForModelMenu(page).catch(() => page.waitForTimeout(700));
  return label;
}

function parseModelSelection(text) {
  const normalized = normalizeModelLabel(text);
  const modelMatch = normalized.match(/\b(?:gpt\s*)?((?:[45](?:\.\d+)?)|o\d+)\b/);
  const effortMatch = normalized.match(/\b(light|standard|extended|heavy)\b/);
  let mode = '';
  if (/\binstant\b/.test(normalized)) mode = 'Instant';
  else if (/\bthinking\b/.test(normalized)) mode = 'Thinking';
  else if (/\bpro\b/.test(normalized)) mode = 'Pro';

  return {
    raw: text,
    normalized,
    model: modelMatch ? modelMatch[1] : '',
    mode,
    effort: effortMatch ? effortMatch[1][0].toUpperCase() + effortMatch[1].slice(1) : '',
  };
}

function parseModeAndEffort(text) {
  const normalized = normalizeModelLabel(text);
  const selection = parseModelSelection(text);
  if (!selection.mode) {
    if (/^instant\b/.test(normalized)) selection.mode = 'Instant';
    else if (/^thinking\b/.test(normalized)) selection.mode = 'Thinking';
    else if (/^pro\b/.test(normalized)) selection.mode = 'Pro';
  }
  return selection;
}

async function getModelMenuState(page) {
  return page.evaluate(() => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const rectOf = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const modelRows = [...document.querySelectorAll('[data-testid^="model-switcher-"]')]
      .filter(isVisible)
      .filter((el) => {
        const testid = el.getAttribute('data-testid') || '';
        return testid !== 'model-switcher-dropdown-button'
          && !testid.includes('thinking-effort')
          && textOf(el);
      })
      .map((el) => {
        const text = textOf(el);
        const mode = (text.match(/\b(Instant|Thinking|Pro)\b/i)?.[1] || '').replace(/^./, (s) => s.toUpperCase());
        const effort = (text.match(/•\s*(Light|Standard|Extended|Heavy)\b/i)?.[1] || '').replace(/^./, (s) => s.toUpperCase());
        const testid = el.getAttribute('data-testid') || '';
        const effortButton = [...document.querySelectorAll('[data-testid]')]
          .find((button) => (button.getAttribute('data-testid') || '') === `${testid}-thinking-effort`)
          || el.querySelector('[data-model-picker-thinking-effort-action="true"], button[aria-label="Effort"]');
        return {
          label: text,
          mode,
          effort,
          testid,
          role: el.getAttribute('role') || '',
          checked: el.getAttribute('aria-checked') || el.getAttribute('data-state') || '',
          effortTestid: effortButton?.getAttribute('data-testid') || '',
          rect: rectOf(el),
        };
      });

    const menuRoots = [...document.querySelectorAll('[role="menu"]')]
      .filter(isVisible)
      .filter((el) => modelRows.some((row) => el.contains(document.querySelector(`[data-testid="${row.testid}"]`))));
    const menuRoot = menuRoots[0] || null;
    const header = menuRoot
      ? [...menuRoot.querySelectorAll('div,span')]
        .filter(isVisible)
        .map(textOf)
        .find((text) => /^(Latest|Legacy)\s*•\s*/i.test(text) || /^(Latest|Legacy)\b/i.test(text))
        || ''
      : '';
    const currentModel = header.match(/\b((?:[45](?:\.\d+)?)|o\d+)\b/i)?.[1] || '';
    const configure = [...document.querySelectorAll('[data-testid="model-configure-modal"], [role="menuitem"]')]
      .filter(isVisible)
      .map((el) => ({
        label: textOf(el),
        testid: el.getAttribute('data-testid') || '',
        rect: rectOf(el),
      }))
      .find((item) => /\bconfigure\b/i.test(item.label) || item.testid === 'model-configure-modal') || null;

    return {
      current: {
        label: header,
        model: currentModel,
      },
      rows: modelRows,
      configure,
    };
  });
}

async function clickMarkedVisibleOption(page, label, options = {}) {
  const marked = await page.evaluate(({ label: rawLabel, preferPopup }) => {
    const label = String(rawLabel || '').trim().toLowerCase();
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    document.querySelectorAll('[data-cb-visible-option]').forEach((el) => {
      el.removeAttribute('data-cb-visible-option');
    });
    const candidates = [...document.querySelectorAll('[role="option"], [role="menuitemradio"], [role="menuitem"], [role="radio"], button, [role="button"], div')]
      .filter(isVisible)
      .map((el) => {
        const text = textOf(el);
        const exact = text.toLowerCase() === label;
        const starts = text.toLowerCase().startsWith(`${label} `);
        const contains = text.toLowerCase().includes(label);
        if (!exact && !starts && !contains) return null;
        const rect = el.getBoundingClientRect();
        let score = 0;
        if (exact) score += 100;
        else if (starts) score += 60;
        else if (contains) score += 20;
        if (/^(option|menuitemradio|menuitem|radio)$/i.test(el.getAttribute('role') || '')) score += 50;
        if (el.closest('[role="menu"], [role="listbox"], [role="dialog"]')) score += 20;
        if (preferPopup && rect.x > 1000) score += 20;
        if (text.length > 120) score -= 50;
        return { el, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) return false;
    best.el.setAttribute('data-cb-visible-option', 'true');
    return true;
  }, { label, preferPopup: Boolean(options.preferPopup) });

  if (!marked) return false;
  await page.locator('[data-cb-visible-option="true"]').first().click({ timeout: 5000 });
  await page.waitForTimeout(500);
  return true;
}

async function readVisibleChoiceOptions(page) {
  return page.evaluate(() => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('[role="menuitemradio"], [role="option"]')]
      .filter(isVisible)
      .map(textOf)
      .filter((text) => text && text.length <= 80)
      .filter((text, index, arr) => arr.indexOf(text) === index);
  });
}

async function readEffortOptionsForRow(page, row) {
  if (!row?.testid || !row.effortTestid) return [];
  for (let attempt = 0; attempt < 2; attempt++) {
    await openModelSwitcher(page);
    await page.locator(`[data-testid="${row.testid}"]`).hover({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(150);
    const effortButton = page.locator(`[data-testid="${row.effortTestid}"]`).first();
    if (!await effortButton.count().catch(() => 0)) return [];
    await effortButton.click({ timeout: 5000, force: true });
    await page.waitForTimeout(300);
    const options = (await readVisibleChoiceOptions(page))
      .filter((option) => /^(Light|Standard|Extended|Heavy)$/i.test(option));
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
    if (options.length) return options;
  }
  return [];
}

async function setEffortForMenuRow(page, row, effort) {
  if (!row?.testid || !row.effortTestid) throw new Error(`No effort control found for ${row?.label || 'model row'}`);
  await openModelSwitcher(page);
  await page.locator(`[data-testid="${row.testid}"]`).hover({ timeout: 5000 });
  await page.waitForTimeout(150);
  await page.locator(`[data-testid="${row.effortTestid}"]`).click({ timeout: 5000, force: true });
  await page.waitForTimeout(300);
  if (!await clickMarkedVisibleOption(page, effort, { preferPopup: true })) {
    throw new Error(`No visible effort option matching: ${effort}`);
  }
}

async function openConfigureModalFromMenu(page) {
  const dialog = page.locator('[role="dialog"]').filter({ hasText: /Intelligence|Model/i }).first();
  if (await dialog.isVisible().catch(() => false)) return;

  for (let attempt = 0; attempt < 2; attempt++) {
    await openModelSwitcher(page);
    const configure = page.locator('[data-testid="model-configure-modal"]').first();
    let clicked = false;
    if (await configure.isVisible().catch(() => false)) {
      clicked = await configure.click({ timeout: 5000 })
        .then(() => true)
        .catch(() => false);
    } else if (!await clickMarkedVisibleOption(page, 'Configure...')) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(250);
      continue;
    } else {
      clicked = true;
    }
    if (!clicked) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(250);
      continue;
    }
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(300);
    return;
  }
  throw new Error('No Configure option found in model picker');
}

async function getConfigureModalState(page, includeDropdowns = false) {
  const modal = await page.evaluate(() => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((el) => isVisible(el) && /\b(Intelligence|Model)\b/i.test(textOf(el)));
    if (!dialog) return null;
    const combos = [...dialog.querySelectorAll('[role="combobox"], button')]
      .filter(isVisible)
      .map((el) => ({ text: textOf(el), role: el.getAttribute('role') || '' }))
      .filter((item) => item.text && item.text.length <= 80);
    const radios = [...dialog.querySelectorAll('[role="radio"], button')]
      .filter(isVisible)
      .map((el) => ({
        text: textOf(el),
        checked: el.getAttribute('aria-checked') || el.getAttribute('data-state') || '',
      }))
      .filter((item) => /\b(Instant|Thinking|Pro)\b/i.test(item.text));
    const model = combos.find((item) => /\b(?:[45](?:\.\d+)?|o\d+)\b/i.test(item.text))?.text || '';
    const effort = [...combos].reverse().find((item) => /\b(Light|Standard|Extended|Heavy)\b/i.test(item.text))?.text || '';
    return {
      title: textOf(dialog.querySelector('h1,h2,header') || dialog).slice(0, 80),
      model,
      modes: radios.map((item) => item.text.replace(/\s+For\b.*$/i, '').trim()).filter(Boolean),
      selectedMode: radios.find((item) => /^(true|checked|on)$/i.test(item.checked))?.text.replace(/\s+For\b.*$/i, '').trim() || '',
      effort,
    };
  });

  if (!modal || !includeDropdowns) return modal;

  const modelOptions = [];
  const effortOptions = [];
  const modelCombo = page.locator('[role="dialog"] [role="combobox"], [role="dialog"] button')
    .filter({ hasText: /\b(?:[45](?:\.\d+)?|o\d+)\b/ }).first();
  if (await modelCombo.count().catch(() => 0)) {
    await modelCombo.click({ timeout: 5000 });
    await page.waitForTimeout(300);
    modelOptions.push(...(await readVisibleChoiceOptions(page)).filter((option) => /\b(?:[45](?:\.\d+)?|o\d+)\b/i.test(option)));
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  }
  const effortCombo = page.locator('[role="dialog"] [role="combobox"], [role="dialog"] button')
    .filter({ hasText: /\b(Light|Standard|Extended|Heavy)\b/ }).last();
  if (await effortCombo.count().catch(() => 0)) {
    await effortCombo.click({ timeout: 5000 });
    await page.waitForTimeout(300);
    effortOptions.push(...(await readVisibleChoiceOptions(page)).filter((option) => /^(Light|Standard|Extended|Heavy)$/i.test(option)));
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  }

  return {
    ...modal,
    modelOptions: [...new Set(modelOptions)],
    effortOptions: [...new Set(effortOptions)],
  };
}

async function inspectModelConfigurator(page, options = {}) {
  await openModelSwitcher(page);
  const menu = await getModelMenuState(page);
  const buttonState = await getTargetAppState(page).catch(() => null);
  const result = {
    button: buttonState?.model || '',
    current: menu.current,
    modes: menu.rows,
    configureAvailable: Boolean(menu.configure),
  };

  if (options.includeDetails) {
    for (const row of result.modes) {
      row.effortOptions = await readEffortOptionsForRow(page, row);
    }
    await openConfigureModalFromMenu(page);
    result.configure = await getConfigureModalState(page, true);
    if (result.configure?.effortOptions?.length) {
      const selectedMode = normalizeModelLabel(result.configure.selectedMode);
      const selectedRow = result.modes.find((row) => row.checked === 'true'
        || selectedMode.includes(normalizeModelLabel(row.mode)));
      if (selectedRow && !selectedRow.effortOptions.length) {
        selectedRow.effortOptions = result.configure.effortOptions;
      }
    }
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  return result;
}

async function listModelOptions(page) {
  const config = await inspectModelConfigurator(page, { includeDetails: true });
  const lines = [];
  if (config.current?.label) lines.push(`Current: ${config.current.label}`);
  if (config.button) lines.push(`Selected: ${config.button}`);
  for (const row of config.modes || []) {
    const suffix = row.effortOptions?.length ? ` (efforts: ${row.effortOptions.join(', ')})` : '';
    lines.push(`${row.label}${suffix}`);
  }
  if (config.configureAvailable) lines.push('Configure...');
  if (config.configure?.modelOptions?.length) {
    lines.push(`Configure models: ${config.configure.modelOptions.join(', ')}`);
  }
  if (config.configure?.modes?.length) {
    lines.push(`Configure modes: ${config.configure.modes.join(', ')}`);
  }
  if (config.configure?.effortOptions?.length) {
    lines.push(`Configure effort options: ${config.configure.effortOptions.join(', ')}`);
  }
  return lines.filter((line, index, arr) => arr.indexOf(line) === index);
}

async function listReasoningOptions(page) {
  const state = await getTargetAppState(page);
  return state.reasoningControls
    .map((item) => item.text || item.aria || item.title || item.testid)
    .filter(Boolean);
}

function normalizeModelLabel(text) {
  return String(text || '')
    .replace(/\u2022/g, ' ')
    .replace(/[^a-zA-Z0-9.]+/g, ' ')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

async function clickOptionByText(page, text) {
  if (await clickMarkedVisibleOption(page, text)) return;
  throw new Error(`No visible option matching: ${text}`);
}

async function selectInConfigureModal(page, selection) {
  await openConfigureModalFromMenu(page);

  if (selection.model) {
    const modelCombo = page.locator('[role="dialog"] [role="combobox"], [role="dialog"] button')
      .filter({ hasText: /\b(?:[45](?:\.\d+)?|o\d+)\b/ }).first();
    if (!await modelCombo.count().catch(() => 0)) throw new Error('No model dropdown found in Configure modal');
    await modelCombo.click({ timeout: 5000 });
    await page.waitForTimeout(300);
    if (!await clickMarkedVisibleOption(page, selection.model, { preferPopup: true })) {
      throw new Error(`No model option matching: ${selection.model}`);
    }
  }

  if (selection.mode) {
    const modeClicked = await clickMarkedVisibleOption(page, selection.mode);
    if (!modeClicked) throw new Error(`No mode option matching: ${selection.mode}`);
  }

  if (selection.effort) {
    const effortCombo = page.locator('[role="dialog"] [role="combobox"], [role="dialog"] button')
      .filter({ hasText: /\b(Light|Standard|Extended|Heavy)\b/ }).last();
    if (!await effortCombo.count().catch(() => 0)) throw new Error('No effort dropdown found in Configure modal');
    await effortCombo.click({ timeout: 5000 });
    await page.waitForTimeout(300);
    if (!await clickMarkedVisibleOption(page, selection.effort, { preferPopup: true })) {
      throw new Error(`No effort option matching: ${selection.effort}`);
    }
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
}

async function selectModel(page, label) {
  const selection = parseModelSelection(label);
  if (!await openModelSwitcher(page)) throw new Error('No visible model picker found');
  let state = await getModelMenuState(page);
  const currentModel = state.current?.model || '';
  const needsConfigure = Boolean(selection.model && (!currentModel || selection.model !== currentModel));
  if (needsConfigure) {
    await selectInConfigureModal(page, selection);
    return;
  }

  const targetMode = selection.mode
    || (selection.effort ? parseModeAndEffort((await getTargetAppState(page).catch(() => null))?.model || '').mode : '');
  const row = targetMode
    ? state.rows.find((item) => item.mode.toLowerCase() === targetMode.toLowerCase())
    : state.rows.find((item) => normalizeModelLabel(item.label).includes(selection.normalized));

  if (!row) {
    if (selection.model || selection.mode || selection.effort) {
      await selectInConfigureModal(page, selection);
      return;
    }
    await clickOptionByText(page, label);
    return;
  }

  if (selection.effort && row.effort.toLowerCase() !== selection.effort.toLowerCase()) {
    await setEffortForMenuRow(page, row, selection.effort);
    await openModelSwitcher(page);
    state = await getModelMenuState(page);
  }

  const freshRow = state.rows.find((item) => item.testid === row.testid) || row;
  await page.locator(`[data-testid="${freshRow.testid}"]`).first().click({ timeout: 5000 });
  await page.waitForTimeout(700);
}

async function selectReasoning(page, label) {
  const selection = parseModelSelection(label);
  if (!selection.mode && selection.effort) {
    const state = await getTargetAppState(page).catch(() => null);
    selection.mode = parseModeAndEffort(state?.model || '').mode;
  }
  await selectModel(page, [selection.mode, selection.effort].filter(Boolean).join(' ') || label);
}

async function attachFiles(page, filePaths) {
  const resolved = filePaths.map((filePath) => path.resolve(filePath));
  for (const filePath of resolved) {
    if (!fs.existsSync(filePath)) throw new Error(`Attachment does not exist: ${filePath}`);
  }

  const setFiles = async () => {
    const selectors = [
      'input#upload-files[type="file"]',
      'input[type="file"]:not([accept="image/*"])',
      'input[type="file"]',
    ];
    for (const selector of selectors) {
      const inputs = page.locator(selector);
      const count = await inputs.count().catch(() => 0);
      if (!count) continue;
      await inputs.first().setInputFiles(resolved, { timeout: 10000 });
      return true;
    }
    return false;
  };

  if (!await setFiles()) {
    const addButton = page.locator('[data-testid="composer-plus-btn"], button[aria-label*="Add files"]').first();
    if (await addButton.count().catch(() => 0)) {
      await addButton.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(700);
    }
    if (!await setFiles()) throw new Error('No target app file input found');
  }

  await page.waitForTimeout(1500);
  return getTargetAppState(page);
}

async function settlePage(page) {
  await page.bringToFront().catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.locator('#prompt-textarea, [data-testid="composer-input"], div[contenteditable="true"]').last()
    .waitFor({ state: 'visible', timeout: 5000 })
    .catch(() => {});
  await page.waitForTimeout(500);
}

async function openNewConversation(page) {
  if (page.url().startsWith('https://configured-target.invalid/') && !sessionIdFromUrl(page.url())) {
    await settlePage(page);
    return;
  }
  await page.goto('https://configured-target.invalid/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await settlePage(page);
}

async function waitForConversationHydration(page, sessionId, timeoutMs = CONVERSATION_HYDRATION_TIMEOUT_MS) {
  if (!SESSION_ID_RE.test(sessionId || '')) {
    return { hydrated: false, sessionId: '', turnCount: 0, roleNodeCount: 0 };
  }

  const deadline = Date.now() + timeoutMs;
  let last = { hydrated: false, sessionId: '', turnCount: 0, roleNodeCount: 0 };
  while (Date.now() <= deadline) {
    last = await page.evaluate((expectedSessionId) => {
      const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const sessionIdFromLocation = () => {
        const parts = location.pathname.split('/').filter(Boolean);
        const cIndex = parts.indexOf('c');
        return cIndex !== -1 ? (parts[cIndex + 1] || '') : '';
      };
      const turns = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')].filter(isVisible);
      const roleNodes = [...document.querySelectorAll('[data-message-author-role]')].filter(isVisible);
      const sessionId = sessionIdFromLocation();
      return {
        hydrated: sessionId === expectedSessionId && (turns.length > 0 || roleNodes.length > 0),
        sessionId,
        turnCount: turns.length,
        roleNodeCount: roleNodes.length,
      };
    }, sessionId).catch(() => last);

    if (last.hydrated) return last;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(500);
  }

  return { ...last, hydrated: false, timedOut: true };
}

async function openConversationBySessionId(page, sessionId) {
  if (!SESSION_ID_RE.test(sessionId || '')) throw new Error(`Invalid target app session id: ${sessionId}`);
  if (sessionIdFromUrl(page.url()) === sessionId) {
    await settlePage(page);
    await waitForConversationHydration(page, sessionId);
    return;
  }
  await page.goto(`https://configured-target.invalid/c/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await settlePage(page);
  await waitForConversationHydration(page, sessionId);
}

async function prepareConversationForPrompt(page, args) {
  if (args.newConversation) {
    await openNewConversation(page);
    return;
  }
  if (!args.conversation || isCurrentConversationRef(args.conversation)) {
    return;
  }

  const index = loadConversationIndex();
  const parsed = parseConversationRef(args.conversation, index);
  const sessionId = parsed.sessionId;
  if (!sessionId) {
    throw new Error(`Conversation "${args.conversation}" is not resolved to a target app session id yet`);
  }
  await openConversationBySessionId(page, sessionId);
}

async function prepareConversationForRead(page, args) {
  if (!args.conversation || isCurrentConversationRef(args.conversation)) return;

  const index = loadConversationIndex();
  const parsed = parseConversationRef(args.conversation, index);
  const sessionId = parsed.sessionId;
  if (!sessionId) {
    throw new Error(`Conversation "${args.conversation}" is not resolved to a target app session id yet`);
  }
  await openConversationBySessionId(page, sessionId);
  refreshSessionTranscript(page, args);
}

function recordPromptConversation(args, page, response) {
  const sessionId = sessionIdFromUrl(page.url());
  if (!sessionId && !args.alias) return null;
  return withSchedulerLock(() => {
    const index = loadConversationIndex();
    const alias = normalizeAlias(args.alias || '', 'conversation alias');
    const record = upsertConversation(index, {
      alias,
      sessionId,
      status: sessionId ? 'active' : 'pending',
      url: page.url(),
      transcript: sessionId ? transcriptPathForSession(sessionId) : '',
      cdp: args.cdp,
      lastResponseChars: response.length,
    });
    saveConversationIndex(index);
    appendJsonl(CONVERSATION_EVENTS_PATH, {
      type: 'conversation_observed',
      at: record.updatedAt,
      conversation: record,
    });
    return record;
  });
}

function resolveRunnableTarget(job, index) {
  if (job.target?.newConversation) {
    return { action: 'new', sessionId: '', alias: job.target.alias || '' };
  }
  if (job.target?.sessionId) {
    return { action: 'open', sessionId: job.target.sessionId, alias: job.target.alias || '' };
  }
  if (job.target?.alias) {
    const record = findConversationByAlias(index, job.target.alias);
    if (record?.sessionId) {
      return { action: 'open', sessionId: record.sessionId, alias: job.target.alias };
    }
    return {
      action: 'blocked',
      reason: `conversation alias "${job.target.alias}" has not been resolved to a target app session id yet`,
    };
  }
  return { action: 'blocked', reason: 'job has no conversation target' };
}

function takeNextScheduledJob() {
  return withSchedulerLock(() => {
    const queue = loadQueueState();
    const index = loadConversationIndex();
    const ordered = queue.jobs.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
    const next = ordered.find((job) => !isDoneScheduledJob(job)) || null;
    if (!next) return { job: null, blocked: null };
    if (next.status !== 'pending') {
      return {
        job: null,
        blocked: {
          job: next,
          reason: `job #${next.seq} is ${next.status}; recover or reset it before continuing`,
        },
      };
    }

    const target = resolveRunnableTarget(next, index);
    if (target.action === 'blocked') {
      return { job: null, blocked: { job: next, reason: target.reason } };
    }

    next.status = 'running';
    next.updatedAt = nowIso();
    next.attempts = (next.attempts || 0) + 1;
    next.lastError = '';
    next.run = {
      startedAt: next.updatedAt,
      pid: process.pid,
      target,
    };
    saveQueueState(queue);
    appendJsonl(QUEUE_EVENTS_PATH, {
      type: 'job_started',
      at: next.updatedAt,
      jobId: next.id,
      seq: next.seq,
      target,
    });
    return { job: next, blocked: null };
  });
}

function finishScheduledJob(jobId, patch, eventType) {
  return withSchedulerLock(() => {
    const queue = loadQueueState();
    const job = queue.jobs.find((item) => item.id === jobId);
    if (!job) throw new Error(`Scheduled job disappeared: ${jobId}`);
    Object.assign(job, patch, { updatedAt: nowIso() });
    saveQueueState(queue);
    appendJsonl(QUEUE_EVENTS_PATH, {
      type: eventType,
      at: job.updatedAt,
      jobId,
      seq: job.seq,
      status: job.status,
      result: job.result || null,
      error: job.lastError || '',
    });
    return job;
  });
}

function recordResolvedConversation(job, page, response) {
  const sessionId = sessionIdFromUrl(page.url());
  if (!sessionId) return null;
  return withSchedulerLock(() => {
    const index = loadConversationIndex();
    const alias = job.target?.alias || '';
    const record = upsertConversation(index, {
      alias,
      sessionId,
      status: 'active',
      url: page.url(),
      title: '',
      transcript: transcriptPathForSession(sessionId),
      cdp: job.cdp || '',
      firstJobId: findConversationByAlias(index, alias)?.firstJobId || findConversationBySessionId(index, sessionId)?.firstJobId || job.id,
      lastJobId: job.id,
      lastResponseChars: response.length,
    });
    saveConversationIndex(index);
    appendJsonl(CONVERSATION_EVENTS_PATH, {
      type: 'conversation_resolved',
      at: record.updatedAt,
      conversation: record,
      jobId: job.id,
    });
    return record;
  });
}

function jobMatchesRound(job, round) {
  if (!job || !round) return false;
  const jobHash = messageHash(job.message || '');
  if (round.messageHash) return jobHash === round.messageHash;
  const text = normalizeTurnText(job.message || '');
  const head = normalizeTurnText(round.messageHead || '');
  const tail = normalizeTurnText(round.messageTail || '');
  if (head && tail && text.includes(head) && text.includes(tail)) return true;
  return false;
}

function expectedSessionIdForJob(job, index) {
  if (!job) return '';
  const alias = job.target?.alias || job.result?.alias || '';
  const record = alias && index ? findConversationByAlias(index, alias) : null;
  return record?.sessionId
    || job.target?.sessionId
    || job.result?.sessionId
    || sessionIdFromTranscriptPath(job.result?.transcript)
    || '';
}

function findRoundForJob(rounds, job, index = null) {
  const candidates = [...rounds].reverse().filter((round) => jobMatchesRound(job, round));
  if (!candidates.length) return null;

  const expectedSessionId = expectedSessionIdForJob(job, index);
  if (expectedSessionId) {
    return candidates.find((round) => round.sessionId === expectedSessionId) || null;
  }

  const jobHash = messageHash(job.message || '');
  const exactHashMatches = candidates.filter((round) => round.messageHash && round.messageHash === jobHash);
  if (exactHashMatches.length === 1) return exactHashMatches[0];

  const sessionMatches = candidates.filter((round) => round.sessionId);
  return sessionMatches.length === 1 ? sessionMatches[0] : null;
}

function scheduledJobIsRecoverable(status) {
  return ['running', 'waiting', 'needs_recovery', 'failed'].includes(status);
}

function scheduledJobNeedsReconciliation(status) {
  return scheduledJobIsRecoverable(status) || status === 'done';
}

function queueHoldStatusForError(message) {
  if (/Timed out after \d+ms while target app was still generating/i.test(message)) return 'waiting';
  if (/target app UI blocker|modal-conversation-history-rate-limit|conversation_history_rate_limit|modal-subscription-failure|subscription_modal|intercepts pointer events|Prompt was not submitted|send button stayed disabled|not submitted/i.test(message)) return 'needs_recovery';
  return 'failed';
}

function recoverQueueStateFromRounds(page, args, context) {
  return withSchedulerLock(() => {
    const queue = loadQueueState();
    const roundState = loadRoundState();
    const index = loadConversationIndex();
    const changedJobs = [];
    const changedRounds = [];
    const changedConversations = [];
    const now = nowIso();
    const indexBefore = JSON.stringify(index.conversations);
    const transcriptEntries = new Map();
    const finalResponseForRound = (round) => {
      const transcript = round.sessionId === context.activeSessionId
        ? args.transcript
        : (round.transcript || '');
      if (!transcript || !fs.existsSync(transcript)) return '';
      if (!transcriptEntries.has(transcript)) {
        transcriptEntries.set(transcript, parseTranscriptEntries(fs.readFileSync(transcript, 'utf8')));
      }
      return responseAfterRound(transcriptEntries.get(transcript), round);
    };

    for (const job of queue.jobs) {
      if (!scheduledJobNeedsReconciliation(job.status)) continue;
      const round = findRoundForJob(roundState.rounds, job, index);
      const sessionId = round?.sessionId || job.result?.sessionId || '';
      if (!round && !sessionId) continue;

      const activeRound = context.activeSessionId && round?.sessionId === context.activeSessionId;
      if (activeRound && context.isGenerating) {
        const message = `target app is still generating for session ${context.activeSessionId}; run CB --recover-queue after it finishes.`;
        if (job.status !== 'waiting' || job.lastError !== message) {
          Object.assign(job, {
            status: 'waiting',
            lastError: message,
            result: {
              waitingAt: now,
              sessionId: context.activeSessionId,
              url: context.url,
              transcript: args.transcript,
              recoverable: true,
            },
            updatedAt: now,
          });
          changedJobs.push({ type: 'job_waiting', job });
        }
        if (round.status !== 'pending' || round.lastError !== message) {
          Object.assign(round, {
            status: 'pending',
            responseChars: 0,
            completedAt: '',
            lastError: message,
            updatedAt: now,
          });
          changedRounds.push({ type: 'round_waiting', round });
        }
        continue;
      }

      const finalResponse = round ? finalResponseForRound(round) : '';
      if (round && finalResponse && finalResponse.length > (round.responseChars || 0)) {
        Object.assign(round, {
          status: 'done',
          responseChars: finalResponse.length,
          completedAt: round.completedAt || now,
          lastError: '',
          updatedAt: now,
        });
        changedRounds.push({ type: 'round_recovered', round });
      }

      if (round && (round.status !== 'done' || !round.responseChars)) continue;

      const finalResponseChars = round?.responseChars || job.result?.responseChars || 0;
      const transcript = sessionId === context.activeSessionId
        ? args.transcript
        : (round?.transcript || job.result?.transcript || (sessionId ? transcriptPathForSession(sessionId) : args.transcript));
      const existingResponseChars = job.result?.responseChars || 0;
      const jobSessionMismatch = Boolean(sessionId && job.result?.sessionId && job.result.sessionId !== sessionId);
      const jobTranscriptMismatch = Boolean(transcript && job.result?.transcript && job.result.transcript !== transcript);
      const jobAliasMismatch = Boolean((job.target?.alias || '') && job.result?.alias && job.result.alias !== job.target.alias);
      const jobResponseMismatch = Boolean(round && finalResponseChars && existingResponseChars && existingResponseChars !== finalResponseChars);
      if (job.status !== 'done'
        || finalResponseChars > existingResponseChars
        || jobResponseMismatch
        || jobSessionMismatch
        || jobTranscriptMismatch
        || jobAliasMismatch
        || job.lastError) {
        const previousStatus = job.status;
        Object.assign(job, {
          status: 'done',
          lastError: '',
          result: {
            ...(job.result || {}),
            completedAt: job.result?.completedAt || round?.completedAt || now,
            recoveredAt: now,
            recoveredBy: 'CB --recover-queue',
            sessionId,
            alias: job.target?.alias || '',
            url: sessionId ? `https://configured-target.invalid/c/${sessionId}` : context.url,
            transcript,
            responseChars: finalResponseChars,
          },
          updatedAt: now,
        });
        changedJobs.push({ type: previousStatus === 'done' ? 'job_reconciled' : 'job_recovered', job });
      }

      if (sessionId) {
        const alias = job.target?.alias || '';
        const record = upsertConversation(index, {
          alias,
          sessionId,
          status: 'active',
          url: `https://configured-target.invalid/c/${sessionId}`,
          transcript,
          cdp: args.cdp,
          firstJobId: findConversationByAlias(index, alias)?.firstJobId || findConversationBySessionId(index, sessionId)?.firstJobId || job.id,
          lastJobId: job.id,
          lastResponseChars: finalResponseChars,
          latestAssistantChars: finalResponseChars,
        });
        changedConversations.push(record);
      }
    }

    if (changedJobs.length) saveQueueState(queue);
    if (changedRounds.length) saveRoundState(roundState);
    if (changedConversations.length || JSON.stringify(index.conversations) !== indexBefore) saveConversationIndex(index);
    for (const change of changedJobs) {
      appendJsonl(QUEUE_EVENTS_PATH, {
        type: change.type,
        at: change.job.updatedAt,
        jobId: change.job.id,
        seq: change.job.seq,
        status: change.job.status,
        result: change.job.result || null,
        error: change.job.lastError || '',
      });
    }
    for (const change of changedRounds) {
      appendJsonl(ROUND_EVENTS_PATH, {
        type: change.type,
        at: change.round.updatedAt,
        round: change.round,
      });
    }
    for (const conversation of changedConversations) {
      appendJsonl(CONVERSATION_EVENTS_PATH, {
        type: 'conversation_recovered',
        at: conversation.updatedAt,
        conversation,
      });
    }

    const firstOpen = queue.jobs
      .slice()
      .sort((a, b) => (a.seq || 0) - (b.seq || 0))
      .find((job) => !isDoneScheduledJob(job)) || null;
    return {
      changedJobs: changedJobs.map((change) => ({
        id: change.job.id,
        seq: change.job.seq,
        status: change.job.status,
        sessionId: change.job.result?.sessionId || '',
      })),
      changedRounds: changedRounds.map((change) => ({
        id: change.round.id,
        status: change.round.status,
        sessionId: change.round.sessionId || '',
      })),
      firstOpen: firstOpen ? {
        id: firstOpen.id,
        seq: firstOpen.seq,
        status: firstOpen.status,
        alias: firstOpen.target?.alias || '',
      } : null,
      blocked: firstOpen && firstOpen.status !== 'pending'
        ? `job #${firstOpen.seq} is ${firstOpen.status}`
        : '',
    };
  });
}

async function recoverScheduledQueue(page, args) {
  refreshSessionTranscript(page, args);
  const state = await getTargetAppState(page).catch(() => null);
  const generation = await getCombinedGenerationState(page, state);
  const activeSessionId = sessionIdFromUrl(page.url());
  const sync = await syncTranscriptFromPage(page, args, { state, generation });
  const recoveredRounds = reconcilePendingRoundsFromTranscript(args, {
    skipSessionIds: generation.isGenerating && activeSessionId ? [activeSessionId] : [],
  });
  const queueRecovery = recoverQueueStateFromRounds(page, args, {
    activeSessionId,
    isGenerating: generation.isGenerating,
    url: page.url(),
  });

  return {
    type: 'queue_recovery',
    at: nowIso(),
    sessionId: activeSessionId,
    url: page.url(),
    generating: generation.isGenerating,
    transcript: args.transcript,
    sync,
    recoveredRounds: recoveredRounds.map((round) => ({
      id: round.id,
      sessionId: round.sessionId,
      responseChars: round.responseChars,
    })),
    ...queueRecovery,
  };
}

function printQueueRecovery(result, jsonl = false) {
  if (jsonl) {
    console.log(JSON.stringify(result));
    return;
  }
  console.error(`Recovered queue state for ${result.sessionId || '(no session)'} generating=${result.generating ? 'yes' : 'no'}`);
  console.error(`Transcript: ${result.transcript}`);
  console.error(`Synced ${result.sync.appended.length} appended turn(s), skipped ${result.sync.skipped.length} active turn(s)`);
  console.error(`Recovered ${result.recoveredRounds.length} round(s), changed ${result.changedJobs.length} job(s)`);
  if (result.blocked) console.error(`Queue blocked: ${result.blocked}`);
  else if (result.firstOpen) console.error(`Next job: #${result.firstOpen.seq} ${result.firstOpen.status} ${result.firstOpen.alias}`);
  else console.error('Queue complete');
}

async function runScheduledJob(page, job, runnerArgs) {
  const target = job.run?.target || resolveRunnableTarget(job, loadConversationIndex());
  if (target.action === 'new') {
    info(`[queue] #${job.seq} ${job.id}: starting new conversation${target.alias ? ` alias=${target.alias}` : ''}`);
    await openNewConversation(page);
  } else if (target.action === 'open') {
    info(`[queue] #${job.seq} ${job.id}: opening conversation ${target.sessionId}${target.alias ? ` alias=${target.alias}` : ''}`);
    await openConversationBySessionId(page, target.sessionId);
  } else {
    throw new Error(target.reason || 'scheduled job target is not runnable');
  }

  const scheduledTimeout = Number(job.options?.timeout) || 0;
  const scheduledTimeoutExplicit = Boolean(job.options?.timeoutExplicit);
  const timeout = runnerArgs.timeoutExplicit
    ? runnerArgs.timeout
    : scheduledTimeoutExplicit
      ? scheduledTimeout
      : 0;
  const jobArgs = {
    ...runnerArgs,
    transcript: null,
    transcriptOverride: false,
    attachments: job.attachments || [],
    model: job.model || '',
    reasoning: job.reasoning || '',
    timeout,
    downloadArtifacts: Boolean(job.options?.downloadArtifacts),
    showArtifacts: Boolean(job.options?.showArtifacts),
    stream: runnerArgs.stream && job.options?.stream !== false,
  };
  const response = await ask(page, job.message, jobArgs);
  const conversation = recordResolvedConversation(job, page, response);
  const sessionId = sessionIdFromUrl(page.url());
  return {
    completedAt: nowIso(),
    sessionId,
    alias: job.target?.alias || '',
    url: page.url(),
    transcript: jobArgs.transcript || (sessionId ? transcriptPathForSession(sessionId) : ''),
    responseChars: response.length,
    conversation,
  };
}

async function runScheduledQueue(page, args) {
  let completed = 0;
  while (true) {
    if (args.queueLimit && completed >= args.queueLimit) return;

    const { job, blocked } = takeNextScheduledJob();
    if (!job) {
      if (blocked) {
        const message = `[queue] blocked at #${blocked.job.seq} ${blocked.job.id}: ${blocked.reason}`;
        if (!args.queueWatch) {
          console.error(message);
          return;
        }
        info(message);
      } else if (!args.queueWatch) {
        info('[queue] no pending jobs');
        return;
      }
      await page.waitForTimeout(args.stateInterval);
      continue;
    }

    try {
      const result = await runScheduledJob(page, job, args);
      finishScheduledJob(job.id, {
        status: 'done',
        result,
        lastError: '',
      }, 'job_completed');
      completed += 1;
      info(`[queue] #${job.seq} ${job.id}: done session=${result.sessionId || '(none)'} transcript=${result.transcript}`);
    } catch (error) {
      const message = error.message || String(error);
      const status = queueHoldStatusForError(message);
      const eventType = status === 'failed' ? 'job_failed' : 'job_held';
      finishScheduledJob(job.id, {
        status,
        lastError: message,
        result: {
          heldAt: nowIso(),
          url: page.url(),
          recoverable: status !== 'failed',
        },
      }, eventType);
      console.error(`[queue] #${job.seq} ${job.id}: ${status}: ${message}`);
      return;
    }
  }
}

function createStreamPrinter(args, baseline = null) {
  let lastText = '';
  const stateEmitter = createStateEmitter({
    jsonl: args.stateJsonl,
    stream: process.stderr,
    baseline,
    getTranscriptPath: () => args.transcript || '',
  });

  return {
    update(event) {
      const state = event.state;
      if (state) {
        stateEmitter.emit(state);
      }

      if (!args.stream) return;

      if (typeof event.text === 'string' && event.text.startsWith(lastText)) {
        const delta = event.text.slice(lastText.length);
        if (delta) {
          process.stdout.write(delta);
          lastText = event.text;
        }
      } else if (typeof event.text === 'string' && event.text && event.text !== lastText) {
        process.stdout.write(`\n${event.text}`);
        lastText = event.text;
      }
    },
    finish() {
      if (args.stream && lastText && !lastText.endsWith('\n')) process.stdout.write('\n');
    },
  };
}

async function waitForAssistantResponse(page, message, baselineLastTurnId, timeout, onUpdate = null) {
  const start = Date.now();
  const noTimeout = timeout === 0 || timeout === Infinity;
  let lastText = '';
  let stableSince = 0;
  let sawResponse = false;
  let reloadedForMissingResponse = false;

  while (noTimeout || Date.now() - start < timeout) {
    const turns = await getConversationTurns(page).catch(() => []);
    const text = responseAfterMessage(turns, message, baselineLastTurnId);
    const placeholder = !text || isProgressOnlyText(text);
    const pageState = await getTargetAppState(page).catch(() => null);

    if (!placeholder) {
      sawResponse = true;
      if (text !== lastText) {
        lastText = text;
        stableSince = Date.now();
      }

      if (onUpdate) onUpdate({ text, state: pageState });

      const state = await getCombinedGenerationState(page, pageState);
      if (!state.isGenerating) {
        await page.waitForTimeout(500);
        const finalText = responseAfterMessage(await getConversationTurns(page).catch(() => []), message, baselineLastTurnId);
        const finalState = await getTargetAppState(page).catch(() => null);
        const finalGeneration = await getCombinedGenerationState(page, finalState);
        if (!finalGeneration.isGenerating) {
          if (onUpdate) onUpdate({ text: finalText || lastText, state: finalState });
          return finalText || lastText;
        }
      }

      if (Date.now() - stableSince >= RESPONSE_STABLE_FALLBACK_MS && !state.isGenerating) {
        return text;
      }
    } else if (onUpdate && pageState) {
      onUpdate({ text: '', state: pageState });
    }

    if (!sawResponse
      && !reloadedForMissingResponse
      && Date.now() - start >= NO_RESPONSE_RELOAD_MS
      && hasUserTurnAfterBaseline(turns, message, baselineLastTurnId)
      && sessionIdFromUrl(page.url())
      && pageState
      && !(await getCombinedGenerationState(page, pageState)).isGenerating) {
      reloadedForMissingResponse = true;
      info('[state] no assistant turn visible while UI is idle; reloading target app once');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await settlePage(page);
    }

    await page.waitForTimeout(sawResponse ? RESPONSE_POLL_MS : 500);
  }

  if (lastText) {
    const finalText = responseAfterMessage(await getConversationTurns(page).catch(() => []), message, baselineLastTurnId);
    const finalState = await getTargetAppState(page).catch(() => null)
    const finalGeneration = await getCombinedGenerationState(page, finalState);
    if (finalText && !finalGeneration.isGenerating) return finalText;
    throw new Error(`Timed out after ${timeout}ms while target app was still generating. Partial assistant text was not appended; run CB --sync-transcript after the browser finishes.`);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for assistant response`);
}

async function watchTargetAppState(page, args) {
  refreshSessionTranscript(page, args);
  const initialState = await getTargetAppState(page);
  const baseline = stateBaseline(initialState);
  const emitter = createStateEmitter({
    jsonl: args.stateJsonl,
    stream: process.stdout,
    baseline,
    getTranscriptPath: () => args.transcript || '',
  });

  const start = Date.now();
  const noTimeout = args.timeout === 0 || args.timeout === Infinity;
  let event = emitter.emit(initialState, true);

  while (true) {
    if (args.waitReady && event.ready) return event;
    if (args.waitReady && !noTimeout && Date.now() - start >= args.timeout) {
      throw new Error(`Timed out after ${args.timeout}ms waiting for ready assistant output`);
    }

    await page.waitForTimeout(args.stateInterval);
    refreshSessionTranscript(page, args);
    const state = await getTargetAppState(page);
    event = emitter.emit(state);
  }
}

async function ask(page, message, args) {
  await reconcileCurrentConversation(page, args, { suppressAlias: args.newConversation }).catch(() => {});
  refreshSessionTranscript(page, args);
  if (args.model) {
    info(`[model] selecting ${args.model}`);
    await selectModel(page, args.model);
  }
  if (args.reasoning) {
    info(`[reasoning] selecting ${args.reasoning}`);
    await selectReasoning(page, args.reasoning);
  }
  if (args.attachments && args.attachments.length) {
    info(`[attach] ${args.attachments.join(', ')}`);
    const state = await attachFiles(page, args.attachments);
    if (state.composer.attachments.length) {
      info(`[attach] composer attachments: ${state.composer.attachments.map((item) => item.text || item.aria || item.testid).join(' | ')}`);
    }
  }
  const baselineState = await getTargetAppState(page).catch(() => null);
  const watchBaseline = baselineState ? stateBaseline(baselineState) : null;
  const turnsBefore = await getConversationTurns(page);
  const baselineLastTurnId = turnsBefore.length ? turnsBefore[turnsBefore.length - 1].testid : '';
  await sendMessage(page, message, baselineLastTurnId);
  await page.waitForFunction(() => /\/c\/[^/]+/.test(location.pathname), null, { timeout: 10000 }).catch(() => {});
  refreshSessionTranscript(page, args);
  await indexCurrentConversation(page, args, 'conversation_prompt_accepted').catch(() => {});
  const round = registerPendingRound(args, page, message, baselineLastTurnId);
  appendTranscript(args.transcript, 'user', message);
  const streamer = (args.stream || args.stateJsonl) ? createStreamPrinter(args, watchBaseline) : null;
  let response = '';
  try {
    response = await waitForAssistantResponse(
      page,
      message,
      baselineLastTurnId,
      args.timeout,
      streamer ? (event) => streamer.update(event) : null,
    );
  } catch (error) {
    updateRound(round.id, {
      status: 'pending',
      lastError: error.message || String(error),
      url: page.url(),
      transcript: args.transcript,
    }, 'round_waiting_for_recovery');
    throw error;
  }
  if (streamer) streamer.finish();
  refreshSessionTranscript(page, args);
  appendTranscript(args.transcript, 'assistant', response);
  updateRound(round.id, {
    status: 'done',
    responseChars: response.length,
    completedAt: nowIso(),
    url: page.url(),
    transcript: args.transcript,
    lastError: '',
  }, 'round_completed');
  await indexCurrentConversation(page, args, 'conversation_round_completed', {
    lastResponseChars: response.length,
  }).catch(() => {});
  if (args.downloadArtifacts) {
    const saved = await downloadLatestArtifacts(page, args);
    info(`[artifacts] saved ${saved.length} item(s): ${saved.map(formatSavedArtifact).join(', ')}`);
    if (args.showArtifacts) printSavedArtifacts(saved);
  }
  return response;
}

async function inspectStatusModelConfig(page) {
  try {
    return await inspectModelConfigurator(page, { includeDetails: true });
  } catch (error) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    return { error: error.message || String(error) };
  }
}

function drainReadable(stream) {
  while (stream.read() !== null) {}
}

function discardInputDuringWait() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return () => {};
  }

  const wasRaw = process.stdin.isRaw;
  const discard = () => {};

  drainReadable(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', discard);

  return () => {
    process.stdin.off('data', discard);
    drainReadable(process.stdin);
    process.stdin.setRawMode(Boolean(wasRaw));
  };
}

function readPromptInputFallback(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });

  return new Promise((resolve) => {
    let done = false;
    let settleTimer = null;
    const lines = [];

    const finish = (input) => {
      if (done) return;
      done = true;
      if (settleTimer) clearTimeout(settleTimer);
      rl.close();
      resolve(input);
    };

    const scheduleMessage = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        finish({ type: 'message', text: lines.join('\n').trim() });
      }, PASTE_SETTLE_MS);
    };

    rl.setPrompt(prompt);
    rl.prompt();

    rl.on('line', (line) => {
      const trimmed = line.trim();

      if (lines.length === 0 && !trimmed) {
        rl.prompt();
        return;
      }

      if (lines.length === 0 && isInteractiveCommand(trimmed)) {
        finish({ type: 'command', text: trimmed });
        return;
      }

      lines.push(line);
      scheduleMessage();
    });

    rl.on('close', () => {
      if (!done) finish({ type: 'command', text: '/exit' });
    });
  });
}

function readPromptInput(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return readPromptInputFallback(prompt);
  }

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = stdin.isRaw;
    let done = false;
    let buffer = '';
    let parserBuffer = '';
    let pasteMode = false;
    let pasteSettleTimer = null;

    const cleanup = () => {
      if (pasteSettleTimer) clearTimeout(pasteSettleTimer);
      stdin.off('data', onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      stdout.write(BRACKETED_PASTE_OFF);
    };

    const finish = (input) => {
      if (done) return;
      done = true;
      cleanup();
      stdout.write('\n');
      resolve(input);
    };

    const finishMessage = () => {
      finish({ type: 'message', text: buffer.trim() });
    };

    const schedulePastedMessage = () => {
      if (pasteSettleTimer) clearTimeout(pasteSettleTimer);
      pasteSettleTimer = setTimeout(finishMessage, PASTE_SETTLE_MS);
    };

    const appendText = (text) => {
      buffer += text;
      stdout.write(text);
    };

    const backspace = () => {
      if (!buffer) return;
      buffer = buffer.slice(0, -1);
      stdout.write('\b \b');
    };

    const handleNormalText = (text) => {
      const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const newlineCount = (normalized.match(/\n/g) || []).length;
      const isLikelyMultilinePaste = newlineCount > 1 || (newlineCount === 1 && !normalized.endsWith('\n'));

      if (isLikelyMultilinePaste) {
        appendText(normalized);
        schedulePastedMessage();
        return;
      }

      for (const char of normalized) {
        if (char === '\u0003') {
          finish({ type: 'command', text: '/exit' });
          return;
        }

        if (char === '\u007f' || char === '\b') {
          backspace();
          continue;
        }

        if (char === '\n') {
          const trimmed = buffer.trim();
          if (!trimmed) {
            stdout.write('\n');
            stdout.write(prompt);
            buffer = '';
            continue;
          }

          if (isInteractiveCommand(trimmed)) {
            finish({ type: 'command', text: trimmed });
            return;
          }

          finishMessage();
          return;
        }

        // Ignore common escape sequences such as arrow keys at the prompt.
        if (char === '\x1b') continue;
        appendText(char);
      }
    };

    const consumeParserBuffer = () => {
      while (parserBuffer && !done) {
        if (pasteMode) {
          const endIndex = parserBuffer.indexOf(PASTE_END);
          if (endIndex === -1) {
            appendText(parserBuffer);
            parserBuffer = '';
            return;
          }

          appendText(parserBuffer.slice(0, endIndex));
          parserBuffer = parserBuffer.slice(endIndex + PASTE_END.length);
          pasteMode = false;
          finishMessage();
          return;
        }

        const startIndex = parserBuffer.indexOf(PASTE_START);
        if (startIndex === -1) {
          const keep = PASTE_START.startsWith(parserBuffer) ? parserBuffer : '';
          const text = keep ? '' : parserBuffer;
          parserBuffer = keep;
          if (text) handleNormalText(text);
          return;
        }

        if (startIndex > 0) {
          handleNormalText(parserBuffer.slice(0, startIndex));
          if (done) return;
        }

        parserBuffer = parserBuffer.slice(startIndex + PASTE_START.length);
        pasteMode = true;
      }
    };

    const onData = (chunk) => {
      if (done) return;
      parserBuffer += chunk.toString('utf8');
      consumeParserBuffer();
    };

    stdout.write(BRACKETED_PASTE_ON);
    stdout.write(prompt);
    drainReadable(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function parseScriptedInputs(text) {
  const body = String(text || '').trim();
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const hasCommands = lines.some((line) => isInteractiveCommand(line.trim()));
  if (!hasCommands) return [{ type: 'message', text: body }];

  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({
      type: isInteractiveCommand(line) ? 'command' : 'message',
      text: line,
    }));
}

function readMultilineInput() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });

  console.log('Paste multiline message. End with /send on its own line. Use /cancel to abort.');

  return new Promise((resolve) => {
    let done = false;
    const lines = [];

    const finish = (input) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(input);
    };

    rl.setPrompt('... ');
    rl.prompt();

    rl.on('line', (line) => {
      const trimmed = line.trim();

      if (trimmed === '/cancel') {
        finish({ type: 'cancel' });
        return;
      }

      if (trimmed === '/send') {
        finish({ type: 'message', text: lines.join('\n').trim() });
        return;
      }

      lines.push(line);
      rl.prompt();
    });

    rl.on('close', () => {
      if (!done) finish({ type: 'cancel' });
    });
  });
}

async function interactive(page, args) {
  console.log(`Connected to target app: ${page.url()}`);
  refreshSessionTranscript(page, args);
  console.log(`Transcript: ${args.transcript}`);
  console.log('Type /exit to quit. Use /status, /models, /attach <path>, /artifacts, or /stream off. Multiline paste works at CB>.');
  let pendingAttachments = [];
  const scriptedInputs = args.scriptedInput === null ? null : parseScriptedInputs(args.scriptedInput);

  while (true) {
    const input = scriptedInputs
      ? scriptedInputs.shift() || { type: 'command', text: '/exit' }
      : await readPromptInput('CB> ');
    if (scriptedInputs) console.log(`CB> ${input.text}`);

    if (input.type === 'command' && (input.text === '/exit' || input.text === '/quit')) break;
    if (input.type === 'command' && input.text === '/transcript') {
      console.log(args.transcript);
      continue;
    }
    if (input.type === 'command' && (input.text === '/status' || input.text.startsWith('/status '))) {
      const deepStatus = /\b(deep|config|models?|inspect)\b/i.test(input.text);
      const state = await getTargetAppState(page);
      const modelConfig = deepStatus ? await inspectStatusModelConfig(page) : null;
      console.log(summarizeState(state, modelConfig));
      continue;
    }
    if (input.type === 'command' && input.text === '/models') {
      const options = await listModelOptions(page);
      console.log(options.length ? options.join('\n') : 'No visible model options found.');
      continue;
    }
    if (input.type === 'command' && input.text === '/reasoning') {
      const options = await listReasoningOptions(page);
      console.log(options.length ? options.join('\n') : 'No visible reasoning controls found.');
      continue;
    }
    if (input.type === 'command' && input.text.startsWith('/model ')) {
      const label = input.text.slice('/model '.length).trim();
      if (!label) {
        console.log('Usage: /model <visible label>');
        continue;
      }
      await selectModel(page, label);
      console.log(`Selected model matching: ${label}`);
      continue;
    }
    if (input.type === 'command' && input.text.startsWith('/reasoning ')) {
      const label = input.text.slice('/reasoning '.length).trim();
      if (!label) {
        console.log('Usage: /reasoning <visible label>');
        continue;
      }
      await selectReasoning(page, label);
      console.log(`Selected reasoning matching: ${label}`);
      continue;
    }
    if (input.type === 'command' && input.text.startsWith('/attach ')) {
      const filePath = input.text.slice('/attach '.length).trim();
      if (!filePath) {
        console.log('Usage: /attach /path/to/file');
        continue;
      }
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        console.log(`Attachment does not exist: ${resolved}`);
        continue;
      }
      pendingAttachments.push(resolved);
      console.log(`Queued attachment for next message: ${resolved}`);
      continue;
    }
    if (input.type === 'command' && input.text === '/artifacts') {
      const result = await writeArtifactMetadata(page, args);
      console.log(`Saved artifact metadata: ${result.filePath}`);
      console.log(JSON.stringify(result.state.artifacts, null, 2));
      continue;
    }
    if (input.type === 'command' && input.text === '/download') {
      const saved = await downloadLatestArtifacts(page, args);
      console.log(saved.map(formatSavedArtifact).join('\n'));
      printSavedArtifacts(saved);
      continue;
    }
    if (input.type === 'command' && input.text === '/stop') {
      const stopped = await stopGeneration(page);
      console.log(stopped ? `Clicked generation control: ${stopped}` : 'No visible generation control found.');
      continue;
    }
    if (input.type === 'command' && input.text.startsWith('/stream ')) {
      const value = input.text.slice('/stream '.length).trim().toLowerCase();
      if (value === 'on') args.stream = true;
      else if (value === 'off') args.stream = false;
      else {
        console.log('Usage: /stream on|off');
        continue;
      }
      console.log(`Streaming is ${args.stream ? 'on' : 'off'}.`);
      continue;
    }
    if (input.type === 'command' && input.text === '/multi') {
      const multiline = await readMultilineInput();
      if (multiline.type === 'cancel') {
        console.log('Canceled.');
        continue;
      }
      input.type = 'message';
      input.text = multiline.text;
    }

    const message = input.text.trim();
    if (!message) continue;

    let restoreInput = () => {};
    const previousAttachments = args.attachments;
    try {
      console.log('Waiting for response...');
      restoreInput = discardInputDuringWait();
      args.attachments = pendingAttachments;
      const response = await ask(page, message, args);
      if (!args.stream) console.log(`\n${response}\n`);
      pendingAttachments = [];
    } catch (error) {
      console.error(`Error: ${error.message || error}`);
    } finally {
      args.attachments = previousAttachments;
      restoreInput();
      drainReadable(process.stdin);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.message === '-') {
    args.message = await readAllStdin();
  } else if (!args.message && !process.stdin.isTTY) {
    args.scriptedInput = await readAllStdin();
  }

  if (args.queueStatus) {
    printQueueStatus(args);
    return;
  }

  if (args.schedule && !scheduleNeedsCurrentPage(args)) {
    const job = enqueueScheduledJob(args);
    printScheduledJob(job, args.stateJsonl);
    return;
  }

  const browser = await chromium.connectOverCDP(args.cdp, { timeout: CDP_CONNECT_TIMEOUT_MS });
  try {
    const page = await findTargetAppPage(browser, args);
    const passiveCurrentPageRead = isPassiveCurrentPageRead(args);
    if (passiveCurrentPageRead) {
      refreshSessionTranscript(page, args);
    } else {
      await settlePage(page);
      refreshSessionTranscript(page, args);
      if (!args.syncTranscript) {
        await reconcileCurrentConversation(page, args, { suppressAlias: args.newConversation }).catch((error) => {
          info(`[sync] ${error.message || error}`);
        });
      }
    }

    if (args.schedule) {
      const job = enqueueScheduledJob(args, page);
      printScheduledJob(job, args.stateJsonl);
      return;
    }

    if (args.runQueue) {
      const recovery = await recoverScheduledQueue(page, args);
      if (recovery.blocked) {
        printQueueRecovery(recovery, args.stateJsonl);
        return;
      }
      await runScheduledQueue(page, args);
      return;
    }

    if (args.recoverQueue) {
      await prepareConversationForRead(page, args);
      const recovery = await recoverScheduledQueue(page, args);
      printQueueRecovery(recovery, args.stateJsonl);
      return;
    }

    if (args.syncTranscript) {
      await prepareConversationForRead(page, args);
      const state = await getTargetAppState(page).catch(() => null);
      const generation = await getCombinedGenerationState(page, state);
      const result = await syncTranscriptFromPage(page, args, { state, generation });
      const activeSessionId = sessionIdFromUrl(page.url());
      const recoveredRounds = reconcilePendingRoundsFromTranscript(args, {
        skipSessionIds: generation.isGenerating && activeSessionId ? [activeSessionId] : [],
      });
      await indexCurrentConversation(page, args, 'conversation_sync', {
        recoveredRoundCount: recoveredRounds.length,
        syncedTurnCount: result.appended.length,
      }).catch((error) => {
        info(`[index] ${error.message || error}`);
      });
      const text = args.latestAssistant ? await latestAssistantText(page) : '';
      if (args.stateJsonl) {
        console.log(JSON.stringify({
          type: 'transcript_sync',
          at: new Date().toISOString(),
          recoveredRounds: recoveredRounds.map((round) => ({
            id: round.id,
            sessionId: round.sessionId,
            responseChars: round.responseChars,
          })),
          ...result,
        }));
      } else {
        console.error(`Synced transcript: ${result.transcript}`);
        console.error(`Appended ${result.appended.length} turn(s): ${result.appended.map((item) => `${item.role}:${item.chars}`).join(', ') || 'none'}`);
        console.error(`Recovered ${recoveredRounds.length} pending round(s)`);
      }
      if (args.latestAssistant) console.log(text);
      return;
    }

    if (args.latestAssistant) {
      await prepareConversationForRead(page, args);
      const text = await latestAssistantText(page);
      if (!text) throw new Error('No completed assistant response found in the live target app DOM');
      console.log(text);
      return;
    }

    if (args.status) {
      await prepareConversationForRead(page, args);
      const state = await getTargetAppState(page);
      const modelConfig = args.deepStatus ? await inspectStatusModelConfig(page) : null;
      if (modelConfig) state.modelConfig = compactModelConfig(modelConfig);
      if (args.stateJsonl) {
        console.log(JSON.stringify(buildStateEvent(state, null, args.transcript || '')));
      } else {
        console.log(summarizeState(state, modelConfig));
      }
      return;
    }

    if (args.watchState) {
      await watchTargetAppState(page, args);
      return;
    }

    if (args.models) {
      const options = await listModelOptions(page);
      console.log(options.length ? options.join('\n') : 'No visible model options found.');
      return;
    }

    if (args.stop) {
      const stopped = await stopGeneration(page);
      console.log(stopped ? `Clicked generation control: ${stopped}` : 'No visible generation control found.');
      return;
    }

    if (args.downloadArtifacts && typeof args.message !== 'string') {
      const saved = await downloadLatestArtifacts(page, args);
      console.log(saved.map(formatSavedArtifact).join('\n'));
      if (args.showArtifacts) printSavedArtifacts(saved);
      return;
    }

    if (typeof args.message === 'string') {
      const message = args.message.trim();
      if (!message) throw new Error('No message provided');
      await prepareConversationForPrompt(page, args);
      const response = await ask(page, message, args);
      recordPromptConversation(args, page, response);
      if (!args.stream) console.log(response);
      console.error(`Saved transcript: ${args.transcript}`);
      return;
    }

    await interactive(page, args);
  } finally {
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
