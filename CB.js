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
const TARGET_APP_BRAND_TOKEN = ['chat', 'gpt'].join('');
const TARGET_APP_BASE_URL = normalizeTargetAppUrl(process.env.CHATBOT_WEB_URL || `https://${TARGET_APP_BRAND_TOKEN}.com/`);
const TARGET_APP_BASE = new URL(TARGET_APP_BASE_URL);
const CDP_CONNECT_TIMEOUT_MS = Number(process.env.CHATBOT_CDP_CONNECT_TIMEOUT_MS || 60000);
const STABLE_SESSION_ID_RE = /^[a-f0-9-]{20,}$/i;
const ROUTE_SESSION_ID_RE = /^(?:WEB:)?[a-f0-9-]{20,}$/i;
const SESSION_ID_RE = STABLE_SESSION_ID_RE;
const PASTE_SETTLE_MS = 1000;

function cbError(code, message, meta = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, meta);
  return error;
}
const RESPONSE_POLL_MS = 3000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 180000;
const RESPONSE_STABLE_FALLBACK_MS = 30000;
const SEND_READY_TIMEOUT_MS = 120000;
const NO_RESPONSE_RELOAD_MS = 90000;
const CONVERSATION_HYDRATION_TIMEOUT_MS = 15000;
const COMPOSER_INSERT_TIMEOUT_MS = 10000;
const PROMPT_ACCEPTED_TIMEOUT_MS = 30000;
const NEW_SESSION_ACCEPTANCE_TIMEOUT_MS = 30000;
const NEW_SESSION_ACCEPTANCE_RELOAD_TIMEOUT_MS = 15000;
const SEARCH_READY_TIMEOUT_MS = 20000;
const SEARCH_OPEN_TIMEOUT_MS = 25000;
const SEARCH_SCROLL_SETTLE_MS = 2500;
const SEARCH_BOTTOM_STABLE_MS = 5000;
const SEARCH_BOTTOM_CONFIRMATIONS_REQUIRED = 2;
const SEARCH_BOTTOM_CONFIRMATION_MAX_PROBES = 6;
const SEARCH_ALL_MAX_SCROLLS = 60;
const ARTIFACT_ROOT = path.join(OUTPUT_DIR, 'artifacts');
const SCHEDULER_DIR = path.join(OUTPUT_DIR, 'scheduler');
const QUEUE_STATE_PATH = path.join(SCHEDULER_DIR, 'queue.json');
const QUEUE_EVENTS_PATH = path.join(SCHEDULER_DIR, 'queue.jsonl');
const CONVERSATION_INDEX_PATH = path.join(SCHEDULER_DIR, 'conversation-index.json');
const CONVERSATION_EVENTS_PATH = path.join(SCHEDULER_DIR, 'conversation-index.jsonl');
const ROUND_STATE_PATH = path.join(SCHEDULER_DIR, 'rounds.json');
const ROUND_EVENTS_PATH = path.join(SCHEDULER_DIR, 'rounds.jsonl');
const LINEAGE_STATE_PATH = path.join(SCHEDULER_DIR, 'lineage.json');
const LINEAGE_EVENTS_PATH = path.join(SCHEDULER_DIR, 'lineage.jsonl');
const RECOVERY_INCIDENTS_PATH = path.join(SCHEDULER_DIR, 'recovery-incidents.json');
const RECOVERY_EVENTS_PATH = path.join(SCHEDULER_DIR, 'recovery-incidents.jsonl');
const RECOVERY_LEASES_DIR = path.join(SCHEDULER_DIR, 'recovery-leases');
const RECOVERY_ARTIFACTS_DIR = path.join(OUTPUT_DIR, 'recovery');
const SCHEDULER_LOCK_PATH = path.join(SCHEDULER_DIR, '.lock');
const BRACKETED_PASTE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_OFF = '\x1b[?2004l';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const COMMAND_PREFIXES = [
  '/attach ',
  '/model ',
  '/reasoning ',
  '/search ',
  '/search-all ',
  '/search-open ',
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
  '/search',
  '/search-all',
  '/search-open',
  '/dismiss-blocker',
  '/artifacts',
  '/download',
  '/stop',
]);
const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  '[data-testid="composer-input"]',
  'textarea[placeholder]',
  'div[contenteditable="true"]',
];
const SEND_BUTTON_SELECTORS = [
  '#composer-submit-button',
  '[data-testid="send-button"]',
  'button[aria-label="Send"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
];
const BLOCKING_MODAL_SELECTORS = [
  '#modal-settings',
  '[data-testid="modal-settings"]',
  '#modal-conversation-history-rate-limit',
  '[data-testid="modal-conversation-history-rate-limit"]',
  '#modal-subscription-failure',
  '[data-testid="modal-subscription-failure"]',
  '[id^="modal-"][id*="rate-limit"]',
  '[data-testid^="modal-"][data-testid*="rate-limit"]',
  '[id^="modal-"][id*="subscription"]',
  '[data-testid^="modal-"][data-testid*="subscription"]',
  '[id^="modal-"][id*="artifact"]',
  '[data-testid^="modal-"][data-testid*="artifact"]',
  '[id^="modal-"][id*="lightbox"]',
  '[data-testid^="modal-"][data-testid*="lightbox"]',
];
const CLICK_INTERCEPTOR_SELECTORS = [
  '[role="dialog"]',
  '[aria-modal="true"]',
  '[id^="modal-"]',
  '[data-testid*="modal"]',
  '[data-state="open"]',
];
const VOICE_CONTROL_PATTERN = `\\b(start dictation|dictation|start voice|use voice|voice mode|chat with ${TARGET_APP_BRAND_TOKEN}|microphone|mic)\\b`;
const COMPOSER_IGNORED_CONTROL_PATTERN = `\\b(add files|start dictation|dictation|start voice|use voice|voice mode|chat with ${TARGET_APP_BRAND_TOKEN}|microphone|mic)\\b`;
const MODEL_CHROME_PATTERN = `\\b(${TARGET_APP_BRAND_TOKEN} pro|search|project|history|pin|temporary|profile|account)\\b`;

function normalizeTargetAppUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url.toString();
}

function targetAppUrl(relativePath = '') {
  const cleanPath = String(relativePath || '').replace(/^\/+/, '');
  return new URL(cleanPath, TARGET_APP_BASE).toString();
}

function targetConversationUrl(sessionId) {
  return targetAppUrl(`c/${sessionId}`);
}

function isTargetAppUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.origin === TARGET_APP_BASE.origin
      && url.pathname.startsWith(TARGET_APP_BASE.pathname);
  } catch {
    return false;
  }
}

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
  --skip-failed   With --run-queue, auto-skip a blocking 'failed' job and continue
                  to the next pending job, instead of stopping. The skip is
                  journaled as 'job_skipped_auto'. Default: off (a failed job
                  still blocks until manually reset).
  --conversation  Target session id or scheduled alias. Use "current" for the active tab.
  --new-conversation
                  Start a new target app conversation before the prompt.
  --alias         Alias to assign to a new or existing conversation in the scheduler index.
  --search        Search the target app conversation/history UI and print results.
  --search-open   With --search, open a result by 1-based index or text match.
  --search-all    With --search, scroll/load until the result list stops growing.
  --search-scrolls
                  With --search, scroll to the end this many times to load more results.
  --dismiss-blocker
                  Dismiss one known safe blocker, then exit. Does not send a prompt.
  --models        Print visible model picker options and exit.
  --stop          Click the visible stop/interrupt control, if target app is generating.
  --compact-conversation, --export-context-summary
                  Export diagnostic context summary for current/specified session.
  --recovery-resend
                  Reload exact conversation URL and resend prompt in the same session (Stage 2).
  --recover-interrupted
                  Reload exact conversation URL without stopping active generation to restore composer.
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
  /search <text>  Search target app conversations/history and print results.
  /search-all <text>
                  Search and repeatedly scroll until the result list stops growing.
  /search-open <text>[ | index-or-title]
                  Search and open the first or matching result.
  /dismiss-blocker
                  Dismiss one known safe blocker. Does not send a prompt.
  /attach <path>  Attach a file to the next message.
  /artifacts      Print links/images/download controls from the latest assistant turn.
  /download       Download visible artifacts from the latest assistant turn.
  /stop           Stop the current generation if a stop/interrupt control is visible.
  /compact        Export diagnostic context summary for the active thread.
  /handoff        (Legacy/Quarantined) Compact active thread and seed Turn 1.
  /recover-interrupted
                  Reload exact conversation URL without stopping active generation to restore composer.
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
    searchQuery: '',
    searchOpen: '',
    searchAll: false,
    searchScrolls: 0,
    searchScrollsExplicit: false,
    dismissBlocker: false,
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
    skipFailed: false,
    queueLimit: 0,
    conversation: '',
    newConversation: false,
    alias: '',
    models: false,
    stop: false,
    compactConversation: false,
    handoffNewSession: false,
    recoverInterrupted: false,
    recoveryResend: false,
    recoveryIncidentId: '',
    retryEdit: '',
    editSuffix: '.',
    branchTurn: '',
    recoverBranchId: '',
    branchCarryForward: false,
    carryRequest: '',
    carryResponse: '',
    carryPrompt: '',
    lane: '',
    targetId: '',
    autoRecover: false,
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
    const peek = () => (i + 1 < argv.length ? argv[i + 1] : '');

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
    else if (arg === '--search') args.searchQuery = next();
    else if (arg === '--search-open') args.searchOpen = next();
    else if (arg === '--search-all') args.searchAll = true;
    else if (arg === '--search-scrolls') {
      args.searchScrolls = Number(next());
      args.searchScrollsExplicit = true;
    }
    else if (arg === '--dismiss-blocker') args.dismissBlocker = true;
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
    else if (arg === '--skip-failed') args.skipFailed = true;
    else if (arg === '--queue-limit') args.queueLimit = Number(next());
    else if (arg === '--conversation') args.conversation = next();
    else if (arg === '--new-conversation') args.newConversation = true;
    else if (arg === '--alias') args.alias = next();
    else if (arg === '--models') args.models = true;
    else if (arg === '--stop') args.stop = true;
    else if (arg === '--compact-conversation' || arg === '--compact' || arg === '--export-context-summary') args.compactConversation = true;
    else if (arg === '--handoff-new-session' || arg === '--compact-handoff' || arg === '--handoff') args.handoffNewSession = true;
    else if (arg === '--recovery-resend') args.recoveryResend = true;
    else if (arg === '--recovery-incident') args.recoveryIncidentId = next();
    else if (arg === '--retry-edit') {
      const val = peek();
      if (val && !val.startsWith('-')) {
        args.retryEdit = next();
      } else {
        args.retryEdit = 'latest';
      }
    }
    else if (arg === '--branch-turn') {
      const val = peek();
      if (val && !val.startsWith('-')) {
        args.branchTurn = next();
      } else {
        args.branchTurn = 'latest';
      }
    }
    else if (arg === '--recover-branch') args.recoverBranchId = next();
    else if (arg === '--branch-carry-forward') args.branchCarryForward = true;
    else if (arg === '--carry-request') args.carryRequest = next();
    else if (arg === '--carry-response') args.carryResponse = next();
    else if (arg === '--carry-prompt') args.carryPrompt = next();
    else if (arg === '--auto-recover') args.autoRecover = true;
    else if (arg === '--lane') args.lane = next();
    else if (arg === '--target-id') args.targetId = next();
    else if (arg === '--edit-suffix') args.editSuffix = next();
    else if (arg === '--recover-interrupted') args.recoverInterrupted = true;
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
  if (!Number.isInteger(args.searchScrolls) || args.searchScrolls < 0) {
    throw new Error('--search-scrolls must be zero or a positive integer');
  }
  if (args.waitReady) args.watchState = true;
  if (args.queueWatch) args.runQueue = true;
  if (args.searchOpen && !args.searchQuery) {
    throw new Error('--search-open requires --search <query>');
  }
  if ((args.searchAll || args.searchScrollsExplicit) && !args.searchQuery) {
    throw new Error('--search-all and --search-scrolls require --search <query>');
  }

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
    && !args.searchQuery
    && !args.searchOpen
    && !args.searchAll
    && !args.searchScrollsExplicit
    && !args.dismissBlocker
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

function formatTranscriptEntry(role, text, at = null) {
  const label = role === 'user' ? 'USER' : 'ASSISTANT';
  const timestamp = at || new Date().toISOString();
  return `[${timestamp}] ${label}\n${text.trim()}\n\n`;
}

function appendTranscript(filePath, role, text, at = null) {
  const entry = formatTranscriptEntry(role, text, at);
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


async function getBranchInfo(page, index = null) {
  if (!page) return null;

  // Single atomic evaluate capturing location and live DOM
  const domInfo = await page.evaluate(() => {
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

    const href = location.href;
    const pathname = location.pathname;

    // Vector 2: Divider element (scoped to outside conversation turns)
    const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
    const branchLink = Array.from(document.querySelectorAll('a[href*="/c/"]'))
      .filter(isVisible)
      .filter((a) => !a.closest('[data-testid^="conversation-turn-"]'))
      .find((a) => {
        const parentText = textOf(a.parentElement);
        const selfText = textOf(a);
        return parentText.startsWith('Branched from') || selfText.startsWith('Branched from');
      });

    let dividerData = null;
    if (branchLink) {
      let precedingTurnCount = 0;
      const postDividerTurnTestids = [];
      for (const turn of turns) {
        if (turn.compareDocumentPosition(branchLink) & 4) { // Node.DOCUMENT_POSITION_FOLLOWING
          precedingTurnCount++;
        } else {
          const testid = turn.getAttribute('data-testid');
          if (testid) postDividerTurnTestids.push(testid);
        }
      }

      const linkHref = branchLink.getAttribute('href') || '';
      const parentSessionMatch = linkHref.match(/\/c\/([a-f0-9-]+)/i);
      dividerData = {
        hasDivider: true,
        branchText: textOf(branchLink.parentElement) || textOf(branchLink),
        parentSessionId: parentSessionMatch ? parentSessionMatch[1] : '',
        precedingTurnCount,
        postDividerTurnTestids,
        totalTurns: turns.length,
      };
    }

    // Vector 3: Sidebar active title and document title
    const activeSidebarLink = document.querySelector('nav a[aria-current="page"], nav li[data-active="true"] a, nav a.bg-token-sidebar-surface-secondary');
    const sidebarTitle = activeSidebarLink ? textOf(activeSidebarLink) : '';
    const docTitle = document.title || '';

    return {
      href,
      pathname,
      dividerData,
      sidebarTitle,
      docTitle,
    };
  }).catch(() => null);

  if (!domInfo) return null;

  // Vector 1: Ephemeral route prefix (/c/WEB:<uuid>)
  const isEphemeralRoute = /\/c\/WEB:[a-f0-9-]+/i.test(domInfo.pathname);
  const ephemeralSessionId = isEphemeralRoute ? (domInfo.pathname.match(/\/c\/(WEB:[a-f0-9-]+)/i)?.[1] || '') : '';
  const routeKind = isEphemeralRoute ? 'provisional' : 'stable';

  // Title vector check (both docTitle and sidebarTitle)
  const docTitleMatch = (domInfo.docTitle || '').match(/^Branch\s*[·•\-\|]\s*(.+)$/i);
  const sidebarTitleMatch = (domInfo.sidebarTitle || '').match(/^Branch\s*[·•\-\|]\s*(.+)$/i);
  const branchTitleMatch = docTitleMatch || sidebarTitleMatch;
  const hasBranchTitlePrefix = Boolean(branchTitleMatch);
  const inferredParentTitle = branchTitleMatch ? branchTitleMatch[1].trim() : '';

  const hasDivider = Boolean(domInfo.dividerData?.hasDivider);
  // Ephemeral route alone proves provisional routing, NOT fork lineage!
  const isFork = Boolean(hasDivider || hasBranchTitlePrefix);
  if (!isFork && !isEphemeralRoute) return null;

  const detectionVectors = [];
  if (isEphemeralRoute) detectionVectors.push('ephemeral_route');
  if (hasDivider) detectionVectors.push('dom_divider');
  if (hasBranchTitlePrefix) detectionVectors.push('title_prefix');

  let parentSessionId = domInfo.dividerData?.parentSessionId || '';
  let parentResolution = domInfo.dividerData?.parentSessionId ? 'dom_divider' : 'none';
  if (parentSessionId && !STABLE_SESSION_ID_RE.test(parentSessionId)) {
    parentSessionId = '';
    parentResolution = 'none';
  }

  if (!parentSessionId && inferredParentTitle && index?.conversations) {
    const parentByTitle = index.conversations.find((c) => c.title && c.title.trim().toLowerCase() === inferredParentTitle.toLowerCase());
    if (parentByTitle?.sessionId && STABLE_SESSION_ID_RE.test(parentByTitle.sessionId)) {
      parentSessionId = parentByTitle.sessionId;
      parentResolution = 'title_heuristic';
    }
  }

  // DOM virtualization means precedingTurnCount from live DOM cannot be trusted as absolute ancestor count.
  // Unless proven by non-virtualized metadata, forkTurn must fail-closed as null so copy-on-fork does not truncate history.
  const forkTurn = null;

  return {
    isFork,
    routeKind,
    detectionVectors,
    isEphemeralRoute,
    ephemeralSessionId,
    parentSessionId,
    parentResolution,
    inferredParentTitle,
    forkTurn,
    postDividerTurnTestids: domInfo.dividerData?.postDividerTurnTestids || [],
    branchText: domInfo.dividerData?.branchText || (hasBranchTitlePrefix ? (domInfo.docTitle || domInfo.sidebarTitle) : ''),
  };
}

async function syncTranscriptFromPage(page, args, options = {}) {
  if (args.expectedSessionId) {
    await assertThreadIdentity(page, args.expectedSessionId, 'before transcript synchronization');
    if (!args.transcriptOverride) {
      args.transcript = transcriptPathForSession(args.expectedSessionId);
    }
  } else {
    refreshSessionTranscript(page, args);
  }
  ensureTranscript(args.transcript);

  const index = loadConversationIndex();
  const branchInfo = await getBranchInfo(page, index).catch(() => null);
  let transcriptText = fs.readFileSync(args.transcript, 'utf8');
  let entries = parseTranscriptEntries(transcriptText);

  // Copy-on-fork transcript seeding: strictly fail-closed
  if (entries.length === 0
    && branchInfo?.isFork
    && branchInfo.parentSessionId
    && STABLE_SESSION_ID_RE.test(branchInfo.parentSessionId)
    && Number.isInteger(branchInfo.forkTurn)
    && branchInfo.forkTurn > 0) {
    const parentTranscriptPath = transcriptPathForSession(branchInfo.parentSessionId);
    if (fs.existsSync(parentTranscriptPath)) {
      const parentText = fs.readFileSync(parentTranscriptPath, 'utf8');
      const parentEntries = parseTranscriptEntries(parentText);
      if (parentEntries.length >= branchInfo.forkTurn) {
        const seedEntries = parentEntries.slice(0, branchInfo.forkTurn);
        if (seedEntries.length > 0) {
          // Atomic write preserving ancestral timestamps
          const tempSeedPath = `${args.transcript}.seed-${Date.now()}`;
          const formattedEntries = seedEntries.map((e) => formatTranscriptEntry(e.role, e.text, e.at)).join('');
          fs.writeFileSync(tempSeedPath, formattedEntries, 'utf8');
          fs.renameSync(tempSeedPath, args.transcript);

          transcriptText = fs.readFileSync(args.transcript, 'utf8');
          entries = parseTranscriptEntries(transcriptText);
          if (options.verbose || process.env.CHATBOT_DEBUG) {
            info(`[sync] Seeded branched transcript from parent session ${branchInfo.parentSessionId} (${seedEntries.length} turns)`);
          }
        }
      } else {
        info(`[sync] Parent transcript has fewer entries (${parentEntries.length}) than forkTurn (${branchInfo.forkTurn}); skipping copy-on-fork seed to avoid partial ancestry`);
      }
    }
  }

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

  // If transcript was already seeded with ancestor turns and we have explicit post-divider turn IDs,
  // scope live sync to post-divider turns only to avoid DOM virtualization false-stale mismatches.
  if (entries.length > 0 && branchInfo?.postDividerTurnTestids?.length) {
    const postDividerSet = new Set(branchInfo.postDividerTurnTestids);
    const postDividerTurns = turns.filter((t) => postDividerSet.has(t.testid));
    if (postDividerTurns.length > 0) {
      turns = postDividerTurns;
    } else {
      info('[sync] Known post-divider turn IDs are not yet rendered in live DOM; pausing sync until mounted.');
      return { appended: 0, total: entries.length, skipped };
    }
  }

  let startIndex = findTranscriptSyncStart(entries, turns);

  if (startIndex === -1) {
    const stale = args.transcript;
    const quarantined = `${stale}.stale-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.renameSync(stale, quarantined);
      info(`[sync] Quarantined stale transcript ${path.basename(stale)} -> ${path.basename(quarantined)}`);
      ensureTranscript(args.transcript);
      entries = [];
      startIndex = 0;
    } catch (error) {
      warn(`[sync] Failed to quarantine stale transcript: ${error.message}`);
      return { appended: 0, total: entries.length, skipped };
    }
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

function routeSessionIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const cIndex = parts.indexOf('c');
    if (cIndex !== -1 && parts[cIndex + 1]) {
      const decoded = decodeURIComponent(parts[cIndex + 1]);
      if (/^WEB:[a-f0-9-]{20,}$/i.test(decoded)) {
        return decoded;
      }
      const match = decoded.match(/^(?:local-chatgpt:)?([a-f0-9-]{20,})$/i);
      if (match) {
        return match[1];
      }
    }
  } catch {}

  return '';
}

function sessionIdFromUrl(url) {
  const routeId = routeSessionIdFromUrl(url);
  return STABLE_SESSION_ID_RE.test(routeId) ? routeId : '';
}

function extractConversationId(val) {
  if (!val) return '';
  const str = String(val).trim();
  if (STABLE_SESSION_ID_RE.test(str)) return str;
  return routeSessionIdFromUrl(str) || sessionIdFromUrl(str) || str;
}

function isEphemeralRouteId(id) {
  return /^WEB:/i.test(String(id || ''));
}

function isCanonicalTargetRoot(rawUrl, targetBase = TARGET_APP_BASE) {
  try {
    const parsed = new URL(rawUrl);
    const expectedPath = targetBase.pathname.replace(/\/+$/, '') || '/';
    const actualPath = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.origin === targetBase.origin && actualPath === expectedPath && !routeSessionIdFromUrl(rawUrl);
  } catch {
    return false;
  }
}

async function assertThreadIdentity(page, expectedSessionId, phase, targetBase = TARGET_APP_BASE) {
  if (!expectedSessionId) return;

  if (!STABLE_SESSION_ID_RE.test(expectedSessionId)) {
    throw cbError(
      'INVALID_EXPECTED_SESSION',
      `Expected session is not stable: ${expectedSessionId}`,
      { expectedSessionId, phase }
    );
  }

  const rawUrl = page?.url ? page.url() : '';
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw cbError(
      'THREAD_IDENTITY_DRIFT',
      `Invalid conversation URL during ${phase}: ${rawUrl}`,
      { expectedSessionId, url: rawUrl, phase }
    );
  }

  const routeId = routeSessionIdFromUrl(rawUrl);
  const stableId = sessionIdFromUrl(rawUrl);

  if (parsed.origin !== targetBase.origin || stableId !== expectedSessionId) {
    throw cbError(
      'THREAD_IDENTITY_DRIFT',
      `Conversation identity changed during ${phase}: expectedOrigin=${targetBase.origin}, actualOrigin=${parsed.origin}, expected=${expectedSessionId}, route=${routeId || '(none)'}, url=${rawUrl}`,
      {
        expectedSessionId,
        expectedOrigin: targetBase.origin,
        actualOrigin: parsed.origin,
        actualRouteId: routeId,
        url: rawUrl,
        phase,
      }
    );
  }
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

const CONVERSATION_LEASES_DIR = path.join(SCHEDULER_DIR, 'leases');

function normalizeCdpUrl(cdpUrl) {
  try {
    const parsed = new URL(cdpUrl);
    const host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;
    return `${parsed.protocol}//${host}:${parsed.port || '9222'}`;
  } catch {
    return String(cdpUrl || DEFAULT_CDP);
  }
}

function bootstrapLeaseKey(args) {
  const normalizedCdp = normalizeCdpUrl(args.cdp || DEFAULT_CDP);
  const scope = [
    'new-chat-v1',
    TARGET_APP_BASE.origin,
    normalizedCdp,
  ].join('|');

  return crypto
    .createHash('sha256')
    .update(scope)
    .digest('hex')
    .slice(0, 24);
}

function bootstrapLeasePath(args) {
  return path.join(
    CONVERSATION_LEASES_DIR,
    `bootstrap-${bootstrapLeaseKey(args)}.lock`
  );
}

function acquireNamedLease(leasePath, payload, busyCode, busyMessage) {
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  const token = randomId('lease');
  const next = {
    ...payload,
    pid: process.pid,
    token,
    createdAt: nowIso(),
  };

  return withSchedulerLock(() => {
    try {
      const fd = fs.openSync(leasePath, 'wx');
      fs.writeFileSync(fd, JSON.stringify(next, null, 2), 'utf8');
      fs.closeSync(fd);
      return { leasePath, token };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let current = null;
      try {
        current = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
      } catch {}

      if (current?.pid && !processExists(current.pid)) {
        fs.writeFileSync(leasePath, JSON.stringify(next, null, 2), 'utf8');
        return { leasePath, token };
      }

      const holderPid = current?.pid || 'unknown';
      throw cbError(
        busyCode,
        busyMessage || `Lease is held by active process ${holderPid}`,
        {
          holderPid,
          leasePath,
        }
      );
    }
  });
}

async function getPageTargetId(page) {
  const ctx = typeof page?.context === 'function' ? page.context() : page?.context;
  if (ctx && typeof ctx.newCDPSession === 'function') {
    try {
      const session = await ctx.newCDPSession(page);
      try {
        const { targetInfo } = await session.send('Target.getTargetInfo');
        if (targetInfo?.targetId && typeof targetInfo.targetId === 'string' && targetInfo.targetId.trim()) {
          return targetInfo.targetId.trim();
        }
      } finally {
        await session.detach().catch(() => {});
      }
    } catch {}
  }
  // Fail closed in production: strict Target.getTargetInfo required.
  // Only isolated test harnesses under test runner may fall back to mocks.
  if (process.env.NODE_ENV === 'test' || typeof process.env.NODE_TEST_CONTEXT === 'string') {
    if (typeof page?._mockTargetId === 'string') return page._mockTargetId;
    if (typeof page?._targetId === 'string') return page._targetId;
    if (!ctx) return 'test-mock-target';
  }
  return null;
}

function topologyLeasePath(args) {
  const normalizedCdp = normalizeCdpUrl(args?.cdp || DEFAULT_CDP);
  const scope = ['topology-lock', TARGET_APP_BASE.origin, normalizedCdp].join('|');
  const hash = crypto.createHash('sha256').update(scope).digest('hex').slice(0, 24);
  return path.join(CONVERSATION_LEASES_DIR, `topology-${hash}.lock`);
}

function acquireTopologyLease(args, transactionId) {
  return acquireNamedLease(
    topologyLeasePath(args),
    {
      kind: 'browser_topology',
      transactionId,
      cdp: normalizeCdpUrl(args?.cdp || DEFAULT_CDP),
      targetOrigin: TARGET_APP_BASE.origin,
    },
    'BROWSER_TOPOLOGY_BUSY',
    'Another process is currently modifying browser topology (allocating tabs/windows)'
  );
}

function releaseTopologyLease(leaseHandle) {
  return releaseConversationLease(leaseHandle);
}

async function withTopologyLease(args, transactionId, fn) {
  const lease = acquireTopologyLease(args, transactionId);
  try {
    return await fn();
  } finally {
    releaseTopologyLease(lease);
  }
}

function browserLaneLeasePath(args) {
  const normalizedCdp = normalizeCdpUrl(args?.cdp || DEFAULT_CDP);
  let laneScope;
  if (args?.pageTargetId || args?.targetId) {
    const tid = args.pageTargetId || args.targetId;
    laneScope = ['page-lane', TARGET_APP_BASE.origin, normalizedCdp, tid].join('|');
  } else if (args?.expectedSessionId || args?.conversation) {
    const rawConv = args.expectedSessionId || args.conversation;
    const convId = extractConversationId(rawConv);
    laneScope = ['conversation-lane', TARGET_APP_BASE.origin, normalizedCdp, convId].join('|');
  } else if (args?.lane) {
    laneScope = ['explicit-lane', args.lane, normalizedCdp].join('|');
  } else {
    laneScope = ['bootstrap-lane', TARGET_APP_BASE.origin, normalizedCdp].join('|');
  }

  const hash = crypto
    .createHash('sha256')
    .update(laneScope)
    .digest('hex')
    .slice(0, 24);

  return path.join(CONVERSATION_LEASES_DIR, `lane-${hash}.lock`);
}

function acquireBrowserLaneLease(args, transactionId) {
  const normalizedCdp = normalizeCdpUrl(args?.cdp || DEFAULT_CDP);
  const convId = (args?.expectedSessionId || args?.conversation) ? extractConversationId(args.expectedSessionId || args.conversation) : '';
  const targetId = args?.pageTargetId || args?.targetId || '';
  return acquireNamedLease(
    browserLaneLeasePath(args),
    {
      kind: 'browser_lane',
      transactionId,
      cdp: normalizedCdp,
      conversationId: convId,
      lane: args?.lane || '',
      targetId,
      targetOrigin: TARGET_APP_BASE.origin,
    },
    'BROWSER_LANE_BUSY',
    'Another process is currently mutating or sending through this target browser lane'
  );
}

function releaseBrowserLaneLease(leaseHandle) {
  return releaseConversationLease(leaseHandle);
}

function takeBrowserLaneLease(args, operationId) {
  if (args._laneLease) {
    const lease = args._laneLease;
    args._laneLease = null;
    return lease;
  }
  return acquireBrowserLaneLease(args, operationId);
}

async function withBrowserLaneLease(args, operationId, fn) {
  const lease = takeBrowserLaneLease(args, operationId);
  try {
    return await fn();
  } finally {
    releaseBrowserLaneLease(lease);
  }
}

function acquireBootstrapLease(args, transactionId) {
  return acquireNamedLease(
    bootstrapLeasePath(args),
    {
      kind: 'new_chat_bootstrap',
      transactionId,
      targetOrigin: TARGET_APP_BASE.origin,
    },
    'BOOTSTRAP_LEASE_BUSY',
    'Another process is currently preparing a new chat on this target browser lane'
  );
}

function releaseBootstrapLease(leaseHandle) {
  return releaseConversationLease(leaseHandle);
}

function acquireConversationLease(sessionId, roundId) {
  if (!sessionId || !STABLE_SESSION_ID_RE.test(sessionId)) return null;
  const leasePath = path.join(CONVERSATION_LEASES_DIR, `${sessionId}.lock`);
  return acquireNamedLease(
    leasePath,
    {
      roundId,
      sessionId,
    },
    'CONVERSATION_LEASE_BUSY',
    `Conversation ${sessionId} is locked by active process`
  );
}

function releaseConversationLease(leaseHandle) {
  if (!leaseHandle?.leasePath || !leaseHandle?.token) return;
  const { leasePath, token } = leaseHandle;
  return withSchedulerLock(() => {
    try {
      if (fs.existsSync(leasePath)) {
        const current = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
        if (current.token === token) {
          fs.unlinkSync(leasePath);
        }
      }
    } catch {}
  });
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

function sessionIdFromSchedulerRecord(record) {
  if (!record) return '';
  return record.sessionId
    || sessionIdFromUrl(record.url || '')
    || sessionIdFromTranscriptPath(record.transcript || '')
    || '';
}

function normalizeSchedulerSessionRecord(record) {
  if (!record) return record;
  const sessionId = sessionIdFromSchedulerRecord(record);
  if (!sessionId) return { ...record };
  const normalized = {
    ...record,
    sessionId,
  };
  if (!sessionIdFromUrl(normalized.url || '')) {
    normalized.url = targetConversationUrl(sessionId);
  }
  if (!normalized.transcript) {
    normalized.transcript = transcriptPathForSession(sessionId);
  }
  return normalized;
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
      || (sessionId && item.ephemeralSessionId && item.ephemeralSessionId === sessionId)
      || (patch.ephemeralSessionId && item.sessionId === patch.ephemeralSessionId)
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
  const { suppressAlias = false, indexAlias, expectedSessionId = '', preserveTranscript = false, ...recordExtra } = extra;
  const sessionId = expectedSessionId || sessionIdFromUrl(page.url());
  if (!sessionId) return null;

  if (!preserveTranscript) {
    refreshSessionTranscript(page, args);
  }
  const title = await page.title().catch(() => '');
  const turns = await getConversationTurns(page).catch(() => []);
  const latestAssistant = [...turns].reverse()
    .find((turn) => turn.role === 'assistant' && turn.text && !isProgressOnlyText(turn.text));
  const branchInfo = await getBranchInfo(page).catch(() => null);

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
      isFork: Boolean(branchInfo?.isFork),
      parentSessionId: branchInfo?.parentSessionId || '',
      forkTurn: branchInfo?.forkTurn ?? null,
      isEphemeralRoute: Boolean(branchInfo?.isEphemeralRoute),
      ephemeralSessionId: branchInfo?.ephemeralSessionId || '',
      branchDetectionVectors: branchInfo?.detectionVectors || [],
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

function isPositivelyBoundBranch(branch, expectedParentSessionId = '') {
  if (!branch) return false;
  if (branch.status !== 'done' || branch.dispatchState !== 'bound') {
    return false;
  }
  if (!branch.childSessionId || !STABLE_SESSION_ID_RE.test(branch.childSessionId)) {
    return false;
  }
  if (expectedParentSessionId && branch.parentSessionId !== expectedParentSessionId) {
    return false;
  }
  if (branch.childSessionId === branch.parentSessionId) {
    return false;
  }
  const validParentAttest = Boolean(
    branch.parentAttestation && typeof branch.parentAttestation === 'object'
    && branch.parentAttestation.verifiedVia === 'dom_divider'
    && branch.parentAttestation.parentSessionId === branch.parentSessionId
  );
  const validLineageAttest = Boolean(
    !branch.lineageAttestation || (
      typeof branch.lineageAttestation === 'object'
      && branch.lineageAttestation.parentSessionId === branch.parentSessionId
      && (branch.lineageAttestation.parentResolution === 'dom_divider' || branch.lineageAttestation.verifiedVia === 'dom_divider')
    )
  );
  return validParentAttest && validLineageAttest;
}

function isPositivelyCompletedRound(round) {
  if (!round) return false;
  if (round.status === 'failed' || round.dispatchState === 'aborted_precommit' || round.dispatchState === 'uncertain') {
    return false;
  }
  if (round.assistantOutcome && round.assistantOutcome !== 'succeeded') {
    return false;
  }
  const isStatusDone = round.status === 'done' || round.status === 'completed';
  const isDispatchDone = round.dispatchState === 'accepted' || round.dispatchState === 'completed';
  return isStatusDone && isDispatchDone;
}

function extractRoundResponseFromTranscript(transcriptPath, round) {
  if (round?.responseText) return round.responseText;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const entries = parseTranscriptEntries(raw);
    if (!entries.length) return '';
    const text = responseAfterRound(entries, round);
    if (text) return text;
  } catch {}
  return '';
}

function registerPendingRound(args, page, message, baselineLastTurnId, extra = {}) {
  const sessionId = extra.expectedSessionId || sessionIdFromUrl(page.url());
  const transcript = args.transcript || (sessionId ? transcriptPathForSession(sessionId) : '');
  const id = extra.id || extra.roundId || args.roundId || randomId('round');
  const now = nowIso();

  return withSchedulerLock(() => {
    const state = loadRoundState();
    let existing = state.rounds.find((item) => item.id === id);
    if (existing) {
      const incomingExpectedSessionId = extra.expectedSessionId || sessionId;
      if (incomingExpectedSessionId && existing.sessionId && incomingExpectedSessionId !== existing.sessionId) {
        throw cbError('ROUND_BINDING_MISMATCH', `Reserved round "${id}" is bound to session "${existing.sessionId}", cannot rebind to "${incomingExpectedSessionId}"`);
      }
      const incomingHash = messageHash(canonicalRawPrompt(message));
      if (message && existing.messageHash && existing.messageHash !== incomingHash) {
        throw cbError('ROUND_PAYLOAD_MISMATCH', `Reserved round "${id}" is bound to message hash "${existing.messageHash}", cannot mutate to "${incomingHash}"`);
      }
      if (extra.operationKind && existing.operationKind && extra.operationKind !== existing.operationKind) {
        throw cbError('ROUND_BINDING_MISMATCH', `Reserved round "${id}" is bound to operationKind "${existing.operationKind}", cannot mutate to "${extra.operationKind}"`);
      }
      if (extra.recoveryStage && existing.recoveryStage && Number(extra.recoveryStage) !== Number(existing.recoveryStage)) {
        throw cbError('ROUND_BINDING_MISMATCH', `Reserved round "${id}" is bound to recoveryStage "${existing.recoveryStage}", cannot mutate to "${extra.recoveryStage}"`);
      }
      if (extra.recoveryIncidentId && existing.recoveryIncidentId && extra.recoveryIncidentId !== existing.recoveryIncidentId) {
        throw cbError('ROUND_BINDING_MISMATCH', `Reserved round "${id}" is bound to recoveryIncidentId "${existing.recoveryIncidentId}", cannot mutate to "${extra.recoveryIncidentId}"`);
      }
      // Non-regressive update: preserve existing dispatchState and status if already beyond prepared
      const preservedDispatchState = (existing.dispatchState && existing.dispatchState !== 'prepared')
        ? existing.dispatchState
        : (extra.dispatchState || existing.dispatchState || 'prepared');
      const preservedStatus = (existing.status && existing.status !== 'pending')
        ? existing.status
        : (extra.status || existing.status || 'pending');

      Object.assign(existing, {
        updatedAt: now,
        transcript: existing.transcript || transcript,
        baselineLastTurnId: existing.baselineLastTurnId || baselineLastTurnId,
        jobId: extra.jobId || existing.jobId || '',
        dispatchState: preservedDispatchState,
        status: preservedStatus,
      });
      saveRoundState(state);
      return existing;
    }

    const round = {
      id,
      operationKind: extra.operationKind || 'prompt',
      recoveryStage: Number(extra.recoveryStage) || 0,
      recoveryIncidentId: extra.recoveryIncidentId || '',
      sourceUserTurn: extra.sourceUserTurn || null,
      sourceAssistantTurn: extra.sourceAssistantTurn || null,
      originalMessageHash: extra.originalMessageHash || '',
      editedMessageHash: extra.editedMessageHash || '',
      editSuffix: extra.editSuffix || '',
      editAttestation: extra.editAttestation || null,
      versionBaseline: extra.versionBaseline || null,
      versionAttestation: extra.versionAttestation || null,
      assistantOutcome: extra.assistantOutcome || null,
      lastErrorCode: extra.lastErrorCode || '',
      status: 'pending',
      dispatchState: extra.dispatchState || 'prepared',
      sessionBindingState: extra.sessionBindingState || (sessionId ? 'not_applicable' : 'unbound'),
      candidateSessionId: '',
      sessionAttestation: null,
      createdAt: now,
      updatedAt: now,
      pid: process.pid,
      sessionId,
      expectedSessionId: extra.expectedSessionId || sessionId,
      jobId: extra.jobId || '',
      url: page.url(),
      transcript,
      cdp: args.cdp,
      baselineLastTurnId,
      acceptedUserTurn: extra.acceptedUserTurn || null,
      dispatchStartedAt: '',
      dispatchAcceptedAt: '',
      messageHash: messageHash(canonicalRawPrompt(message)),
      messageChars: message.length,
      messageHead: normalizeIdentityText(message).slice(0, 240),
      messageTail: normalizeIdentityText(message).slice(-240),
      responseChars: 0,
      lastError: '',
      ...extra,
    };

    state.rounds.push(round);
    saveRoundState(state);
    appendJsonl(ROUND_EVENTS_PATH, {
      type: 'round_pending',
      at: now,
      round,
    });
    return round;
  });
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

function loadLineageState() {
  if (!fs.existsSync(LINEAGE_STATE_PATH)) {
    return { version: 1, updatedAt: '', branches: [] };
  }
  try {
    const raw = fs.readFileSync(LINEAGE_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.branches)) {
      throw cbError('LINEAGE_STATE_CORRUPT', 'lineage.json has invalid branch state schema');
    }
    return parsed;
  } catch (err) {
    if (err.code === 'LINEAGE_STATE_CORRUPT') throw err;
    throw cbError('LINEAGE_STATE_CORRUPT', `Failed to parse lineage.json: ${err.message || err}`);
  }
}

function saveLineageState(state) {
  atomicWriteJson(LINEAGE_STATE_PATH, state);
}

function registerPendingBranch(args, page, sourceTurnRef, extra = {}) {
  const parentSessionId = extra.parentSessionId || sessionIdFromUrl(page.url());
  const id = extra.id || extra.branchId || args.branchId || randomId('branch');
  const now = nowIso();

  return withSchedulerLock(() => {
    const state = loadLineageState();
    let existing = state.branches.find((b) => b.id === id);
    if (existing) {
      if (existing.parentSessionId && parentSessionId && existing.parentSessionId !== parentSessionId) {
        throw cbError('BRANCH_BINDING_MISMATCH', `Reserved branch "${id}" is bound to parent session "${existing.parentSessionId}", cannot rebind to "${parentSessionId}"`);
      }
      if (existing.sourceTurnRef && sourceTurnRef && typeof existing.sourceTurnRef === 'object' && typeof sourceTurnRef === 'object') {
        const existingKey = existing.sourceTurnRef.turnKey || existing.sourceTurnRef.logicalTurnId || existing.sourceTurnRef.testid || '';
        const requestedKey = sourceTurnRef.turnKey || sourceTurnRef.logicalTurnId || sourceTurnRef.testid || '';
        if (existingKey && requestedKey && existingKey !== requestedKey) {
          throw cbError('BRANCH_BINDING_MISMATCH', `Reserved branch "${id}" source turn mismatch: expected "${existingKey}", got "${requestedKey}"`);
        }
        if (existing.sourceTurnRef.textHash && sourceTurnRef.textHash && existing.sourceTurnRef.textHash !== sourceTurnRef.textHash) {
          throw cbError('BRANCH_BINDING_MISMATCH', `Reserved branch "${id}" anchor revision hash mismatch: expected "${existing.sourceTurnRef.textHash}", got "${sourceTurnRef.textHash}"`);
        }
      }
      return existing;
    }

    const record = {
      id,
      operationKind: 'native_branch',
      recoveryStage: 3,
      recoveryIncidentId: args.recoveryIncidentId || '',
      parentSessionId,
      sourceTurnRef,
      dispatchState: 'prepared',
      status: 'pending',
      sourceUrl: page.url(),
      provisionalRoute: '',
      candidateChildSessionId: '',
      childSessionId: '',
      parentAttestation: null,
      lineageAttestation: null,
      createdAt: now,
      updatedAt: now,
      pid: process.pid,
      cdp: args.cdp,
      lastError: '',
      ...extra,
    };

    state.branches.push(record);
    saveLineageState(state);
    appendJsonl(LINEAGE_EVENTS_PATH, {
      type: 'branch_pending',
      at: now,
      branch: record,
    });
    return record;
  });
}

function updateBranchLineage(branchId, patch, eventType = 'branch_updated') {
  if (!branchId) return null;
  return withSchedulerLock(() => {
    const state = loadLineageState();
    const branch = state.branches.find((b) => b.id === branchId);
    if (!branch) return null;
    Object.assign(branch, patch, { updatedAt: nowIso() });
    saveLineageState(state);
    appendJsonl(LINEAGE_EVENTS_PATH, {
      type: eventType,
      at: branch.updatedAt,
      branch,
    });
    return branch;
  });
}

function transcriptUserEntryMatchesRound(entry, round) {
  if (!entry || entry.role !== 'user') return false;
  if (round.dispatchState === 'aborted_precommit' || round.dispatchState === 'prepared') {
    return false;
  }
  const rawHash = messageHash(canonicalRawPrompt(entry.text));
  const renderedHash = messageHash(normalizeTurnText(entry.text));
  if (round.acceptedUserTurn?.textHash) {
    return (
      rawHash === round.messageHash
      || rawHash === round.acceptedUserTurn.textHash
      || renderedHash === round.messageHash
      || renderedHash === round.acceptedUserTurn.textHash
    );
  }
  return rawHash === round.messageHash || renderedHash === round.messageHash;
}

function responseAfterRound(entries, round) {
  if (!round) return '';
  if (round.dispatchState === 'aborted_precommit' || round.dispatchState === 'prepared') {
    return '';
  }

  const matchingIndices = [];
  for (let i = 0; i < entries.length; i++) {
    if (transcriptUserEntryMatchesRound(entries[i], round)) {
      matchingIndices.push(i);
    }
  }

  if (matchingIndices.length === 0) return '';
  // Fail closed on ambiguous identical prompts
  if (matchingIndices.length > 1) {
    return '';
  }
  const userIndex = matchingIndices[0];

  const after = entries.slice(userIndex + 1);
  const nextUserIndex = after.findIndex((entry) => entry.role === 'user');
  const ownTurnWindow = nextUserIndex === -1 ? after : after.slice(0, nextUserIndex);

  return ownTurnWindow
    .filter((entry) => entry.role === 'assistant' && entry.text && !isProgressOnlyText(entry.text) && !isErrorOnlyResponseText(entry.text))
    .reduce((best, entry) => (entry.text.length >= best.length ? entry.text : best), '');
}

function reconcilePendingRoundsFromTranscript(args, options = {}) {
  const skipSessionIds = new Set(options.skipSessionIds || []);
  const transcriptExists = Boolean(args.transcript && fs.existsSync(args.transcript));
  const sessionId = transcriptExists ? sessionIdFromTranscriptPath(args.transcript) : '';
  const entries = transcriptExists ? parseTranscriptEntries(fs.readFileSync(args.transcript, 'utf8')) : [];

  return withSchedulerLock(() => {
    const state = loadRoundState();
    const completed = [];
    let changed = false;

    // Pass 1: Monotonic terminalization of dead/aborted processes independent of transcript existence
    for (const round of state.rounds) {
      if (round.status !== 'pending') continue;

      if (round.dispatchState === 'prepared' || round.dispatchState === 'preparing') {
        if (!processExists(round.pid)) {
          if (round.dispatchState === 'preparing' && round.versionProbe) {
            // Leave probed preparing round for dedicated reconcileStage1EditTurn to restore active branch!
            continue;
          }
          Object.assign(round, {
            status: 'failed',
            dispatchState: 'aborted_precommit',
            lastError: 'Process terminated before prompt dispatch commenced',
            updatedAt: nowIso(),
          });
          changed = true;
        }
        continue;
      }

      if (round.dispatchState === 'dispatching') {
        if (!processExists(round.pid)) {
          Object.assign(round, {
            dispatchState: 'uncertain',
            lastError: 'Process terminated while prompt was dispatching',
            updatedAt: nowIso(),
          });
          changed = true;
        }
      }
    }

    if (!entries.length) {
      if (changed) saveRoundState(state);
      return completed;
    }

    // Pass 2: Reconcile accepted / uncertain rounds against transcript
    for (const round of state.rounds) {
      if (round.status !== 'pending') continue;
      if (round.dispatchState === 'prepared' || round.dispatchState === 'aborted_precommit') {
        continue;
      }
      if (!roundAllowsTranscriptRecovery(round)) {
        continue;
      }
      const roundSessionId = sessionIdFromSchedulerRecord(round) || sessionId;
      if (skipSessionIds.has(roundSessionId)) continue;
      if (roundSessionId && sessionId && roundSessionId !== sessionId) continue;
      const normalizedRound = normalizeSchedulerSessionRecord({ ...round, sessionId: roundSessionId || round.sessionId });
      if (normalizedRound.sessionId && (
        round.sessionId !== normalizedRound.sessionId
        || round.url !== normalizedRound.url
        || round.transcript !== normalizedRound.transcript
      )) {
        Object.assign(round, normalizedRound, { updatedAt: nowIso() });
        changed = true;
        appendJsonl(ROUND_EVENTS_PATH, {
          type: 'round_session_backfilled',
          at: round.updatedAt,
          round,
        });
      }
      const finalResponse = responseAfterRound(entries, round);
      if (!finalResponse) continue;
      Object.assign(round, {
        status: 'done',
        dispatchState: 'accepted',
        assistantOutcome: 'succeeded',
        responseText: finalResponse,
        sessionId: roundSessionId || round.sessionId || '',
        url: sessionIdFromUrl(round.url || '') ? round.url : (roundSessionId ? targetConversationUrl(roundSessionId) : round.url || ''),
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
    if (completed.length || changed) saveRoundState(state);
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
          url: sessionId ? targetConversationUrl(sessionId) : '',
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
  const rounds = loadRoundState();
  rounds.rounds = rounds.rounds.map(normalizeSchedulerSessionRecord);
  const conversations = loadConversationIndex();
  conversations.conversations = conversations.conversations.map(normalizeSchedulerSessionRecord);
  return {
    queue: loadQueueState(),
    conversations,
    rounds,
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
  const assignPage = async (page) => {
    if (page) {
      const tid = await getPageTargetId(page);
      if (!tid) {
        throw cbError('PAGE_TARGET_ID_UNVERIFIED', 'Could not establish physical CDP target identity for selected page');
      }
      args.pageTargetId = tid;
    }
    return page;
  };

  if (args.targetId || args.pageTargetId) {
    const requestedTid = args.targetId || args.pageTargetId;
    let foundPage = null;
    for (const candidateContext of browser.contexts()) {
      for (const p of candidateContext.pages()) {
        const tid = await getPageTargetId(p);
        if (tid === requestedTid) {
          foundPage = p;
          break;
        }
      }
      if (foundPage) break;
    }
    if (!foundPage) {
      throw cbError('PAGE_TARGET_NOT_FOUND', `No page matches target ID "${requestedTid}"`);
    }
    return await assignPage(foundPage);
  }

  if (args.newTab) {
    return await withTopologyLease(args, randomId('new-tab-alloc'), async () => {
      const context = browser.contexts()[0] || await browser.newContext();
      const page = await context.newPage();
      const tid = await getPageTargetId(page);
      if (!tid) {
        throw cbError('PAGE_TARGET_ID_UNVERIFIED', 'Could not establish physical CDP target identity for new page');
      }
      args.pageTargetId = tid;
      if (!args._laneLease) {
        args._laneLease = acquireBrowserLaneLease(args, randomId('new-tab-op'));
      }
      await page.goto(targetAppUrl(), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      return page;
    });
  }

  const expectedId = args.expectedSessionId || args.conversation;
  const normalizedExpectedId = expectedId ? extractConversationId(expectedId) : null;

  if (normalizedExpectedId && STABLE_SESSION_ID_RE.test(normalizedExpectedId)) {
    const matchingPages = [];
    for (const candidateContext of browser.contexts()) {
      for (const p of candidateContext.pages()) {
        if (sessionIdFromUrl(p.url()) === normalizedExpectedId) {
          matchingPages.push(p);
        }
      }
    }
    if (matchingPages.length > 1) {
      throw cbError('PAGE_TARGET_AMBIGUOUS', `Multiple open pages match conversation "${normalizedExpectedId}". Disambiguate with --target-id.`);
    }
    if (matchingPages.length === 1) {
      return await assignPage(matchingPages[0]);
    }
    // Dedicated page under topology lease — NEVER hijack another conversation's tab!
    return await assignPage(await withTopologyLease(args, randomId('dedicated-page-alloc'), async () => {
      // Re-scan under topology lock using full count check (TOCTOU protection)
      const matchingUnderLock = [];
      for (const candidateContext of browser.contexts()) {
        for (const p of candidateContext.pages()) {
          if (sessionIdFromUrl(p.url()) === normalizedExpectedId) {
            matchingUnderLock.push(p);
          }
        }
      }
      if (matchingUnderLock.length > 1) {
        throw cbError('PAGE_TARGET_AMBIGUOUS', `Multiple open pages match conversation "${normalizedExpectedId}". Disambiguate with --target-id.`);
      }
      if (matchingUnderLock.length === 1) {
        return matchingUnderLock[0];
      }
      const context = browser.contexts()[0] || await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${TARGET_APP_BASE.origin}/c/${normalizedExpectedId}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      return page;
    }));
  }

  for (const candidateContext of browser.contexts()) {
    const page = candidateContext.pages().find((candidate) => isTargetAppUrl(candidate.url()));
    if (page) return await assignPage(page);
  }

  return await withTopologyLease(args, randomId('fallback-page-alloc'), async () => {
    const context = browser.contexts()[0] || await browser.newContext();
    const page = await context.newPage();
    const tid = await getPageTargetId(page);
    if (!tid) {
      throw cbError('PAGE_TARGET_ID_UNVERIFIED', 'Could not establish physical CDP target identity for fallback page');
    }
    args.pageTargetId = tid;
    if (!args._laneLease) {
      args._laneLease = acquireBrowserLaneLease(args, randomId('fallback-page-op'));
    }
    await page.goto(targetAppUrl(), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    return page;
  });
}

async function getConversationTurns(page) {
  const turns = await page.evaluate(() => {
    const textOf = (el) => {
      if (!el) return '';
      const clone = el.cloneNode(true);
      clone.querySelectorAll('button, [role="button"]').forEach((b) => b.remove());
      return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
    };
    let classicEls = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')];
    if (classicEls.length) {
      return classicEls
        .map((turn, index) => {
          const roleEls = turn.matches('[data-message-author-role]')
            ? [turn]
            : [...turn.querySelectorAll('[data-message-author-role]')];
          let role = roleEls[0]?.getAttribute('data-message-author-role')
            || turn.getAttribute('data-turn')
            || '';
          const roleTexts = roleEls.map(textOf).filter(Boolean);
          const messageId = turn.getAttribute('data-message-id')
            || roleEls.find((el) => el.getAttribute('data-message-id'))?.getAttribute('data-message-id')
            || turn.querySelector('[data-message-id]')?.getAttribute('data-message-id')
            || '';
          return {
            index,
            testid: turn.getAttribute('data-testid') || '',
            messageId,
            role,
            text: roleTexts[0] || textOf(turn),
            roleTexts,
            turnText: textOf(turn),
          };
        })
        .filter((turn) => turn.role && (turn.text || turn.turnText));
    }

    const turnKeyEls = [...document.querySelectorAll('[data-turn-key]')];
    const extracted = [];
    let idx = 0;
    for (const roundEl of turnKeyEls) {
      const turnKey = roundEl.getAttribute('data-turn-key') || '';

      // Separate DOM subtrees: ensure assistant root is disjoint from user subtree
      const userUnit = roundEl.querySelector('[data-chatgpt-search-unit-key*=":user"], [data-content-search-unit-key*=":user"], [data-user-message-bubble="true"]');
      const candidateAsstUnits = [...roundEl.querySelectorAll('[data-chatgpt-search-unit-key*=":assistant"], [data-content-search-unit-key*=":assistant"], [data-message-author-role="assistant"]')];
      let asstUnit = candidateAsstUnits.find(u => !userUnit || (!userUnit.contains(u) && !u.contains(userUnit))) || null;
      if (!asstUnit) {
        const candidateMarkdowns = [...roundEl.querySelectorAll('.markdown')];
        asstUnit = candidateMarkdowns.find(m => !userUnit || (!userUnit.contains(m) && !m.contains(userUnit))) || null;
      }

      const userMessageId = (userUnit?.getAttribute('data-chatgpt-search-message-ids') || userUnit?.getAttribute('data-message-id') || '').split(' ')[0];
      const asstMessageId = (asstUnit?.getAttribute('data-chatgpt-search-message-ids') || asstUnit?.getAttribute('data-message-id') || '').split(' ')[0];

      const cleanTextOf = (el) => {
        if (!el) return '';
        const clone = el.cloneNode(true);
        clone.querySelectorAll('[role="separator"], button, [role="button"], .sr-only, h4.sr-only').forEach((b) => b.remove());
        clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
        clone.querySelectorAll('p, div, li, tr').forEach(block => {
          block.prepend('\n');
          block.append('\n');
        });
        return (clone.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
      };

      const userText = cleanTextOf(userUnit);
      const asstText = cleanTextOf(asstUnit);

      if (userText) {
        extracted.push({
          index: idx++,
          testid: `user-${turnKey}`,
          logicalTurnId: `user:${turnKey}`,
          turnKey,
          messageId: userMessageId || '',
          role: 'user',
          text: userText,
          turnText: userText,
        });
      }
      if (asstText) {
        extracted.push({
          index: idx++,
          testid: `asst-${turnKey}`,
          logicalTurnId: `assistant:${turnKey}`,
          turnKey,
          messageId: asstMessageId || '',
          role: 'assistant',
          text: asstText,
          turnText: asstText,
        });
      }
    }
    return extracted;
  });
  return turns
    .map((turn) => ({
      index: turn.index,
      testid: turn.testid,
      logicalTurnId: turn.logicalTurnId || `${turn.role}:${turn.turnKey || turn.testid}`,
      turnKey: turn.turnKey || '',
      messageId: turn.messageId || '',
      role: turn.role,
      text: turn.role === 'assistant'
        ? assistantResponseText(turn.roleTexts?.length ? turn.roleTexts : turn.text, turn.turnText)
        : turn.text,
    }))
    .filter((turn) => turn.role && turn.text);
}

function turnRef(turn) {
  return {
    logicalTurnId: turn?.logicalTurnId || '',
    turnKey: turn?.turnKey || '',
    messageId: turn?.messageId || '',
    testid: turn?.testid || '',
    role: turn?.role || '',
    textHash: messageHash(normalizeTurnText(turn?.text || '')),
  };
}

function turnMatchesRef(turn, ref) {
  if (!turn || !ref) return false;
  if (ref.messageId && turn.messageId) {
    return ref.messageId === turn.messageId;
  }
  if (ref.testid && ref.textHash) {
    return turn.testid === ref.testid && messageHash(normalizeTurnText(turn.text)) === ref.textHash;
  }
  return Boolean(ref.textHash && messageHash(normalizeTurnText(turn.text)) === ref.textHash);
}

function turnRevisionMatchesRef(turn, ref) {
  if (!turn || !ref) return false;
  const hashMatches = !ref.textHash || messageHash(normalizeTurnText(turn.text)) === ref.textHash;
  if (ref.messageId && turn.messageId) {
    return turn.messageId === ref.messageId && hashMatches;
  }
  if (ref.testid) {
    return turn.testid === ref.testid && hashMatches;
  }
  return Boolean(ref.textHash && hashMatches);
}

function responseAfterAcceptedTurnExcludingRevision(turns, acceptedUserTurnRef, priorAssistantTurnRef) {
  if (!acceptedUserTurnRef) {
    return { text: '', assistantTurn: null, userTurnMissing: false, concurrentUserTurn: null };
  }

  // Use revision-aware matching: require BOTH message identity and revision text hash to match
  const userIndex = turns.findIndex((turn) =>
    turn.role === 'user' && turnRevisionMatchesRef(turn, acceptedUserTurnRef)
  );

  if (userIndex === -1) {
    return {
      text: '',
      assistantTurn: null,
      userTurnMissing: true,
      concurrentUserTurn: null,
    };
  }

  let outcome = null;
  for (let i = userIndex + 1; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role === 'user') {
      outcome = {
        text: '',
        assistantTurn: null,
        userTurnMissing: false,
        concurrentUserTurn: turn,
      };
      break;
    }
    if (turn.role === 'assistant') {
      outcome = {
        text: isProgressOnlyText(turn.text) ? '' : turn.text,
        assistantTurn: turn,
        userTurnMissing: false,
        concurrentUserTurn: null,
      };
      break;
    }
  }

  if (!outcome) {
    outcome = {
      text: '',
      assistantTurn: null,
      userTurnMissing: false,
      concurrentUserTurn: null,
    };
  }

  if (priorAssistantTurnRef && outcome.assistantTurn) {
    if (sameTurnRevision(outcome.assistantTurn, priorAssistantTurnRef)) {
      return {
        ...outcome,
        text: '',
        assistantTurn: null,
      };
    }
  }
  return outcome;
}

function responseAfterAcceptedTurn(turns, acceptedUserTurnRef) {
  if (!acceptedUserTurnRef) {
    return { text: '', assistantTurn: null, userTurnMissing: false, concurrentUserTurn: null };
  }

  const userIndex = turns.findIndex((turn) =>
    turn.role === 'user' && turnMatchesRef(turn, acceptedUserTurnRef)
  );

  if (userIndex === -1) {
    return {
      text: '',
      assistantTurn: null,
      userTurnMissing: true,
      concurrentUserTurn: null,
    };
  }

  for (let i = userIndex + 1; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role === 'user') {
      return {
        text: '',
        assistantTurn: null,
        userTurnMissing: false,
        concurrentUserTurn: turn,
      };
    }
    if (turn.role === 'assistant') {
      return {
        text: isProgressOnlyText(turn.text) ? '' : turn.text,
        assistantTurn: turn,
        userTurnMissing: false,
        concurrentUserTurn: null,
      };
    }
  }

  return {
    text: '',
    assistantTurn: null,
    userTurnMissing: false,
    concurrentUserTurn: null,
  };
}

async function getAssistantTurns(page) {
  return (await getConversationTurns(page)).filter((turn) => turn.role === 'assistant');
}

async function findComposer(page) {
  for (const selector of COMPOSER_SELECTORS) {
    const locator = page.locator(selector).last();
    try {
      await locator.waitFor({ state: 'visible', timeout: 3000 });
      return locator;
    } catch {}
  }

  throw new Error('No visible target app composer input found');
}

async function findComposerRootLocator(page, composerLocator) {
  if (!composerLocator) return page;
  try {
    const form = composerLocator.locator('xpath=ancestor::form[1]');
    if ((await form.count().catch(() => 0)) > 0) return form;
    const composerDiv = composerLocator.locator('xpath=ancestor::*[@data-testid and contains(@data-testid, "composer")][1]');
    if ((await composerDiv.count().catch(() => 0)) > 0) return composerDiv;
    return composerLocator.locator('..');
  } catch {
    return composerLocator.locator('..');
  }
}

async function getSendButtonState(page, composerLocator = null) {
  // If page.evaluate mock is returned in test environment
  if (page && typeof page.evaluate === 'function' && (!composerLocator || !composerLocator.locator)) {
    try {
      const evalRes = await page.evaluate((sendButtonSelectors) => {
        const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        const buttons = [...document.querySelectorAll(sendButtonSelectors.join(','))].filter(isVisible);
        if (!buttons.length) return { exists: false, disabled: false, count: 0, label: '' };
        if (buttons.length > 1) {
          return { exists: true, ambiguous: true, count: buttons.length, disabled: false, label: '' };
        }
        const b = buttons[0];
        return {
          exists: true,
          ambiguous: false,
          count: 1,
          disabled: Boolean(b.disabled || b.getAttribute('aria-disabled') === 'true'),
          label: [b.getAttribute('data-testid') || '', b.getAttribute('aria-label') || '', b.innerText || ''].join(' ').trim(),
        };
      }, SEND_BUTTON_SELECTORS);
      if (evalRes && typeof evalRes === 'object') return evalRes;
    } catch {}
  }

  const root = await findComposerRootLocator(page, composerLocator);
  if (!root || typeof root.locator !== 'function') {
    throw cbError('COMPOSER_ROOT_UNRESOLVED', 'Unable to resolve composer root container');
  }
  const candidateLocator = root.locator(SEND_BUTTON_SELECTORS.join(', '));

  const count = await candidateLocator.count().catch(() => 0);
  if (count === 0) return { exists: false, count: 0, disabled: false, label: '' };

  let visibleCount = 0;
  let singleVisible = null;
  for (let i = 0; i < count; i++) {
    const btn = candidateLocator.nth(i);
    if (await btn.isVisible().catch(() => false)) {
      visibleCount++;
      singleVisible = btn;
    }
  }

  if (visibleCount === 0) return { exists: false, count: 0, disabled: false, label: '' };
  if (visibleCount > 1) {
    return { exists: true, ambiguous: true, count: visibleCount, disabled: false, label: '' };
  }

  // Treat inspection failure as disabled (fail closed)
  const disabled = (await singleVisible.isDisabled().catch(() => true))
    || (await singleVisible.getAttribute('aria-disabled').catch(() => 'true')) === 'true';
  const label = (await singleVisible.getAttribute('aria-label').catch(() => ''))
    || (await singleVisible.getAttribute('data-testid').catch(() => ''))
    || (await singleVisible.innerText().catch(() => ''));

  return {
    exists: true,
    ambiguous: false,
    count: 1,
    disabled,
    locator: singleVisible,
    label,
  };
}

async function waitForSendReady(page, composerLocatorOrTimeout = null, timeoutArg = SEND_READY_TIMEOUT_MS) {
  let composerLocator = null;
  let timeout = timeoutArg;
  if (typeof composerLocatorOrTimeout === 'number') {
    timeout = composerLocatorOrTimeout;
  } else if (composerLocatorOrTimeout) {
    composerLocator = composerLocatorOrTimeout;
  }

  const start = Date.now();
  let lastState = null;
  let lastButton = null;

  while (Date.now() - start < timeout) {
    lastButton = await getSendButtonState(page, composerLocator);
    lastState = await getTargetAppState(page).catch(() => null);
    if (lastState?.blockingModal) {
      await ensureNoBlockingModal(page, 'while waiting for the send button');
    }
    if (lastButton.exists && !lastButton.disabled && !lastButton.ambiguous) {
      return { button: lastButton, locator: lastButton.locator, state: lastState };
    }
    await page.waitForTimeout(1000);
  }

  if (lastButton?.ambiguous) {
    throw cbError('COMPOSER_SUBMIT_CONTROL_AMBIGUOUS', `Found ${lastButton.count} candidate send buttons in composer`);
  }
  if (!lastButton?.exists) {
    throw cbError('COMPOSER_SUBMIT_CONTROL_UNVERIFIED', `Send button control could not be located in composer after ${timeout}ms`);
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
  return page.evaluate((composerIgnoredControlPattern) => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || el?.value || '').replace(/\s+/g, ' ').trim();
    const ignoredControlRe = new RegExp(composerIgnoredControlPattern, 'i');
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
          if (ignoredControlRe.test(joined)) return false;
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
  }, COMPOSER_IGNORED_CONTROL_PATTERN).catch(() => ({
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
  const normState = normalizeTurnText(state?.text || '');
  const normMsg = normalizeTurnText(message);
  if (normState === normMsg || (normMsg.length && normState.startsWith(normMsg) && normState.length === normMsg.length)) {
    return { ok: true, kind: 'composer_text' };
  }
  // For long prompts (>= 1000 chars), ProseMirror collapses whitespace/markdown rendering.
  // Match using normalized head and tail!
  if (normMsg.length >= 1000 && normState.length >= 500) {
    const head = normMsg.slice(0, 150);
    const tail = normMsg.slice(-150);
    if (normState.includes(head) && normState.includes(tail)) {
      return { ok: true, kind: 'composer_text_head_tail' };
    }
  }
  // Handle long prompts that ChatGPT auto-converts into composer attachments
  if (normMsg.length >= 1000 && state?.attachments && state.attachments.length) {
    const firstLine = normalizeTurnText(message.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '').slice(0, 30);
    const hasPastedAttachment = state.attachments.some((att) => {
      const attText = normalizeTurnText(att.text || att.title || att.aria || '').toLowerCase();
      return attText.includes('pasted text') || (firstLine && attText.includes(firstLine.toLowerCase()));
    });
    if (hasPastedAttachment) {
      return { ok: true, kind: 'composer_attachment' };
    }
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
    await ensureNoBlockingModal(page, 'while verifying inserted prompt text');
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

async function waitForPromptAccepted(page, message, baselineLastTurnId, timeout = PROMPT_ACCEPTED_TIMEOUT_MS, options = {}) {
  const { expectedSessionId = '' } = options;
  const start = Date.now();
  let lastTurns = [];
  let lastComposer = null;

  while (Date.now() - start < timeout) {
    if (expectedSessionId) {
      await assertThreadIdentity(page, expectedSessionId, 'while awaiting prompt acceptance');
    }
    await ensureNoBlockingModal(page, 'while verifying the prompt was accepted');
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

async function waitForSessionIdInUrl(page, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    const id = sessionIdFromUrl(page.url());
    if (id) return id;
    await page.waitForTimeout(250);
  }
  return '';
}

async function confirmNewConversationAccepted(page, message, baselineLastTurnId) {
  const existingSessionId = sessionIdFromUrl(page.url());
  if (existingSessionId) {
    return { sessionId: existingSessionId, reloaded: false };
  }

  const sessionId = await waitForSessionIdInUrl(page, NEW_SESSION_ACCEPTANCE_TIMEOUT_MS);
  if (sessionId) return { sessionId, reloaded: false };

  // Fail closed without reload or resend to prevent stream detachment
  const turns = await getConversationTurns(page).catch(() => []);
  const userTurn = findUserTurnAfterBaseline(turns, message, baselineLastTurnId);
  const state = await getTargetAppState(page).catch(() => null);
  const generation = await getCombinedGenerationState(page, state).catch(() => ({ isGenerating: false }));
  throw cbError(
    'NEW_SESSION_ID_UNCERTAIN',
    `Prompt was accepted into new conversation, but target app did not assign a stable session id after ${NEW_SESSION_ACCEPTANCE_TIMEOUT_MS}ms. User turn visible: ${userTurn ? 'yes' : 'no'}. Generating: ${generation.isGenerating ? 'yes' : 'no'}. Retaining without reload to prevent stream detachment.`
  );
}

async function sendMessage(page, message, baselineLastTurnId = '', options = {}) {
  const { expectedSessionId = '', roundId = '', requireNewChatRoot = false } = options;
  if (requireNewChatRoot) {
    assertNewChatBootstrapRoute(page);
  } else if (expectedSessionId) {
    await assertThreadIdentity(page, expectedSessionId, 'before finding the composer');
  }

  await ensureNoBlockingModal(page, 'before finding the composer');
  const composer = await findComposer(page);
  try {
    await ensureTargetClickable(page, COMPOSER_SELECTORS, 'composer', 'before focusing the composer', { preferLast: true });
    await composer.click({ timeout: 10000 });
  } catch (error) {
    const modal = await getBlockingModal(page);
    if (modal) throw new Error(blockingModalErrorMessage(modal, 'while focusing the composer'));
    throw error;
  }
  await page.keyboard.insertText(message);
  await waitForComposerInsertion(page, message);

  if (requireNewChatRoot) {
    assertNewChatBootstrapRoute(page);
  } else if (expectedSessionId) {
    await assertThreadIdentity(page, expectedSessionId, 'after composer insertion');
  }

  let ready;
  try {
    ready = await waitForSendReady(page, composer);
  } catch (precommitError) {
    if (roundId) {
      updateRound(roundId, {
        status: 'failed',
        dispatchState: 'aborted_precommit',
        lastError: precommitError.message || String(precommitError),
      }, 'round_aborted');
    }
    throw precommitError;
  }

  if (requireNewChatRoot) {
    assertNewChatBootstrapRoute(page);
  } else if (expectedSessionId) {
    await assertThreadIdentity(page, expectedSessionId, 'before dispatching prompt');
  }

  if (roundId) {
    updateRound(roundId, {
      dispatchState: 'dispatching',
      dispatchStartedAt: nowIso(),
    }, 'round_dispatching');
  }

  let acceptedUserTurn;
  try {
    await ensureTargetClickable(page, SEND_BUTTON_SELECTORS, 'send button', 'before clicking the send button');
    if (requireNewChatRoot) {
      assertNewChatBootstrapRoute(page);
    } else if (expectedSessionId) {
      await assertThreadIdentity(page, expectedSessionId, 'immediately before click dispatch');
    }
    const buttonLocator = ready.locator || page.locator(SEND_BUTTON_SELECTORS.join(', ')).first();
    await buttonLocator.click({ timeout: 5000 });

    await page.waitForTimeout(700);
    acceptedUserTurn = await waitForPromptAccepted(page, message, baselineLastTurnId, PROMPT_ACCEPTED_TIMEOUT_MS, { expectedSessionId });
  } catch (error) {
    if (roundId) {
      updateRound(roundId, {
        dispatchState: 'uncertain',
        lastError: error.message || String(error),
      }, 'round_dispatch_uncertain');
    }
    throw cbError(
      'DISPATCH_UNCERTAIN',
      `Prompt dispatch may have committed: ${error.message || error}`,
      { expectedSessionId, roundId, causeCode: error.code || '', causeMessage: error.message || String(error) }
    );
  }

  const ref = turnRef(acceptedUserTurn);
  if (roundId) {
    updateRound(roundId, {
      dispatchState: 'accepted',
      dispatchAcceptedAt: nowIso(),
      acceptedUserTurn: ref,
    }, 'round_dispatch_accepted');
  }

  return acceptedUserTurn;
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

function canonicalRawPrompt(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

function roundAllowsTranscriptRecovery(round) {
  if (!round) return false;
  const stable = Boolean(round.sessionId && STABLE_SESSION_ID_RE.test(round.sessionId));
  const state = round.sessionBindingState;
  if (!state) {
    return stable;
  }
  if (state === 'not_applicable' || state === 'attested') {
    return stable;
  }
  return false;
}

function normalizeIdentityText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/(?:Show more|Show less)\s*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePromptForRenderedComparison(text) {
  return normalizeIdentityText(text)
    .replace(/[`*_#~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTurnText(text) {
  return normalizeIdentityText(text);
}

function terminalErrorForAwaitedTurn(pageState, outcome, acceptedUserTurnRef) {
  if (!pageState?.latestAssistant?.errorText) return null;
  if (!acceptedUserTurnRef) return pageState.latestAssistant.errorText;
  if (outcome?.assistantTurn && pageState.latestAssistant.testid === outcome.assistantTurn.testid) {
    return pageState.latestAssistant.errorText;
  }
  return null;
}

function isErrorOnlyResponseText(text) {
  const value = normalizeTurnText(text);
  if (!value || value.length > 1000) return false;
  return (/^something went wrong\b/i.test(value) && (/\bretry\b/i.test(value) || /help\.openai\.com/i.test(value)))
    || /^internal server error\b/i.test(value)
    || /^there was an error generating (?:a )?response\b/i.test(value)
    || /^error generating (?:a )?response\b/i.test(value)
    || /^message stream error\b/i.test(value);
}

function isProgressOnlyText(text) {
  const normalized = normalizeTurnText(text).replace(/[.。…]+$/g, '').trim();
  if (!normalized) return true;
  if (normalized.length > 180) return false;

  return normalized.toLowerCase() === TARGET_APP_BRAND_TOKEN
    || /^(?:(?:pro\s+)?thinking|finalizing answer|looking for available tools|called tool)$/i.test(normalized)
    || /^thought for (?:a couple of seconds|\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes))(?:\s*[›>])?(?:\s+edit)?$/i.test(normalized)
    || /^(searching|searched|reading|analyzing|working|creating|generating|running|uploading|processing|finalizing)(?:\s+(?:answer|response|file|image|results?|the web|online|tool|tools?))?$/i.test(normalized)
    || /^using (?:a |the )?.{1,80}\btool$/i.test(normalized)
    || /connection interrupted.*waiting for the complete answer|waiting for the complete answer/i.test(normalized);
}

function blockingModalKindFromMeta(meta) {
  const joined = [
    meta?.id || '',
    meta?.testid || '',
    meta?.role || '',
    meta?.aria || '',
    meta?.title || '',
    meta?.text || '',
  ].join(' ');
  if (/conversation-history-rate-limit|conversation\s+history.*rate\s+limit|rate\s+limit|too many requests|limit reached/i.test(joined)) {
    return 'conversation_history_rate_limit';
  }
  if (/modal-subscription-failure|subscription|plan limit/i.test(joined)) {
    return 'subscription_modal';
  }
  if (/modal-settings|settings|personalization|custom instructions|base style and tone/i.test(joined)) {
    return 'settings_modal';
  }
  if (/\b(artifact|lightbox|image preview|media preview)\b/i.test(joined)) {
    return 'artifact_lightbox';
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

function clickableBlockerErrorMessage(blocker, context) {
  const modal = blocker?.modal || blocker;
  const target = blocker?.target?.label ? `${blocker.target.label} ` : '';
  return blockingModalErrorMessage(modal, `${context}; ${target}center is covered`);
}

async function getBlockingModal(page) {
  return page.evaluate((selectors) => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const kindOf = (meta) => {
      const joined = [meta.id || '', meta.testid || '', meta.role || '', meta.aria || '', meta.title || '', meta.text || ''].join(' ');
      if (/conversation-history-rate-limit|conversation\s+history.*rate\s+limit|rate\s+limit|too many requests|limit reached/i.test(joined)) {
        return 'conversation_history_rate_limit';
      }
      if (/modal-subscription-failure|subscription|plan limit/i.test(joined)) {
        return 'subscription_modal';
      }
      if (/modal-settings|settings|personalization|custom instructions|base style and tone/i.test(joined)) {
        return 'settings_modal';
      }
      if (/\b(artifact|lightbox|image preview|media preview)\b/i.test(joined)) {
        return 'artifact_lightbox';
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
          aria: modal.getAttribute('aria-label') || candidate.getAttribute('aria-label') || '',
          title: modal.getAttribute('title') || candidate.getAttribute('title') || '',
          text: textOf(modal),
        };
        return { ...result, kind: kindOf(result) };
      }
    }

    return null;
  }, BLOCKING_MODAL_SELECTORS).catch(() => null);
}

async function dismissBlockingModal(page) {
  const candidate = await page.evaluate((selectors) => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const kindOf = (meta) => {
      const joined = [meta.id || '', meta.testid || '', meta.role || '', meta.aria || '', meta.title || '', meta.text || ''].join(' ');
      if (/conversation-history-rate-limit|conversation\s+history.*rate\s+limit|rate\s+limit|too many requests|limit reached/i.test(joined)) {
        return 'conversation_history_rate_limit';
      }
      if (/modal-subscription-failure|subscription|plan limit/i.test(joined)) {
        return 'subscription_modal';
      }
      if (/modal-settings|settings|personalization|custom instructions|base style and tone/i.test(joined)) {
        return 'settings_modal';
      }
      if (/\b(artifact|lightbox|image preview|media preview)\b/i.test(joined)) {
        return 'artifact_lightbox';
      }
      return 'blocking_modal';
    };
    const isSafe = (meta) => {
      const joined = [meta.id || '', meta.testid || '', meta.aria || '', meta.title || '', meta.text || ''].join(' ');
      return /modal-subscription-failure/i.test(joined)
        || /\b(artifact|lightbox|image preview|media preview)\b/i.test(joined);
    };
    const unsafeAction = (el) => /\b(update payment|upgrade|log in|login|sign in|captcha|delete|remove|confirm|continue|subscribe|buy|purchase|pay)\b/i.test([
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      textOf(el),
    ].join(' '));
    const metaOf = (modal, candidateEl) => {
      const result = {
        id: modal.id || candidateEl.id || '',
        testid: modal.getAttribute('data-testid') || candidateEl.getAttribute('data-testid') || '',
        role: modal.getAttribute('role') || '',
        ariaModal: modal.getAttribute('aria-modal') || '',
        aria: modal.getAttribute('aria-label') || candidateEl.getAttribute('aria-label') || '',
        title: modal.getAttribute('title') || candidateEl.getAttribute('title') || '',
        text: textOf(modal),
      };
      return { ...result, kind: kindOf(result) };
    };

    for (const selector of selectors) {
      for (const candidateEl of document.querySelectorAll(selector)) {
        const modal = candidateEl.closest('[role="dialog"],[aria-modal="true"],[id^="modal-"],[data-testid^="modal-"]') || candidateEl;
        if (!isVisible(modal)) continue;
        const modalMeta = metaOf(modal, candidateEl);
        if (!isSafe(modalMeta)) return { found: true, safe: false, modal: modalMeta };

        const controls = [
          ...modal.querySelectorAll('button[aria-label="Close"], [role="button"][aria-label="Close"]'),
          ...[...modal.querySelectorAll('button')].filter((button) => /^close$/i.test(textOf(button))),
        ].filter((control, index, list) => list.indexOf(control) === index)
          .filter(isVisible)
          .filter((control) => !unsafeAction(control));
        const marker = `cb-dismiss-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        if (controls[0]) {
          controls[0].setAttribute('data-cb-dismiss-blocker', marker);
          return {
            found: true,
            safe: true,
            modal: modalMeta,
            closeSelector: `[data-cb-dismiss-blocker="${marker}"]`,
          };
        }

        return { found: true, safe: true, modal: modalMeta, closeSelector: '' };
      }
    }

    return { found: false, safe: false, modal: null, closeSelector: '' };
  }, BLOCKING_MODAL_SELECTORS).catch((error) => ({
    found: false,
    safe: false,
    modal: null,
    closeSelector: '',
    error: error.message || String(error),
  }));

  if (!candidate?.found) return { dismissed: false, found: false, reason: candidate?.error || 'no blocker' };
  if (!candidate.safe) return { dismissed: false, found: true, modal: candidate.modal, reason: 'not safe to dismiss automatically' };

  let clicked = false;
  if (candidate.closeSelector) {
    clicked = await page.locator(candidate.closeSelector).click({ timeout: 5000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(300);
  }

  const beforeEscape = await getBlockingModal(page);
  if (beforeEscape) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  }

  const remaining = await getBlockingModal(page);
  return {
    dismissed: !remaining,
    found: true,
    safe: true,
    clicked,
    escaped: Boolean(beforeEscape),
    modal: candidate.modal,
    remaining,
  };
}

function printBlockingDismissal(result, jsonl = false) {
  const payload = {
    type: 'target_app_blocker_dismissal',
    at: nowIso(),
    dismissed: Boolean(result.dismissed),
    found: Boolean(result.found),
    safe: Boolean(result.safe),
    clicked: Boolean(result.clicked),
    escaped: Boolean(result.escaped),
    reason: result.reason || '',
    modal: result.modal || null,
    remaining: result.remaining || null,
  };
  if (jsonl) {
    console.log(JSON.stringify(payload));
    return;
  }

  if (!payload.found) {
    console.log('No blocking modal found.');
  } else if (!payload.safe) {
    console.log(`Blocking modal is not safe to dismiss automatically: ${blockingModalSummary(payload.modal)}`);
    if (payload.reason) console.log(`Reason: ${payload.reason}`);
  } else if (payload.dismissed) {
    const actions = [
      payload.clicked ? 'clicked close control' : '',
      payload.escaped ? 'pressed Escape' : '',
    ].filter(Boolean).join(', ') || 'dismissed';
    console.log(`Dismissed blocking modal: ${blockingModalSummary(payload.modal)}`);
    console.log(`Action: ${actions}`);
  } else {
    console.log(`Blocking modal remains: ${blockingModalSummary(payload.remaining || payload.modal)}`);
    if (payload.reason) console.log(`Reason: ${payload.reason}`);
  }
}

async function assertNoBlockingModal(page, context) {
  const modal = await getBlockingModal(page);
  if (modal) throw new Error(blockingModalErrorMessage(modal, context));
  return null;
}

async function ensureNoBlockingModal(page, context) {
  let modal = await getBlockingModal(page);
  if (!modal) return null;

  const dismiss = await dismissBlockingModal(page);
  modal = await getBlockingModal(page);
  if (!modal) return dismiss;
  throw new Error(blockingModalErrorMessage(modal, context));
}

async function getCenterPointClickBlocker(page, selectors, label, options = {}) {
  return page.evaluate(({ selectors: selectorList, interceptorSelectors, label: targetLabel, preferLast }) => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || el?.value || '').replace(/\s+/g, ' ').trim();
    const kindOf = (meta) => {
      const joined = [meta.id || '', meta.testid || '', meta.role || '', meta.aria || '', meta.title || '', meta.text || ''].join(' ');
      if (/conversation-history-rate-limit|conversation\s+history.*rate\s+limit|rate\s+limit|too many requests|limit reached/i.test(joined)) {
        return 'conversation_history_rate_limit';
      }
      if (/modal-subscription-failure|subscription|plan limit/i.test(joined)) {
        return 'subscription_modal';
      }
      if (/modal-settings|settings|personalization|custom instructions|base style and tone/i.test(joined)) {
        return 'settings_modal';
      }
      if (/\b(artifact|lightbox|image preview|media preview)\b/i.test(joined)) {
        return 'artifact_lightbox';
      }
      return 'blocking_modal';
    };
    const metaOf = (el) => {
      const result = {
        id: el.id || '',
        testid: el.getAttribute('data-testid') || '',
        role: el.getAttribute('role') || '',
        ariaModal: el.getAttribute('aria-modal') || '',
        aria: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        text: textOf(el),
      };
      return { ...result, kind: kindOf(result) };
    };

    const targets = selectorList.flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter((el, index, list) => list.indexOf(el) === index)
      .filter(isVisible);
    const target = preferLast ? targets[targets.length - 1] : targets[0];
    if (!target) {
      return {
        blocked: false,
        target: { label: targetLabel, exists: false },
        top: null,
        modal: null,
      };
    }

    const rect = target.getBoundingClientRect();
    const centerX = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
    const centerY = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
    const top = document.elementFromPoint(centerX, centerY);
    const targetContainsTop = top && (target === top || target.contains(top));
    if (targetContainsTop) {
      return {
        blocked: false,
        target: { label: targetLabel, exists: true, centerX, centerY },
        top: top ? metaOf(top) : null,
        modal: null,
      };
    }

    const blocker = top?.closest(interceptorSelectors.join(','));
    if (blocker && isVisible(blocker) && !blocker.contains(target)) {
      return {
        blocked: true,
        target: { label: targetLabel, exists: true, centerX, centerY },
        top: top ? metaOf(top) : null,
        modal: metaOf(blocker),
      };
    }

    return {
      blocked: false,
      target: { label: targetLabel, exists: true, centerX, centerY },
      top: top ? metaOf(top) : null,
      modal: null,
    };
  }, {
    selectors,
    interceptorSelectors: CLICK_INTERCEPTOR_SELECTORS,
    label,
    preferLast: Boolean(options.preferLast),
  }).catch((error) => ({
    blocked: false,
    target: { label, exists: false },
    top: null,
    modal: null,
    error: error.message || String(error),
  }));
}

async function ensureTargetClickable(page, selectors, label, context, options = {}) {
  if (options.dismissBlockers === false) {
    await assertNoBlockingModal(page, context);
  } else {
    await ensureNoBlockingModal(page, context);
  }
  let blocker = await getCenterPointClickBlocker(page, selectors, label, options);
  if (!blocker.blocked) return blocker;

  if (options.dismissBlockers === false) {
    throw new Error(clickableBlockerErrorMessage(blocker, context));
  }

  const dismiss = await dismissBlockingModal(page);
  if (dismiss.dismissed) {
    blocker = await getCenterPointClickBlocker(page, selectors, label, options);
    if (!blocker.blocked) return blocker;
  }

  throw new Error(clickableBlockerErrorMessage(blocker, context));
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

function assertNewChatBootstrapRoute(page, targetBase = TARGET_APP_BASE) {
  const current = new URL(page.url());
  const routeId = routeSessionIdFromUrl(current.href);
  const expectedPath = targetBase.pathname.replace(/\/+$/, '') || '/';
  const actualPath = current.pathname.replace(/\/+$/, '') || '/';
  if (
    current.origin !== targetBase.origin
    || actualPath !== expectedPath
    || routeId
  ) {
    throw cbError(
      'NEW_CHAT_ROUTE_DRIFT',
      `New-chat transaction left canonical root before dispatch: expected=${TARGET_APP_BASE.origin}${expectedPath} actual=${current.origin}${actualPath} routeId=${routeId || 'none'}`,
      {
        routeId,
        url: page.url(),
      }
    );
  }
}

function attestUserTurn(turns, ref) {
  const users = turns.filter((turn) => turn.role === 'user');

  if (ref.messageId) {
    const messageIdMatches = users.filter(
      (turn) => turn.messageId && turn.messageId === ref.messageId
    );
    if (messageIdMatches.length === 1) {
      return {
        attested: true,
        method: 'message_id',
        turn: messageIdMatches[0],
      };
    }
    // If mounted turns expose message IDs but ours is absent, don't silently downgrade to text
    if (users.some((turn) => turn.messageId)) {
      return {
        attested: false,
        definitiveMismatch: true,
        reason: 'accepted message id absent',
      };
    }
  }

  if (ref.testid && ref.textHash) {
    const testidMatches = users.filter(
      (turn) =>
        turn.testid === ref.testid
        && messageHash(normalizeTurnText(turn.text)) === ref.textHash
    );
    if (testidMatches.length === 1) {
      return {
        attested: true,
        method: 'testid_hash',
        turn: testidMatches[0],
      };
    }
  }

  if (ref.textHash) {
    const hashMatches = users.filter(
      (turn) => messageHash(normalizeTurnText(turn.text)) === ref.textHash
    );
    if (hashMatches.length === 1) {
      return {
        attested: true,
        method: 'unique_text_hash',
        turn: hashMatches[0],
      };
    }
    if (hashMatches.length > 1) {
      return {
        attested: false,
        definitiveMismatch: true,
        reason: 'ambiguous accepted-turn hash',
      };
    }
  }

  return {
    attested: false,
    definitiveMismatch: false,
    reason: 'accepted turn not mounted yet',
  };
}

async function waitForAcceptedTurnAttestation(page, sessionId, acceptedUserTurnRef, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() <= deadline) {
    const currentId = sessionIdFromUrl(page.url());
    if (currentId && currentId !== sessionId) {
      throw cbError(
        'NEW_SESSION_ATTRIBUTION_MISMATCH',
        `Stable conversation changed during attribution: expected candidate=${sessionId}, actual=${currentId}`,
        {
          candidateSessionId: sessionId,
          actualSessionId: currentId,
        }
      );
    }

    if (!currentId) {
      await page.waitForTimeout(250);
      continue;
    }

    const turns = await getConversationTurns(page).catch(() => []);
    last = attestUserTurn(turns, acceptedUserTurnRef);

    if (last.attested) {
      return {
        ...last,
        sessionId,
      };
    }

    if (last.definitiveMismatch) {
      throw cbError(
        'NEW_SESSION_ATTRIBUTION_MISMATCH',
        `Stable conversation ${sessionId} does not contain the accepted user turn: ${last.reason}`,
        {
          candidateSessionId: sessionId,
          acceptedUserTurnRef,
          reason: last.reason,
        }
      );
    }

    await page.waitForTimeout(250);
  }

  throw cbError(
    'NEW_SESSION_ATTRIBUTION_UNVERIFIED',
    `Stable conversation ${sessionId} appeared, but the accepted user turn could not be attested before timeout`,
    {
      candidateSessionId: sessionId,
      acceptedUserTurnRef,
      lastAttestation: last,
    }
  );
}

function turnMatchesMessage(turnText, message) {
  const identityTurn = normalizeIdentityText(turnText);
  const identityMessage = normalizeIdentityText(message);
  if (!identityTurn || !identityMessage) return false;
  if (identityTurn === identityMessage || identityTurn.includes(identityMessage)) return true;

  // Fallback for markdown-rendered DOM elements where punctuation was converted to HTML tags
  const renderedTurn = normalizePromptForRenderedComparison(turnText);
  const renderedMessage = normalizePromptForRenderedComparison(message);
  if (renderedTurn === renderedMessage || renderedTurn.includes(renderedMessage)) return true;
  if (renderedMessage.length >= 1000) {
    const head = renderedMessage.slice(0, 200);
    const tail = renderedMessage.slice(-200);
    if (renderedTurn.includes(head) && renderedTurn.includes(tail)) return true;
    const startsWithHead = renderedTurn.startsWith(head) || renderedTurn.slice(0, 300).includes(head);
    const hasTruncationMarker = renderedTurn.endsWith('…') || renderedTurn.endsWith('...') || renderedTurn.includes('…') || renderedTurn.includes('Show more');
    if (startsWithHead && hasTruncationMarker) {
      const longerHead = renderedMessage.slice(0, 500);
      if (renderedTurn.includes(longerHead)) return true;
    }
  }
  return false;
}

async function getGenerationState(page) {
  return page.evaluate((voiceControlPattern) => {
    const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const voiceControlRe = new RegExp(voiceControlPattern, 'i');

    function isGenerationControl(button) {
      const testid = button.getAttribute('data-testid') || '';
      const aria = button.getAttribute('aria-label') || '';
      const title = button.getAttribute('title') || '';
      const visibleText = textOf(button);

      const meta = `${testid} ${aria} ${title} ${visibleText}`
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

      if (voiceControlRe.test(meta)) return false;
      if (/\b(share|copy|close|cancel dictation)\b/i.test(meta)) return false;
      if (/^cancel$/i.test(visibleText.trim())) return false;

      const turn = button.closest?.('[data-testid^="conversation-turn-"]');
      if (turn && turn.querySelector?.('[id^="message-edit-"][contenteditable="true"], .ProseMirror[contenteditable="true"]')) {
        return false;
      }

      if (
        /\bstop-button\b/i.test(testid) ||
        /\b(stop generating|stop answering|stop response)\b/i.test(meta) ||
        /\binterrupt(?: generation| response| answer)?\b/i.test(meta)
      ) {
        return true;
      }

      return /\bstop\b/i.test(meta) && !/\b(stopped|stopwatch)\b/i.test(meta);
    }

    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(isVisible);
    const generatingButton = buttons.find(isGenerationControl);

    return {
      isGenerating: Boolean(generatingButton),
      control: generatingButton
        ? (generatingButton.getAttribute('data-testid')
          || generatingButton.getAttribute('aria-label')
          || generatingButton.getAttribute('title')
          || textOf(generatingButton)
          || 'generation-control')
        : '',
    };
  }, VOICE_CONTROL_PATTERN).catch(() => ({ isGenerating: false, control: '' }));
}

async function getTargetAppState(page) {
  return page.evaluate(({
    blockingModalSelectors,
    composerSelectors,
    sendButtonSelectors,
    clickInterceptorSelectors,
    targetAppBrandToken,
    voiceControlPattern,
    composerIgnoredControlPattern,
    modelChromePattern,
  }) => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || el?.value || '').replace(/\s+/g, ' ').trim();
    const voiceControlRe = new RegExp(voiceControlPattern, 'i');
    const composerIgnoredControlRe = new RegExp(composerIgnoredControlPattern, 'i');
    const modelChromeRe = new RegExp(modelChromePattern, 'i');
    const blockingModalKindOf = (meta) => {
      const joined = [meta.id || '', meta.testid || '', meta.role || '', meta.aria || '', meta.title || '', meta.text || ''].join(' ');
      if (/conversation-history-rate-limit|conversation\s+history.*rate\s+limit|rate\s+limit|too many requests|limit reached/i.test(joined)) {
        return 'conversation_history_rate_limit';
      }
      if (/modal-subscription-failure|subscription|plan limit/i.test(joined)) {
        return 'subscription_modal';
      }
      if (/modal-settings|settings|personalization|custom instructions|base style and tone/i.test(joined)) {
        return 'settings_modal';
      }
      if (/\b(artifact|lightbox|image preview|media preview)\b/i.test(joined)) {
        return 'artifact_lightbox';
      }
      return 'blocking_modal';
    };
    const metaOf = (el) => {
      if (!el) return null;
      const result = {
        id: el.id || '',
        testid: el.getAttribute('data-testid') || '',
        role: el.getAttribute('role') || '',
        ariaModal: el.getAttribute('aria-modal') || '',
        aria: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        text: textOf(el),
      };
      return { ...result, kind: blockingModalKindOf(result) };
    };
    const centerPointBlocker = (target, label) => {
      if (!target || !isVisible(target)) {
        return { blocked: false, target: { label, exists: false }, modal: null, top: null };
      }
      const rect = target.getBoundingClientRect();
      const centerX = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
      const centerY = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
      const top = document.elementFromPoint(centerX, centerY);
      if (top && (target === top || target.contains(top))) {
        return { blocked: false, target: { label, exists: true, centerX, centerY }, modal: null, top: metaOf(top) };
      }
      const blocker = top?.closest(clickInterceptorSelectors.join(','));
      if (blocker && isVisible(blocker) && !blocker.contains(target)) {
        return {
          blocked: true,
          target: { label, exists: true, centerX, centerY },
          modal: metaOf(blocker),
          top: metaOf(top),
        };
      }
      return { blocked: false, target: { label, exists: true, centerX, centerY }, modal: null, top: metaOf(top) };
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
            aria: modal.getAttribute('aria-label') || candidate.getAttribute('aria-label') || '',
            title: modal.getAttribute('title') || candidate.getAttribute('title') || '',
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
      return normalized.toLowerCase() === targetAppBrandToken
        || /^(?:(?:pro\s+)?thinking|finalizing answer|looking for available tools|called tool)$/i.test(normalized)
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

    function isGenerationControl(button) {
      const testid = button.getAttribute('data-testid') || '';
      const aria = button.getAttribute('aria-label') || '';
      const title = button.getAttribute('title') || '';
      const visibleText = textOf(button);

      const meta = `${testid} ${aria} ${title} ${visibleText}`
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

      if (voiceControlRe.test(meta)) return false;
      if (/\b(share|copy|close|cancel dictation)\b/i.test(meta)) return false;
      if (/^cancel$/i.test(visibleText.trim())) return false;

      const turn = button.closest?.('[data-testid^="conversation-turn-"]');
      if (turn && turn.querySelector?.('[id^="message-edit-"][contenteditable="true"], .ProseMirror[contenteditable="true"]')) {
        return false;
      }

      if (
        /\bstop-button\b/i.test(testid) ||
        /\b(stop generating|stop answering|stop response)\b/i.test(meta) ||
        /\binterrupt(?: generation| response| answer)?\b/i.test(meta)
      ) {
        return true;
      }

      return /\bstop\b/i.test(meta) && !/\b(stopped|stopwatch)\b/i.test(meta);
    }

    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(isVisible);
    const generationControls = buttons
      .filter(isGenerationControl)
      .map((button) => ({ text: controlText(button), testid: button.getAttribute('data-testid') || '' }));

    const voiceControls = controls
      .filter((item) => voiceControlRe.test([
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
        const messageId = turn.getAttribute('data-message-id')
          || roleEls.find((el) => el.getAttribute('data-message-id'))?.getAttribute('data-message-id')
          || turn.querySelector('[data-message-id]')?.getAttribute('data-message-id')
          || '';
        return {
          index,
          testid: turn.getAttribute('data-testid') || '',
          messageId,
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

    const composerCandidates = composerSelectors.flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter((el, index, list) => list.indexOf(el) === index);
    const visibleComposers = composerCandidates.filter(isVisible);
    const composer = visibleComposers[visibleComposers.length - 1] || composerCandidates[composerCandidates.length - 1] || null;
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
          if (composerIgnoredControlRe.test(joined)) return false;
          if (/\b(file|attachment|upload|remove|pasted text|pasted|pdf|doc|image|csv|txt)\b/i.test(meta)) return true;
          return body.length <= 240
            && /\b(pasted text|attachment|file|pdf|docx?|image|csv|\.txt|\.pdf|\.csv|\.png|\.jpe?g|\.webp)\b/i.test(body);
        })
        .slice(0, 20)
      : [];
    const sendButton = [...document.querySelectorAll(sendButtonSelectors.join(','))]
      .find(isVisible) || null;
    const sendButtonState = sendButton
      ? {
        exists: true,
        disabled: Boolean(sendButton.disabled || sendButton.getAttribute('aria-disabled') === 'true'),
        label: controlText(sendButton),
      }
      : { exists: false, disabled: false, label: '' };
    const clickability = {
      composer: centerPointBlocker(composer, 'composer'),
      sendButton: centerPointBlocker(sendButton, 'send button'),
    };

    const activityTexts = [...document.querySelectorAll('main *, [data-testid^="conversation-turn-"] *')]
      .filter((el) => isVisible(el) && (!composerRoot || !composerRoot.contains(el)))
      .map(textOf)
      .filter((text) => text && text.length <= 180)
      .filter((text) => !/thinking effort/i.test(text))
      .filter((text) => /\b(thinking|thought|reasoning|searching|searched|browsing|reading|analyzing|working|creating|generating|running|tool|uploading|processing|finalizing|attached)\b/i.test(text))
      .filter((text, index, arr) => arr.indexOf(text) === index)
      .slice(-20);

    const modelButtonEl = buttons.find((button) => {
      const text = textOf(button);
      const meta = controlText(button);
      const insideComposer = Boolean(composerRoot && composerRoot.contains(button));
      if (insideComposer && button.matches('button.__composer-pill, button[class*="__composer-pill"]')) return true;
      if (insideComposer && button.getAttribute('aria-haspopup') === 'menu' && button.id !== 'composer-plus-btn') return true;
      if (button.getAttribute('data-testid') === 'model-switcher-dropdown-button') return true;
      if (/model selector/i.test(button.getAttribute('aria-label') || '')) return true;
      if (text.length <= 80 && /\b(gpt|latest|instant|thinking|extended|pro|sol|astra)\b/i.test(text)
        && !modelChromeRe.test(meta)) return true;
      return insideComposer
        && text.length <= 80
        && /\b(extra high|high|medium|low|auto|fast|thinking effort)\b/i.test(text)
        && !modelChromeRe.test(meta);
    });
    const rawModelButtonText = modelButtonEl ? textOf(modelButtonEl) : '';
    const normalizedModelButtonText = /^thinking effort$/i.test(rawModelButtonText) ? '' : rawModelButtonText;
    const modelButton = modelButtonEl
      ? {
        text: normalizedModelButtonText || modelButtonEl.getAttribute('aria-label') || '',
        aria: modelButtonEl.getAttribute('aria-label') || '',
        testid: modelButtonEl.getAttribute('data-testid') || '',
      }
      : null;
    const reasoningControls = controls
      .filter((item) => /\b(reasoning|think|thinking|extended|fast|auto)\b/i.test([item.testid, item.aria, item.title, item.text].join(' ')))
      .slice(0, 20);

    const latestAssistantAlerts = latestAssistantTurn
      ? [...latestAssistantTurn.querySelectorAll('.text-token-text-error, [role="alert"], [data-testid*="error"]')].filter(isVisible)
      : [];

    const maxLengthBanner = [...document.querySelectorAll('main *, [data-testid^="conversation-turn-"] *, .text-token-text-error, div, p')]
      .find((el) => isVisible(el) && textOf(el).length < 300 && /maximum length for this conversation/i.test(textOf(el)));

    const connectionInterruptedBanner = latestAssistantAlerts
      .find((el) => textOf(el).length < 300 && /connection interrupted.*waiting for the complete answer|waiting for the complete answer/i.test(textOf(el)));

    const terminalErrorBanner = latestAssistantAlerts
      .find((el) => textOf(el).length < 500 && /something went wrong|internal server error|error generating (?:a )?response|message stream error/i.test(textOf(el)));

    const maxLengthReached = Boolean(maxLengthBanner);
    const connectionInterrupted = Boolean(connectionInterruptedBanner);

    return {
      url: location.href,
      title: document.title,
      maxLengthReached,
      maxLengthBanner: maxLengthBanner ? textOf(maxLengthBanner) : '',
      connectionInterrupted,
      connectionInterruptedBanner: connectionInterruptedBanner ? textOf(connectionInterruptedBanner) : '',
      terminalError: Boolean(terminalErrorBanner),
      terminalErrorText: terminalErrorBanner ? textOf(terminalErrorBanner) : '',
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
      sendButton: sendButtonState,
      clickability,
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
        testid: latestAssistantTurn?.getAttribute('data-testid') || '',
        messageId: latestAssistantTurn?.getAttribute('data-message-id') || '',
        chars: latestAssistantText.length,
        preview: latestAssistantText.slice(0, 400),
        errorText: terminalErrorBanner ? textOf(terminalErrorBanner) : '',
        connectionInterrupted: Boolean(connectionInterruptedBanner),
      },
      artifacts: {
        links,
        images,
        downloadControls,
        codeBlocks,
      },
    };
  }, {
    blockingModalSelectors: BLOCKING_MODAL_SELECTORS,
    composerSelectors: COMPOSER_SELECTORS,
    sendButtonSelectors: SEND_BUTTON_SELECTORS,
    clickInterceptorSelectors: CLICK_INTERCEPTOR_SELECTORS,
    targetAppBrandToken: TARGET_APP_BRAND_TOKEN,
    voiceControlPattern: VOICE_CONTROL_PATTERN,
    composerIgnoredControlPattern: COMPOSER_IGNORED_CONTROL_PATTERN,
    modelChromePattern: MODEL_CHROME_PATTERN,
  });
}

function compactModelConfig(config) {
  if (!config) return null;
  if (config.error) return { error: config.error };
  return {
    button: config.button || '',
    current: {
      label: config.current?.label || '',
      model: config.current?.model || '',
      effort: config.current?.effort || '',
    },
    models: config.models || [],
    efforts: config.efforts || [],
    hasSlider: Boolean(config.hasSlider),
    modes: (config.modes || []).map((row) => ({
      label: row.label || '',
      mode: row.mode || '',
      effort: row.effort || '',
      selectedEffort: row.selectedEffort || '',
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
  if (state.branchInfo?.isFork) {
    const parent = state.branchInfo.parentSessionId ? ` (parent: ${state.branchInfo.parentSessionId})` : '';
    const vectors = state.branchInfo.detectionVectors?.length ? ` [detected via: ${state.branchInfo.detectionVectors.join(', ')}]` : '';
    lines.push(`Branch status: Forked branch at turn ${state.branchInfo.forkTurn}${parent}${vectors}`);
  }
  if (state.maxLengthReached) {
    lines.push(`Thread limit: Maximum conversation length advisory banner visible. Follow 3-stage recovery (edit/regenerate -> resend -> native branch).`);
  }
  if (state.connectionInterrupted) {
    lines.push(`Connection status: Interrupted / waiting for answer. Run 'CB --recover-interrupted' to reload.`);
  }
  if (config?.error) {
    lines.push(`Model config: unavailable (${config.error})`);
  } else if (config) {
    const current = config.current?.label || config.current?.model || '';
    const selected = config.button || state.model || '';
    if (config.models?.length) {
      lines.push(`Models: ${config.models.map((m) => {
        const isLatest = /^latest/i.test(m.name || m.label);
        const suffix = isLatest ? ' (GPT-6 / Astra)' : '';
        return `${m.label}${suffix}${m.checked ? ' [selected]' : ''}`;
      }).join(', ')}`);
    }
    if (config.efforts?.length) {
      lines.push(`Effort levels: ${config.efforts.map((e) => `${e.label}${e.selected ? ' [selected]' : ''}`).join(', ')}`);
    }
    const modeLabels = (config.modes || [])
      .map((row) => {
        if (!row.label) return '';
        const effortParts = [];
        const displaySelectedEffort = row.selectedEffort
          && (!row.effort || normalizeModelLabel(row.effort) === normalizeModelLabel(row.selectedEffort))
          ? row.selectedEffort
          : '';
        if (displaySelectedEffort) effortParts.push(`selected effort: ${displaySelectedEffort}`);
        if (row.effortOptions?.length) effortParts.push(`efforts: ${row.effortOptions.join(', ')}`);
        const suffix = effortParts.length ? ` (${effortParts.join('; ')})` : '';
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
    lines.push(`Blocking modal: ${blockingModalSummary(state.blockingModal)}`);
  }
  if (state.generationControls.length) {
    lines.push(`Generation controls: ${state.generationControls.map((item) => item.text).join(' | ')}`);
  }
  if (state.voiceControls.length) {
    lines.push(`Voice/dictation controls: recognized, not used (${state.voiceControls.map((item) => item.aria || item.title || item.text || item.testid).join(' | ')})`);
  }
  lines.push(`Composer: ${state.composer.visible ? 'visible' : 'not visible'}, ${state.composer.textChars} chars`);
  if (state.clickability?.composer?.blocked) {
    lines.push(`Composer click blocker: ${blockingModalSummary(state.clickability.composer.modal)}`);
  }
  if (state.sendButton?.exists) {
    lines.push(`Send button: visible, ${state.sendButton.disabled ? 'disabled' : 'enabled'}${state.sendButton.label ? ` (${state.sendButton.label})` : ''}`);
  } else {
    lines.push('Send button: not visible');
  }
  if (state.clickability?.sendButton?.blocked) {
    lines.push(`Send button click blocker: ${blockingModalSummary(state.clickability.sendButton.modal)}`);
  }
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
  const blockedByModal = Boolean(state.blockingModal
    || state.clickability?.composer?.blocked
    || state.clickability?.sendButton?.blocked);
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
    maxLengthReached: Boolean(state.maxLengthReached),
    connectionInterrupted: Boolean(state.connectionInterrupted),
    edgeState: state.maxLengthReached ? 'max_conversation_length' : (state.connectionInterrupted ? 'connection_interrupted' : null),
    sessionId: sessionIdFromUrl(state.url),
    url: state.url,
    title: state.title,
    transcript: transcriptPath,
    model: state.model || '',
    modelSelection: {
      button: state.model || '',
      model: modelSelection.model || modelConfig?.current?.model || modelConfig?.configure?.model || (modelSelection.effort || modelSelection.mode ? 'Latest' : ''),
      mode: modelSelection.mode || (modelSelection.effort ? 'Thinking' : ''),
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
    sendButton: {
      exists: Boolean(state.sendButton?.exists),
      disabled: Boolean(state.sendButton?.disabled),
      label: state.sendButton?.label || '',
    },
    clickability: {
      composer: {
        blocked: Boolean(state.clickability?.composer?.blocked),
        blocker: state.clickability?.composer?.modal ? {
          kind: state.clickability.composer.modal.kind || blockingModalKindFromMeta(state.clickability.composer.modal),
          id: state.clickability.composer.modal.id || '',
          testid: state.clickability.composer.modal.testid || '',
          text: normalizeTurnText(state.clickability.composer.modal.text || '').slice(0, 500),
        } : null,
      },
      sendButton: {
        blocked: Boolean(state.clickability?.sendButton?.blocked),
        blocker: state.clickability?.sendButton?.modal ? {
          kind: state.clickability.sendButton.modal.kind || blockingModalKindFromMeta(state.clickability.sendButton.modal),
          id: state.clickability.sendButton.modal.id || '',
          testid: state.clickability.sendButton.modal.testid || '',
          text: normalizeTurnText(state.clickability.sendButton.modal.text || '').slice(0, 500),
        } : null,
      },
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
    event.sendButton.exists ? 'send-exists' : 'send-missing',
    event.sendButton.disabled ? 'send-disabled' : 'send-enabled',
    event.sendButton.label || '',
    event.clickability.composer.blocked ? 'composer-blocked' : '',
    event.clickability.composer.blocker?.kind || '',
    event.clickability.composer.blocker?.id || '',
    event.clickability.composer.blocker?.testid || '',
    event.clickability.composer.blocker?.text || '',
    event.clickability.sendButton.blocked ? 'send-blocked' : '',
    event.clickability.sendButton.blocker?.kind || '',
    event.clickability.sendButton.blocker?.id || '',
    event.clickability.sendButton.blocker?.testid || '',
    event.clickability.sendButton.blocker?.text || '',
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
  if (event.clickability.composer.blocked) parts.push(`composer-blocker=${blockingModalSummary(event.clickability.composer.blocker)}`);
  if (event.clickability.sendButton.blocked) parts.push(`send-blocker=${blockingModalSummary(event.clickability.sendButton.blocker)}`);
  if (event.sendButton.exists) parts.push(`send=${event.sendButton.disabled ? 'disabled' : 'enabled'}`);
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
  const controlText = await page.evaluate((voiceControlPattern) => {
    const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const voiceControlRe = new RegExp(voiceControlPattern, 'i');
    document.querySelectorAll('[data-cb-stop-generation]').forEach((el) => {
      el.removeAttribute('data-cb-stop-generation');
    });
    function isGenerationControl(button) {
      const testid = button.getAttribute('data-testid') || '';
      const aria = button.getAttribute('aria-label') || '';
      const title = button.getAttribute('title') || '';
      const visibleText = textOf(button);

      const meta = `${testid} ${aria} ${title} ${visibleText}`
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

      if (voiceControlRe.test(meta)) return false;
      if (/\b(share|copy|close|cancel dictation)\b/i.test(meta)) return false;
      if (/^cancel$/i.test(visibleText.trim())) return false;

      const turn = button.closest?.('[data-testid^="conversation-turn-"]');
      if (turn && turn.querySelector?.('[id^="message-edit-"][contenteditable="true"], .ProseMirror[contenteditable="true"]')) {
        return false;
      }

      if (
        /\bstop-button\b/i.test(testid) ||
        /\b(stop generating|stop answering|stop response)\b/i.test(meta) ||
        /\binterrupt(?: generation| response| answer)?\b/i.test(meta)
      ) {
        return true;
      }

      return /\bstop\b/i.test(meta) && !/\b(stopped|stopwatch)\b/i.test(meta);
    }

    const control = [...document.querySelectorAll('button,[role="button"]')]
      .filter(isVisible)
      .find(isGenerationControl);
    if (!control) return '';
    control.setAttribute('data-cb-stop-generation', 'true');
    return [
      control.getAttribute('data-testid') || '',
      control.getAttribute('aria-label') || '',
      control.getAttribute('title') || '',
      textOf(control),
    ].join(' ').replace(/\s+/g, ' ').trim();
  }, VOICE_CONTROL_PATTERN);

  if (!controlText) return false;
  await page.locator('[data-cb-stop-generation="true"]').click({ timeout: 5000 });
  return controlText;
}

async function markNavigationSearchControl(page) {
  return page.evaluate(() => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    document.querySelectorAll('[data-cb-nav-search-control]').forEach((el) => {
      el.removeAttribute('data-cb-nav-search-control');
    });

    const candidates = [...document.querySelectorAll('button,[role="button"],a')]
      .filter(isVisible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const label = [
          el.getAttribute('data-testid') || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          textOf(el),
        ].join(' ').replace(/\s+/g, ' ').trim();
        let score = 0;
        if (/\bsearch chats?\b/i.test(label)) score += 120;
        else if (/\bsearch\b/i.test(label)) score += 40;
        if (el.closest('nav,[aria-label*="Sidebar" i],[aria-label*="history" i]')) score += 40;
        if (rect.x <= 320 && rect.y <= 180) score += 30;
        if (/\b(close|share|download|options|profile|apps|model|reasoning)\b/i.test(label)) score -= 100;
        return { el, label, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    if (!best) return null;
    best.el.setAttribute('data-cb-nav-search-control', 'true');
    return { label: best.label };
  });
}

async function markSearchInput(page) {
  return page.evaluate(() => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || el?.value || '').replace(/\s+/g, ' ').trim();
    document.querySelectorAll('[data-cb-search-input]').forEach((el) => {
      el.removeAttribute('data-cb-search-input');
    });

    const visibleDialogs = [...document.querySelectorAll('[role="dialog"],[data-radix-dialog-content]')]
      .filter(isVisible);
    const inputs = [...document.querySelectorAll('input:not([type="file"]),textarea,[contenteditable="true"],[role="searchbox"]')]
      .filter(isVisible)
      .map((el) => {
        const label = [
          el.getAttribute('placeholder') || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('role') || '',
          textOf(el),
        ].join(' ').replace(/\s+/g, ' ').trim();
        let score = 0;
        if (/\bsearch chats?\b/i.test(label)) score += 120;
        else if (/\bsearch\b/i.test(label)) score += 80;
        if (visibleDialogs.some((dialog) => dialog.contains(el))) score += 30;
        return { el, label, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const best = inputs[0];
    if (!best) return null;
    best.el.setAttribute('data-cb-search-input', 'true');
    return { label: best.label, value: textOf(best.el) };
  });
}

async function openTargetSearch(page) {
  const existing = await markSearchInput(page).catch(() => null);
  if (existing) return existing;

  await assertNoBlockingModal(page, 'before opening target app search');
  const control = await markNavigationSearchControl(page);
  if (!control) throw new Error('No visible target app search control found');
  await ensureTargetClickable(page, ['[data-cb-nav-search-control="true"]'], 'search control', 'before opening target app search', { dismissBlockers: false });
  await clickMarkedSearchElement(page, '[data-cb-nav-search-control="true"]', 'search control');

  const deadline = Date.now() + 10000;
  let input = null;
  while (Date.now() < deadline) {
    input = await markSearchInput(page).catch(() => null);
    if (input) return input;
    await page.waitForTimeout(250);
  }
  throw new Error('Target app search opened, but no visible search input appeared');
}

async function clickMarkedSearchElement(page, selector, label) {
  const locator = page.locator(selector).first();
  try {
    await locator.click({ timeout: 5000 });
    return;
  } catch (error) {
    const clicked = await page.evaluate((targetSelector) => {
      const target = document.querySelector(targetSelector);
      if (!target) return false;
      target.click();
      return true;
    }, selector).catch(() => false);
    if (!clicked) {
      throw new Error(`Unable to click ${label}: ${error.message || String(error)}`);
    }
  }
}

async function setTargetSearchQuery(page, query) {
  await openTargetSearch(page);
  const locator = page.locator('[data-cb-search-input="true"]').first();
  await locator.fill(query).catch(async () => {
    await locator.click({ timeout: 5000 });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await page.keyboard.insertText(query);
  });
  await page.waitForTimeout(400);
}

async function extractTargetSearchResults(page) {
  return page.evaluate(() => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || el?.value || '').replace(/\s+/g, ' ').trim();
    const trimResultText = (text) => (text.length > 800 ? `${text.slice(0, 797)}...` : text);
    document.querySelectorAll('[data-cb-search-result-index]').forEach((el) => {
      el.removeAttribute('data-cb-search-result-index');
    });

    const dialogs = [...document.querySelectorAll('[role="dialog"],[data-radix-dialog-content]')].filter(isVisible);
    const markedInput = document.querySelector('[data-cb-search-input="true"]');
    const markedDialog = markedInput?.closest('[role="dialog"],[data-radix-dialog-content]') || null;
    const dialog = (markedDialog && isVisible(markedDialog) ? markedDialog : null)
      || dialogs.find((candidate) => markedInput && candidate.contains(markedInput))
      || dialogs.find((candidate) => [...candidate.querySelectorAll('input:not([type="file"]),textarea,[contenteditable="true"],[role="searchbox"]')]
      .some((input) => isVisible(input) && /\bsearch\b/i.test([
        input.getAttribute('placeholder') || '',
        input.getAttribute('aria-label') || '',
        input.getAttribute('role') || '',
      ].join(' ')))) || null;
    if (!dialog) return { query: '', empty: false, results: [] };

    const input = (markedInput && dialog.contains(markedInput) ? markedInput : null)
      || [...dialog.querySelectorAll('input:not([type="file"]),textarea,[contenteditable="true"],[role="searchbox"]')]
      .find((candidate) => isVisible(candidate) && /\bsearch\b/i.test([
        candidate.getAttribute('placeholder') || '',
        candidate.getAttribute('aria-label') || '',
        candidate.getAttribute('role') || '',
      ].join(' '))) || null;
    const query = textOf(input);

    const scrollable = [...dialog.querySelectorAll('*')]
      .filter((el) => isVisible(el) && el.scrollHeight > el.clientHeight + 10)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] || null;
    document.querySelectorAll('[data-cb-search-scroll-container]').forEach((el) => {
      el.removeAttribute('data-cb-search-scroll-container');
    });
    if (scrollable) scrollable.setAttribute('data-cb-search-scroll-container', 'true');

    const resultMetaFromHref = (href) => {
      try {
        const url = new URL(href, location.href);
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts[0] !== 'c' || !parts[1]) return null;
        return {
          url: url.toString(),
          sessionId: parts[1],
          messageId: url.searchParams.get('messageId') || '',
          source: url.searchParams.get('src') || '',
        };
      } catch {
        return null;
      }
    };

    const anchors = [...dialog.querySelectorAll('a[href]')]
      .filter(isVisible)
      .map((anchor) => ({ anchor, meta: resultMetaFromHref(anchor.href) }))
      .filter((item) => item.meta);
    const seen = new Set();
    const results = [];
    for (const { anchor, meta } of anchors) {
      const text = textOf(anchor);
      const aria = anchor.getAttribute('aria-label') || '';
      const joined = [text, aria].join(' ').trim();
      if (!joined || /^close$/i.test(joined) || /^no results$/i.test(joined)) continue;
      if (anchor === input || anchor.contains(input)) continue;
      const key = [meta.sessionId, meta.messageId || meta.url].join('::');
      if (seen.has(key)) continue;
      seen.add(key);
      const index = results.length + 1;
      anchor.setAttribute('data-cb-search-result-index', String(index));
      results.push({
        index,
        title: trimResultText(text || aria),
        aria: trimResultText(aria),
        url: meta.url,
        sessionId: meta.sessionId,
        messageId: meta.messageId,
        source: meta.source,
      });
    }

    const dialogText = textOf(dialog);
    const loadingSignals = [
      ...dialog.querySelectorAll('[role="status"],[role="progressbar"],[aria-busy="true"],svg.animate-spin,.animate-spin'),
    ].filter(isVisible).map(textOf).filter(Boolean);
    const loading = loadingSignals.length > 0
      || (results.length === 0 && /\b(searching|loading|loading more|loading results)\b/i.test(dialogText));
    const empty = results.length === 0 && /\bno results\b/i.test(dialogText);
    const scroll = scrollable ? {
      top: scrollable.scrollTop,
      height: scrollable.clientHeight,
      scrollHeight: scrollable.scrollHeight,
      remaining: Math.max(0, scrollable.scrollHeight - scrollable.clientHeight - scrollable.scrollTop),
    } : null;
    const hasMore = Boolean(scroll && scroll.remaining > 8);
    const phase = results.length ? 'ready' : (empty ? 'empty' : 'searching');
    const complete = phase === 'ready' ? (!hasMore && !loading) : phase === 'empty';
    return {
      query,
      phase,
      empty,
      loading,
      loadingSignals,
      complete,
      hasMore,
      scroll,
      results,
    };
  });
}

async function waitForTargetSearchResults(page, options = {}) {
  const deadline = Date.now() + SEARCH_READY_TIMEOUT_MS;
  let latest = { query: '', phase: 'searching', empty: false, loading: false, complete: false, hasMore: false, results: [] };
  let lastSignature = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    latest = await extractTargetSearchResults(page);
    const signature = [latest.phase, latest.results.length, latest.empty, latest.loading, latest.scroll?.scrollHeight || 0].join(':');
    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = Date.now();
      if (typeof options.onState === 'function') options.onState(latest, { event: 'search_state' });
    }
    if (latest.results.length) {
      if (Date.now() - stableSince >= 500) return latest;
    } else if (latest.empty) {
      if (Date.now() - stableSince >= 500) return latest;
    }
    await page.waitForTimeout(250);
  }
  latest.phase = latest.results.length ? 'ready' : 'timeout';
  latest.timedOut = true;
  return latest;
}

async function scrollTargetSearchResults(page) {
  const target = await page.evaluate(() => {
    const target = document.querySelector('[data-cb-search-scroll-container="true"]');
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    const before = {
      top: target.scrollTop,
      height: target.clientHeight,
      scrollHeight: target.scrollHeight,
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        heightPx: rect.height,
      },
    };
    return { before };
  });
  if (!target) return null;

  const rect = target.before.rect;
  if (rect && rect.width > 0 && rect.heightPx > 0) {
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.heightPx / 2).catch(() => {});
    const delta = Math.max(600, Math.floor(rect.heightPx * 0.9));
    for (let i = 0; i < 12; i += 1) {
      await page.mouse.wheel(0, delta).catch(() => {});
      await page.waitForTimeout(50);
    }
  }

  const after = await page.evaluate(() => {
    const target = document.querySelector('[data-cb-search-scroll-container="true"]');
    if (!target) return null;
    if (target.scrollTop <= 0) target.scrollTop = target.scrollHeight;
    return {
      top: target.scrollTop,
      height: target.clientHeight,
      scrollHeight: target.scrollHeight,
    };
  });

  return { before: target.before, after };
}

function mergeSearchStates(previous, next) {
  if (!previous?.results?.length) return next;
  const seen = new Set();
  const results = [];
  for (const item of [...previous.results, ...(next.results || [])]) {
    const key = [item.sessionId || '', item.messageId || item.url || item.title || ''].join('::');
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ ...item, index: results.length + 1 });
  }
  return {
    ...next,
    results,
  };
}

function withSearchStepTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function loadMoreTargetSearchResults(page, state, options = {}) {
  const maxScrolls = Math.max(0, options.maxScrolls || 0);
  let current = state;
  let scrolls = 0;
  let stagnantScrolls = 0;
  let bottomConfirmations = 0;
  let bottomConfirmationProbes = 0;
  while (current.results.length) {
    const confirmingBottom = !current.hasMore && bottomConfirmations < SEARCH_BOTTOM_CONFIRMATIONS_REQUIRED;
    if (current.hasMore && scrolls >= maxScrolls) break;
    if (!current.hasMore && !confirmingBottom) break;
    if (confirmingBottom) {
      if (bottomConfirmationProbes >= SEARCH_BOTTOM_CONFIRMATION_MAX_PROBES) break;
      bottomConfirmationProbes += 1;
    }

    const beforeCount = current.results.length;
    const beforeHeight = current.scroll?.scrollHeight || 0;
    const beforeTop = current.scroll?.top || 0;
    const beforeRemaining = current.scroll?.remaining ?? Number.POSITIVE_INFINITY;
    const beforeLast = current.results[current.results.length - 1] || {};
    await scrollTargetSearchResults(page);
    scrolls += 1;
    if (typeof options.onState === 'function') {
      options.onState({ ...current, scrolls, phase: 'scrolling' }, { event: 'search_scroll' });
    }

    const deadline = Date.now() + Math.max(SEARCH_SCROLL_SETTLE_MS, SEARCH_BOTTOM_STABLE_MS);
    let latest = current;
    let lastSignature = '';
    let stableSince = 0;
    while (Date.now() < deadline) {
      latest = mergeSearchStates(current, await extractTargetSearchResults(page));
      const last = latest.results[latest.results.length - 1] || {};
      const signature = [
        latest.results.length,
        latest.scroll?.scrollHeight || 0,
        Math.round(latest.scroll?.remaining || 0),
        last.sessionId || '',
        last.messageId || last.url || '',
        latest.loading ? 'loading' : 'idle',
      ].join(':');
      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
      }
      const changed = latest.results.length > beforeCount
        || (latest.scroll?.scrollHeight || 0) > beforeHeight
        || (last.sessionId && last.sessionId !== (current.results[current.results.length - 1] || {}).sessionId);
      const stableAtBottom = !latest.loading
        && !latest.hasMore
        && stableSince
        && Date.now() - stableSince >= SEARCH_BOTTOM_STABLE_MS;
      if (changed && Date.now() - stableSince >= 750) break;
      if (stableAtBottom) break;
      await page.waitForTimeout(250);
    }
    current = latest;
    const afterCount = current.results.length;
    const afterHeight = current.scroll?.scrollHeight || 0;
    const afterTop = current.scroll?.top || 0;
    const afterRemaining = current.scroll?.remaining ?? Number.POSITIVE_INFINITY;
    const afterLast = current.results[current.results.length - 1] || {};
    const grew = afterCount > beforeCount
      || afterHeight > beforeHeight
      || (afterLast.sessionId && (afterLast.sessionId !== beforeLast.sessionId || afterLast.messageId !== beforeLast.messageId));
    const movedTowardBottom = afterTop > beforeTop + 8 || afterRemaining < beforeRemaining - 8;
    if (!grew && !movedTowardBottom) {
      stagnantScrolls += 1;
    } else {
      stagnantScrolls = 0;
    }
    if (!current.hasMore && !current.loading && !grew) {
      bottomConfirmations += 1;
    } else {
      bottomConfirmations = 0;
      bottomConfirmationProbes = 0;
    }
    current.bottomConfirmations = bottomConfirmations;
    current.truncated = Boolean(current.hasMore && scrolls >= maxScrolls);
    current.complete = Boolean(!current.truncated
      && !current.hasMore
      && !current.loading
      && bottomConfirmations >= SEARCH_BOTTOM_CONFIRMATIONS_REQUIRED);
    if (typeof options.onState === 'function') options.onState(current, { event: 'search_state', scrolls });
    if (!current.hasMore && bottomConfirmations >= SEARCH_BOTTOM_CONFIRMATIONS_REQUIRED) break;
    if (current.hasMore && stagnantScrolls >= 2) break;
  }
  current.scrolls = scrolls;
  current.truncated = Boolean(current.hasMore && (scrolls >= maxScrolls || stagnantScrolls >= 2));
  current.bottomConfirmationTimedOut = Boolean(!current.truncated
    && current.results.length
    && !current.hasMore
    && bottomConfirmations < SEARCH_BOTTOM_CONFIRMATIONS_REQUIRED);
  current.timedOut = Boolean(current.timedOut || current.bottomConfirmationTimedOut);
  current.complete = Boolean(!current.truncated
    && !current.timedOut
    && !current.hasMore
    && !current.loading
    && bottomConfirmations >= SEARCH_BOTTOM_CONFIRMATIONS_REQUIRED);
  current.bottomConfirmations = bottomConfirmations;
  return current;
}

async function closeTargetSearch(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
    const stillOpen = await markSearchInput(page).catch(() => null);
    if (!stillOpen) return;
  }
}

function chooseSearchResult(results, selector) {
  if (!selector) return null;
  const normalized = String(selector).trim();
  if (!normalized) return null;
  if (/^\d+$/.test(normalized)) {
    const index = Number(normalized);
    return results.find((item) => item.index === index) || null;
  }
  const lower = normalized.toLowerCase();
  return results.find((item) => [item.title, item.aria, item.sessionId, item.url]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(lower))) || null;
}

async function searchTargetApp(page, query, options = {}) {
  const searchQuery = String(query || '').trim();
  if (!searchQuery) throw new Error('Search query is empty');

  if (typeof options.onState === 'function') {
    options.onState({
      query: searchQuery,
      phase: 'opening',
      empty: false,
      loading: false,
      complete: false,
      hasMore: false,
      results: [],
    }, { event: 'search_opening' });
  }
  await withSearchStepTimeout(
    setTargetSearchQuery(page, searchQuery),
    SEARCH_OPEN_TIMEOUT_MS,
    `Timed out after ${SEARCH_OPEN_TIMEOUT_MS}ms while opening or filling target app search`,
  );
  let state = await waitForTargetSearchResults(page, options);
  const maxScrolls = Number.isFinite(options.maxScrolls)
    ? options.maxScrolls
    : (options.loadAll ? SEARCH_ALL_MAX_SCROLLS : 0);
  if (state.results.length && maxScrolls > 0) {
    state = await loadMoreTargetSearchResults(page, state, { ...options, maxScrolls });
  }
  let opened = null;
  if (options.open) {
    opened = chooseSearchResult(state.results, options.open);
    if (!opened) {
      await closeTargetSearch(page);
      throw new Error(`No target app search result matched: ${options.open}`);
    }
    await ensureTargetClickable(page, [`[data-cb-search-result-index="${opened.index}"]`], `search result ${opened.index}`, 'before opening target app search result', { dismissBlockers: false });
    await clickMarkedSearchElement(page, `[data-cb-search-result-index="${opened.index}"]`, `search result ${opened.index}`);
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await settlePage(page);
  } else if (!options.keepOpen) {
    await closeTargetSearch(page);
  }

  return {
    query: searchQuery,
    phase: state.phase,
    empty: Boolean(state.empty),
    loading: Boolean(state.loading),
    complete: Boolean(state.complete),
    hasMore: Boolean(state.hasMore),
    timedOut: Boolean(state.timedOut),
    truncated: Boolean(state.truncated),
    bottomConfirmationTimedOut: Boolean(state.bottomConfirmationTimedOut),
    scrolls: state.scrolls || 0,
    bottomConfirmations: state.bottomConfirmations || 0,
    resultCount: state.results.length,
    results: state.results,
    opened,
    url: page.url(),
    sessionId: sessionIdFromUrl(page.url()),
  };
}

function printSearchResults(result, jsonl = false) {
  if (jsonl) {
    console.log(JSON.stringify({
      type: 'target_app_search',
      at: nowIso(),
      ...result,
    }));
    return;
  }

  console.log(`Search: ${result.query}`);
  console.log(`State: ${result.phase || 'unknown'}; results=${result.resultCount || result.results.length}; complete=${result.complete ? 'yes' : 'no'}; scrolls=${result.scrolls || 0}; bottom-confirmations=${result.bottomConfirmations || 0}${result.truncated ? '; truncated=yes' : ''}${result.bottomConfirmationTimedOut ? '; bottom-confirmation-timeout=yes' : ''}`);
  if (!result.results.length) {
    if (result.empty) console.log('No results.');
    else if (result.timedOut) console.log('Search timed out before results or no-result state appeared.');
    else console.log('No visible results.');
    return;
  }
  for (const item of result.results) {
    const displayTitle = item.title.length > 240 ? `${item.title.slice(0, 237)}...` : item.title;
    const suffix = [
      item.sessionId ? `session=${item.sessionId}` : '',
      item.url ? `url=${item.url}` : '',
    ].filter(Boolean).join(' ');
    console.log(`#${item.index} ${displayTitle}${suffix ? ` (${suffix})` : ''}`);
  }
  if (result.opened) {
    console.log(`Opened #${result.opened.index}: ${result.opened.title}`);
  }
}

function buildSearchStateEvent(state, extra = {}) {
  return {
    type: 'target_app_search_state',
    at: nowIso(),
    event: extra.event || 'search_state',
    query: state.query || '',
    phase: state.phase || 'unknown',
    resultCount: state.results?.length || 0,
    empty: Boolean(state.empty),
    loading: Boolean(state.loading),
    complete: Boolean(state.complete),
    hasMore: Boolean(state.hasMore),
    timedOut: Boolean(state.timedOut),
    truncated: Boolean(state.truncated),
    bottomConfirmationTimedOut: Boolean(state.bottomConfirmationTimedOut),
    scrolls: extra.scrolls || state.scrolls || 0,
    bottomConfirmations: state.bottomConfirmations || 0,
    scroll: state.scroll || null,
  };
}

function searchOptionsFromArgs(args) {
  const maxScrolls = args.searchScrollsExplicit
    ? args.searchScrolls
    : (args.searchAll ? SEARCH_ALL_MAX_SCROLLS : 0);
  const options = {
    open: args.searchOpen,
    loadAll: args.searchAll,
    maxScrolls,
  };
  if (args.stateJsonl) {
    options.onState = (state, extra = {}) => {
      console.log(JSON.stringify(buildSearchStateEvent(state, extra)));
    };
  }
  return options;
}

async function markModelSwitcher(page) {
  return page.evaluate((modelChromePattern) => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const modelChromeRe = new RegExp(modelChromePattern, 'i');
    document.querySelectorAll('[data-cb-model-switcher]').forEach((el) => {
      el.removeAttribute('data-cb-model-switcher');
    });

    const candidates = [...document.querySelectorAll('button,[role="button"]')]
      .filter(isVisible)
      .map((el) => {
        const containingDialog = el.closest('[role="dialog"],[aria-modal="true"],[id^="modal-"],[data-testid^="modal-"]');
        if (containingDialog && /modal-settings|settings|personalization|custom instructions|base style and tone/i.test([
          containingDialog.id || '',
          containingDialog.getAttribute('data-testid') || '',
          textOf(containingDialog),
        ].join(' '))) {
          return null;
        }
        const containingForm = el.closest('form');
        const insideComposer = Boolean(containingForm && (
          containingForm.querySelector('#prompt-textarea, [contenteditable="true"], [data-testid*="composer"], textarea')
          || /composer|ask anything/i.test([
            containingForm.getAttribute('data-testid') || '',
            containingForm.className || '',
            textOf(containingForm),
          ].join(' '))
        ));
        const rect = el.getBoundingClientRect();
        const text = textOf(el);
        const meta = [
          el.getAttribute('data-testid') || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          text,
        ].join(' ');
        let score = 0;
        let modelSignal = false;
        if (el.getAttribute('data-testid') === 'model-switcher-dropdown-button') score += 100;
        if (el.getAttribute('data-testid') === 'model-switcher-dropdown-button') modelSignal = true;
        if (/model selector|model switcher|select (?:chatgpt )?model/i.test(el.getAttribute('aria-label') || '')) {
          score += 100;
          modelSignal = true;
        }
        if (el.getAttribute('data-composer-navigation-target') === 'reasoning' || el.getAttribute('data-codex-intelligence-trigger') === 'true' || el.hasAttribute('data-selected-reasoning-effort')) {
          score += 150;
          modelSignal = true;
        }
        if (el.matches('button.__composer-pill, button[class*="__composer-pill"]') || el.querySelector('.uFxlGa_TriggerWrapper, [data-model-reasoning-effort-slider]')) {
          score += 150;
          modelSignal = true;
        }
        if (insideComposer && el.getAttribute('aria-haspopup') === 'menu' && el.id !== 'composer-plus-btn') {
          score += 120;
          modelSignal = true;
        }
        if ((insideComposer || modelSignal) && text.length <= 80 && /\b(gpt|latest|instant|thinking|extended|pro|sol|astra|extra high|high|medium|low|auto|fast)\b/i.test(text)) {
          score += 50;
          modelSignal = true;
        }
        if (insideComposer && text.length <= 80 && /\b(extra high|high|medium|low|auto|fast|thinking effort)\b/i.test(text)) {
          score += 60;
          modelSignal = true;
        }
        if (modelSignal && rect.x > 250 && rect.y > 100) score += 20;
        if (/\b(search|project|history|pin|temporary|profile|account|settings|personalization|custom instructions|download|apps|library)\b/i.test(meta)) score -= 100;
        if (modelChromeRe.test(text)) score -= 100;
        if (!modelSignal) score = 0;
        return { el, text, score };
      })
      .filter(Boolean)
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    if (!best) return '';
    best.el.setAttribute('data-cb-model-switcher', 'true');
    return best.text || best.el.getAttribute('aria-label') || best.el.getAttribute('data-testid') || 'model-switcher';
  }, MODEL_CHROME_PATTERN);
}

async function hasOpenModelMenu(page) {
  return page.evaluate(() => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [data-testid^="model-switcher-"], [data-testid="composer-intelligence-picker-content"], [data-testid="model-configure-modal"]')]
      .some((el) => isVisible(el) && /\b(latest|instant|thinking|pro|configure|intelligence|model|extra high|high|medium)\b/i.test([
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
    return [...document.querySelectorAll('[role="menu"], [data-testid^="model-switcher-"], [data-testid="composer-intelligence-picker-content"], [data-testid="model-configure-modal"]')]
      .some((el) => isVisible(el) && /\b(latest|instant|thinking|pro|configure|intelligence|model|extra high|high|medium)\b/i.test([
        el.getAttribute('data-testid') || '',
        textOf(el),
      ].join(' ')));
  }, null, { timeout });
}

async function openModelSwitcher(page) {
  await ensureNoBlockingModal(page, 'before opening target app model picker');
  if (await hasOpenModelMenu(page)) return 'open';
  const label = await markModelSwitcher(page);
  if (!label) return '';
  await page.locator('[data-cb-model-switcher="true"]').click({ timeout: 5000 });
  await waitForModelMenu(page).catch(() => page.waitForTimeout(700));
  return label;
}

function parseModelSelection(text) {
  const normalized = normalizeModelLabel(text);
  let model = '';
  if (/\b(5\.6|sol)\b/i.test(normalized)) {
    model = '5.6';
  } else if (/\b(5\.5)\b/i.test(normalized)) {
    model = '5.5';
  } else if (/\b(latest|gpt\s*6|astra|(?<!\.)\b6\b(?!\.))/i.test(normalized)) {
    model = 'Latest';
  } else {
    const modelMatch = normalized.match(/\b(?:gpt\s*)?((?:[456](?:\.\d+)?)|o\d+)\b/i);
    if (modelMatch) model = modelMatch[1];
  }

  let effort = '';
  if (/\b(e?xtra\s*high|extended)\b/i.test(normalized)) {
    effort = 'Extra High';
  } else if (/\b(medium|light|low)\b/i.test(normalized)) {
    effort = 'Medium';
  } else if (/\b(high|standard)\b/i.test(normalized)) {
    effort = 'High';
  } else if (/\b(instant|fast|auto)\b/i.test(normalized)) {
    effort = 'Instant';
  } else if (/\b(pro|heavy)\b/i.test(normalized)) {
    effort = 'Pro';
  }

  let mode = '';
  if (effort === 'Instant') mode = 'Instant';
  else if (effort === 'Pro') mode = 'Pro';
  else if (effort) mode = 'Thinking';
  else if (/\bthinking\b/i.test(normalized)) mode = 'Thinking';

  return {
    raw: text,
    normalized,
    model,
    mode,
    effort,
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
    const effortPattern = '(Extra High|Light|Standard|Extended|Heavy|Medium|High|Low|Auto|Fast)';
    const parseRow = (text) => {
      const normalized = text.replace(/\s+/g, ' ').trim();
      let mode = '';
      let effort = '';
      if (/^Instant\b/i.test(normalized)) {
        mode = 'Instant';
      } else if (/^Pro\b/i.test(normalized)) {
        mode = 'Pro';
        effort = (normalized.match(new RegExp(`^Pro\\s+${effortPattern}\\b`, 'i'))?.[1] || '')
          .replace(/\b\w/g, (s) => s.toUpperCase());
      } else if (new RegExp(`^${effortPattern}$`, 'i').test(normalized)) {
        mode = 'Thinking';
        effort = normalized.replace(/\b\w/g, (s) => s.toUpperCase());
      } else if (/^Thinking\b/i.test(normalized)) {
        mode = 'Thinking';
        effort = (normalized.match(new RegExp(`\\b${effortPattern}\\b`, 'i'))?.[1] || '')
          .replace(/\b\w/g, (s) => s.toUpperCase());
      }
      return { mode, effort };
    };
    const rectOf = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    let modelRows = [...document.querySelectorAll('[data-testid^="model-switcher-"]')]
      .filter(isVisible)
      .filter((el) => {
        const testid = el.getAttribute('data-testid') || '';
        return testid !== 'model-switcher-dropdown-button'
          && !testid.includes('thinking-effort')
          && textOf(el);
      })
      .map((el) => {
        const text = textOf(el);
        const parsed = parseRow(text);
        const testid = el.getAttribute('data-testid') || '';
        const effortButton = [...document.querySelectorAll('[data-testid]')]
          .find((button) => (button.getAttribute('data-testid') || '') === `${testid}-thinking-effort`)
          || el.querySelector('[data-model-picker-thinking-effort-action="true"], button[aria-label="Effort"]');
        return {
          label: text,
          mode: parsed.mode,
          effort: parsed.effort,
          testid,
          role: el.getAttribute('role') || '',
          checked: el.getAttribute('aria-checked') || el.getAttribute('data-state') || '',
          effortTestid: effortButton?.getAttribute('data-testid') || '',
          rect: rectOf(el),
        };
      });

    const intelligenceRoot = [...document.querySelectorAll('[data-testid="composer-intelligence-picker-content"], [role="menu"]')]
      .filter(isVisible)
      .find((el) => /\b(Intelligence|Instant|Extra High|GPT-[45](?:\.\d+)?)\b/i.test(textOf(el)));
    const intelligenceItems = intelligenceRoot
      ? [...intelligenceRoot.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')].filter(isVisible)
      : [];
    const intelligenceRows = intelligenceItems
      .map((el) => {
        const text = textOf(el);
        const parsed = parseRow(text);
        if (!parsed.mode) return null;
        const effortButton = parsed.mode === 'Pro'
          ? intelligenceRoot.querySelector('[data-testid="composer-intelligence-pro-thinking-effort-trigger"]')
          : null;
        return {
          label: text,
          mode: parsed.mode,
          effort: parsed.effort,
          testid: el.getAttribute('data-testid') || '',
          role: el.getAttribute('role') || '',
          checked: el.getAttribute('aria-checked') || el.getAttribute('data-state') || '',
          effortTestid: effortButton?.getAttribute('data-testid') || '',
          rect: rectOf(el),
        };
      })
      .filter(Boolean);
    if (intelligenceRows.length) modelRows = intelligenceRows;

    const menuRoots = [...document.querySelectorAll('[role="menu"]')]
      .filter(isVisible)
      .filter((el) => {
        if (intelligenceRoot && el.contains(intelligenceRoot)) return true;
        return modelRows.some((row) => row.testid && el.contains(document.querySelector(`[data-testid="${row.testid}"]`)));
      });
    const menuRoot = menuRoots[0] || (intelligenceRoot?.closest('[role="menu"]') || null);
    const header = menuRoot
      ? [...menuRoot.querySelectorAll('div,span')]
        .filter(isVisible)
        .map(textOf)
        .find((text) => /^(Latest|Legacy)\s*•\s*/i.test(text) || /^(Latest|Legacy)\b/i.test(text))
        || ''
      : '';
    const modelOption = intelligenceItems
      .map(textOf)
      .find((text) => /\b(?:gpt[-\s]*)?(?:[456](?:\.\d+)?|o\d+)\b/i.test(text)) || '';

    const slider = document.querySelector('[role="slider"]')
      || document.querySelector('[aria-valuenow]')
      || document.querySelector('[data-model-reasoning-effort-slider-thumb]');
    const announcementText = textOf(document.querySelector('[class*="KeyboardAnnouncement"], .d1BZWq_KeyboardAnnouncement') || document.querySelector('[class*="ViewToggle"], .d1BZWq_ViewToggle') || document.querySelector('[aria-label="Power"]'));
    const hasSlider = Boolean(slider);
    let sliderVal = slider && slider.hasAttribute('aria-valuenow')
      ? parseInt(slider.getAttribute('aria-valuenow'), 10)
      : null;
    if (sliderVal === null && announcementText) {
      if (/\binstant\b/i.test(announcementText)) sliderVal = 0;
      else if (/\bmedium\b/i.test(announcementText)) sliderVal = 1;
      else if (/\bhigh\b/i.test(announcementText) && !/extra\s*high/i.test(announcementText)) sliderVal = 2;
      else if (/\bextra\s*high\b/i.test(announcementText)) sliderVal = 3;
      else if (/\bpro\b/i.test(announcementText)) sliderVal = 4;
    }
    const effortLevels = ['Instant', 'Medium', 'High', 'Extra High', 'Pro'];
    const selectedEffort = sliderVal !== null && effortLevels[sliderVal] ? effortLevels[sliderVal] : '';

    const modelRadios = [...document.querySelectorAll('[role="menuitemradio"]')]
      .filter(isVisible)
      .map((el) => {
        const text = textOf(el);
        const checked = el.getAttribute('aria-checked') === 'true' || el.getAttribute('data-state') === 'checked';
        let cleanName = text;
        if (/^Latest\b/i.test(text)) cleanName = 'Latest';
        else if (/^GPT-5\.6\b/i.test(text)) cleanName = 'GPT-5.6 Sol';
        else if (/^GPT-5\.5\b/i.test(text)) cleanName = 'GPT-5.5';
        return {
          label: text,
          name: cleanName,
          checked,
          testid: el.getAttribute('data-testid') || '',
          rect: rectOf(el),
        };
      });

    const checkedModelItem = modelRadios.find((r) => r.checked);
    const checkedModel = checkedModelItem ? checkedModelItem.name : (header ? (header.match(/\b((?:[456](?:\.\d+)?)|o\d+|latest)\b/i)?.[1] || '') : 'Latest');
    const currentModel = checkedModel
      || header.match(/\b((?:[456](?:\.\d+)?)|o\d+)\b/i)?.[1]
      || modelOption.match(/\b(?:gpt[-\s]*)?((?:[456](?:\.\d+)?)|o\d+)\b/i)?.[1]
      || '';

    if (hasSlider) {
      modelRows = [
        {
          label: 'Instant',
          mode: 'Instant',
          effort: 'Instant',
          checked: sliderVal === 0 ? 'true' : 'false',
          rect: rectOf(slider),
          effortOptions: ['Instant'],
        },
        {
          label: 'Thinking',
          mode: 'Thinking',
          effort: (sliderVal >= 1 && sliderVal <= 3) ? selectedEffort : 'Extra High',
          checked: (sliderVal >= 1 && sliderVal <= 3) ? 'true' : 'false',
          rect: rectOf(slider),
          effortOptions: ['Medium', 'High', 'Extra High'],
          selectedEffort: (sliderVal >= 1 && sliderVal <= 3) ? selectedEffort : '',
        },
        {
          label: 'Pro',
          mode: 'Pro',
          effort: 'Pro',
          checked: sliderVal === 4 ? 'true' : 'false',
          rect: rectOf(slider),
          effortOptions: ['Pro'],
        },
      ];
      for (const m of modelRadios) {
        modelRows.push({
          label: m.label,
          mode: 'Thinking',
          effort: selectedEffort || 'Extra High',
          checked: m.checked ? 'true' : 'false',
          rect: m.rect,
        });
      }
    }

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
        label: hasSlider ? (checkedModel ? `${checkedModel} • ${selectedEffort}` : selectedEffort) : (header || modelOption),
        model: currentModel,
        effort: selectedEffort,
      },
      rows: modelRows,
      models: modelRadios,
      efforts: effortLevels.map((lvl, idx) => ({ label: lvl, selected: idx === sliderVal })),
      hasSlider,
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

async function readVisibleEffortChoiceState(page, row) {
  return page.evaluate((target) => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const rectOf = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    };
    const normalizeOption = (text) => {
      let value = text.replace(/\s+/g, ' ').trim();
      const mode = String(target.mode || '').trim();
      if (mode) value = value.replace(new RegExp(`^${mode}\\s+`, 'i'), '').trim();
      return value.replace(/\b\w/g, (s) => s.toUpperCase());
    };
    const isEffort = (text) => /^(Extra High|Light|Standard|Extended|Heavy|Medium|High|Low|Auto|Fast)$/i.test(text);
    const checkedValue = (el) => [
      el.getAttribute('aria-checked') || '',
      el.getAttribute('data-state') || '',
    ].join(' ');
    const button = target.effortTestid ? document.querySelector(`[data-testid="${target.effortTestid}"]`) : null;
    const buttonRect = button ? rectOf(button) : null;
    const baseRoot = button?.closest('[role="menu"], [role="listbox"]') || null;
    const roots = [...document.querySelectorAll('[role="menu"], [role="listbox"]')]
      .filter(isVisible)
      .map((el) => {
        const rect = rectOf(el);
        const items = [...el.querySelectorAll('[role="menuitemradio"], [role="option"]')]
          .filter(isVisible)
          .map((item) => ({
            label: normalizeOption(textOf(item)),
            checked: /true|checked|on/i.test(checkedValue(item)),
          }))
          .filter((item) => isEffort(item.label));
        const separateFromBase = Boolean(baseRoot && el !== baseRoot && !el.contains(baseRoot) && !baseRoot.contains(el));
        const distance = buttonRect
          ? Math.abs(rect.x - buttonRect.x) + Math.abs(rect.y - buttonRect.y)
          : 0;
        return { items, separateFromBase, distance };
      })
      .filter((item) => item.items.length)
      .sort((a, b) => {
        if (a.separateFromBase !== b.separateFromBase) return a.separateFromBase ? -1 : 1;
        return a.distance - b.distance;
      });
    const items = roots[0]?.items || [];
    return {
      options: [...new Set(items.map((item) => item.label))],
      selected: items.find((item) => item.checked)?.label || '',
    };
  }, {
    mode: row?.mode || '',
    effortTestid: row?.effortTestid || '',
  });
}

async function clickVisibleEffortChoice(page, row, effort) {
  const marked = await page.evaluate((target) => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const rectOf = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    };
    const normalizeOption = (text) => {
      let value = text.replace(/\s+/g, ' ').trim();
      const mode = String(target.mode || '').trim();
      if (mode) value = value.replace(new RegExp(`^${mode}\\s+`, 'i'), '').trim();
      return value.replace(/\b\w/g, (s) => s.toUpperCase());
    };
    document.querySelectorAll('[data-cb-effort-choice-target]').forEach((el) => {
      el.removeAttribute('data-cb-effort-choice-target');
    });
    const button = target.effortTestid ? document.querySelector(`[data-testid="${target.effortTestid}"]`) : null;
    const buttonRect = button ? rectOf(button) : null;
    const baseRoot = button?.closest('[role="menu"], [role="listbox"]') || null;
    const roots = [...document.querySelectorAll('[role="menu"], [role="listbox"]')]
      .filter(isVisible)
      .map((el) => {
        const rect = rectOf(el);
        const items = [...el.querySelectorAll('[role="menuitemradio"], [role="option"]')]
          .filter(isVisible)
          .map((item) => ({
            el: item,
            label: normalizeOption(textOf(item)),
          }))
          .filter((item) => item.label);
        const separateFromBase = Boolean(baseRoot && el !== baseRoot && !el.contains(baseRoot) && !baseRoot.contains(el));
        const distance = buttonRect
          ? Math.abs(rect.x - buttonRect.x) + Math.abs(rect.y - buttonRect.y)
          : 0;
        return { items, separateFromBase, distance };
      })
      .filter((item) => item.items.length)
      .sort((a, b) => {
        if (a.separateFromBase !== b.separateFromBase) return a.separateFromBase ? -1 : 1;
        return a.distance - b.distance;
      });
    const normalizedEffort = normalizeOption(target.effort || '');
    const item = roots[0]?.items.find((candidate) => candidate.label.toLowerCase() === normalizedEffort.toLowerCase())
      || null;
    if (!item) return false;
    item.el.setAttribute('data-cb-effort-choice-target', 'true');
    return true;
  }, {
    mode: row?.mode || '',
    effortTestid: row?.effortTestid || '',
    effort,
  });
  if (!marked) return false;
  await page.locator('[data-cb-effort-choice-target="true"]').first().click({ timeout: 5000 });
  await page.waitForTimeout(500);
  return true;
}

async function markVisibleModelMenuRow(page, row) {
  return page.evaluate((target) => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const normalize = (text) => String(text || '')
      .replace(/\u2022/g, ' ')
      .replace(/[^a-zA-Z0-9.]+/g, ' ')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');
    document.querySelectorAll('[data-cb-model-row-target]').forEach((el) => {
      el.removeAttribute('data-cb-model-row-target');
    });
    if (target.testid) {
      const byTestid = document.querySelector(`[data-testid="${target.testid}"]`);
      if (isVisible(byTestid)) {
        byTestid.setAttribute('data-cb-model-row-target', 'true');
        return true;
      }
    }
    const targetLabel = normalize(target.label);
    const targetMode = normalize(target.mode);
    const targetEffort = normalize(target.effort);
    const candidates = [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"]')]
      .filter(isVisible)
      .map((el) => {
        const text = textOf(el);
        const normalized = normalize(text);
        let score = 0;
        if (targetLabel && normalized === targetLabel) score += 100;
        if (targetLabel && normalized.startsWith(`${targetLabel} `)) score += 60;
        if (targetMode && normalized.includes(targetMode)) score += 30;
        if (targetEffort && normalized.includes(targetEffort)) score += 30;
        if (!targetLabel && !targetMode && !targetEffort) score = 0;
        if (text.length > 120) score -= 50;
        return { el, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) return false;
    best.el.setAttribute('data-cb-model-row-target', 'true');
    return true;
  }, {
    label: row?.label || '',
    mode: row?.mode || '',
    effort: row?.effort || '',
    testid: row?.testid || '',
  });
}

async function hoverModelMenuRow(page, row) {
  if (!await markVisibleModelMenuRow(page, row)) return false;
  await page.locator('[data-cb-model-row-target="true"]').first().hover({ timeout: 5000 });
  return true;
}

async function clickModelMenuRow(page, row) {
  if (await markVisibleModelMenuRow(page, row)) {
    await page.locator('[data-cb-model-row-target="true"]').first().click({ timeout: 5000 });
    await page.waitForTimeout(500);
    return true;
  }
  return clickMarkedVisibleOption(page, row?.label || '');
}

async function readEffortStateForRow(page, row) {
  if (!row?.effortTestid) return { options: [], selected: '' };
  for (let attempt = 0; attempt < 2; attempt++) {
    await openModelSwitcher(page);
    await hoverModelMenuRow(page, row).catch(() => {});
    await page.waitForTimeout(150);
    const effortButton = page.locator(`[data-testid="${row.effortTestid}"]`).first();
    if (!await effortButton.count().catch(() => 0)) return { options: [], selected: '' };
    await effortButton.click({ timeout: 5000, force: true });
    await page.waitForTimeout(300);
    const state = await readVisibleEffortChoiceState(page, row);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
    if (state.options.length) return state;
  }
  return { options: [], selected: '' };
}

async function readEffortOptionsForRow(page, row) {
  return (await readEffortStateForRow(page, row)).options;
}

async function setEffortForMenuRow(page, row, effort) {
  if (!row?.effortTestid) throw new Error(`No effort control found for ${row?.label || 'model row'}`);
  await openModelSwitcher(page);
  await hoverModelMenuRow(page, row).catch(() => {});
  await page.waitForTimeout(150);
  await page.locator(`[data-testid="${row.effortTestid}"]`).click({ timeout: 5000, force: true });
  await page.waitForTimeout(300);
  if (!await clickVisibleEffortChoice(page, row, effort)) {
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
    .filter({ hasText: /\b(Extra High|Light|Standard|Extended|Heavy|Medium|High|Low|Auto|Fast)\b/ }).last();
  if (await effortCombo.count().catch(() => 0)) {
    await effortCombo.click({ timeout: 5000 });
    await page.waitForTimeout(300);
    effortOptions.push(...(await readVisibleChoiceOptions(page)).filter((option) => /^(Extra High|Light|Standard|Extended|Heavy|Medium|High|Low|Auto|Fast)$/i.test(option)));
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
  const buttonState = await getTargetAppState(page).catch(() => null);
  await openModelSwitcher(page);
  const menu = await getModelMenuState(page);
  const result = {
    button: buttonState?.model || '',
    current: menu.current,
    modes: menu.rows,
    models: menu.models || [],
    efforts: menu.efforts || [],
    hasSlider: Boolean(menu.hasSlider),
    configureAvailable: Boolean(menu.configure),
  };

  if (options.includeDetails) {
    if (!menu.hasSlider) {
      const buttonSelection = parseModeAndEffort(result.button || '');
      for (const row of result.modes) {
        const effortState = await readEffortStateForRow(page, row);
        row.effortOptions = effortState.options;
        row.selectedEffort = row.checked === 'true'
          && buttonSelection.effort
          && normalizeModelLabel(row.mode) === normalizeModelLabel(buttonSelection.mode)
          ? buttonSelection.effort
          : effortState.selected;
      }
      const selectedEffortRow = result.modes.find((row) => row.checked === 'true' && row.selectedEffort);
      if (selectedEffortRow && !buttonSelection.effort) {
        result.button = `${selectedEffortRow.mode} ${selectedEffortRow.selectedEffort}`;
      }
    }
    if (menu.configure) {
      try {
        await openConfigureModalFromMenu(page);
        result.configure = await getConfigureModalState(page, true);
      } catch (error) {
        result.configureError = error.message || String(error);
      }
      if (result.configure?.effortOptions?.length) {
        const selectedMode = normalizeModelLabel(result.configure.selectedMode);
        const selectedRow = result.modes.find((row) => row.checked === 'true'
          || selectedMode.includes(normalizeModelLabel(row.mode)));
        if (selectedRow && !selectedRow.effortOptions.length) {
          selectedRow.effortOptions = result.configure.effortOptions;
        }
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
  if (config.models?.length) {
    lines.push(`Models: ${config.models.map((m) => {
      const isLatest = /^latest/i.test(m.name || m.label);
      const suffix = isLatest ? ' (GPT-6 / Astra)' : '';
      return `${m.label}${suffix}${m.checked ? ' [selected]' : ''}`;
    }).join(', ')}`);
  }
  if (config.efforts?.length) {
    lines.push(`Effort levels: ${config.efforts.map((e) => `${e.label}${e.selected ? ' [selected]' : ''}`).join(', ')}`);
  }
  if (!config.hasSlider) {
    for (const row of config.modes || []) {
      const effortParts = [];
      const displaySelectedEffort = row.selectedEffort
        && (!row.effort || normalizeModelLabel(row.effort) === normalizeModelLabel(row.selectedEffort))
        ? row.selectedEffort
        : '';
      if (displaySelectedEffort) effortParts.push(`selected effort: ${displaySelectedEffort}`);
      if (row.effortOptions?.length) effortParts.push(`efforts: ${row.effortOptions.join(', ')}`);
      const suffix = effortParts.length ? ` (${effortParts.join('; ')})` : '';
      lines.push(`${row.label}${suffix}`);
    }
  }
  if (config.configureAvailable) lines.push('Configure...');
  if (config.configureError) lines.push(`Configure unavailable: ${config.configureError}`);
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
  const menuState = await inspectModelConfigurator(page).catch(() => null);
  if (menuState?.efforts?.length) {
    return menuState.efforts.map((e) => `${e.label}${e.selected ? ' (selected)' : ''}`);
  }
  const state = await getTargetAppState(page);
  const controls = state.reasoningControls
    .map((item) => item.text || item.aria || item.title || item.testid)
    .filter(Boolean);
  if (controls.length) return controls;
  return ['Instant', 'Medium', 'High', 'Extra High', 'Pro'];
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
      .filter({ hasText: /\b(Extra High|Light|Standard|Extended|Heavy|Medium|High|Low|Auto|Fast)\b/ }).last();
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

function modelRowKey(row) {
  return [
    normalizeModelLabel(row?.label || ''),
    normalizeModelLabel(row?.mode || ''),
    normalizeModelLabel(row?.effort || ''),
    row?.testid || '',
    row?.effortTestid || '',
  ].join('|');
}

async function hydrateModelRows(page, rows, currentSelection = null) {
  const effortStateByKey = new Map();
  for (const row of rows || []) {
    const effortState = row.effortTestid ? await readEffortStateForRow(page, row) : { options: [], selected: '' };
    if (effortState.options.length || effortState.selected) effortStateByKey.set(modelRowKey(row), effortState);
  }
  await openModelSwitcher(page).catch(() => {});
  const state = await getModelMenuState(page);
  return {
    ...state,
    rows: (state.rows || []).map((row) => {
      const effortState = effortStateByKey.get(modelRowKey(row)) || { options: row.effortOptions || [], selected: '' };
      const selectedEffort = row.checked === 'true'
        && currentSelection?.effort
        && normalizeModelLabel(row.mode) === normalizeModelLabel(currentSelection.mode)
        ? currentSelection.effort
        : effortState.selected;
      return {
        ...row,
        selectedEffort: selectedEffort || '',
        effortOptions: effortState.options || row.effortOptions || [],
      };
    }),
  };
}

function effortRankForMode(mode, effort) {
  const normalizedMode = normalizeModelLabel(mode);
  const normalizedEffort = normalizeModelLabel(effort);
  if (normalizedMode === 'instant') return 0;
  if (normalizedMode === 'pro') {
    if (/\b(extended|heavy|extra high)\b/.test(normalizedEffort)) return 6;
    return 5;
  }
  if (normalizedMode === 'thinking') {
    if (/\b(extra high|extended|heavy)\b/.test(normalizedEffort)) return 4;
    if (/\bhigh\b/.test(normalizedEffort)) return 3;
    if (/\b(medium|standard)\b/.test(normalizedEffort)) return 2;
    if (/\b(light|low|fast|auto)\b/.test(normalizedEffort)) return 1;
    return 3;
  }
  if (/\b(extra high|extended|heavy)\b/.test(normalizedEffort)) return 4;
  if (/\bhigh\b/.test(normalizedEffort)) return 3;
  if (/\b(medium|standard)\b/.test(normalizedEffort)) return 2;
  if (/\b(light|low|fast|auto)\b/.test(normalizedEffort)) return 1;
  return -1;
}

function modelChoiceLabel(choice) {
  if (!choice) return '';
  if (choice.mode === 'Instant') return 'Instant';
  if (choice.mode && choice.effort) return `${choice.mode} ${choice.effort}`;
  return choice.label || [choice.mode, choice.effort].filter(Boolean).join(' ') || '';
}

function modelChoicesFromRows(rows) {
  const choices = [];
  const seen = new Set();
  const add = (choice) => {
    const key = choice.effort
      ? [normalizeModelLabel(choice.mode), normalizeModelLabel(choice.effort)].join('|')
      : [normalizeModelLabel(choice.mode), normalizeModelLabel(choice.label)].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    choices.push({
      ...choice,
      rank: effortRankForMode(choice.mode, choice.effort),
    });
  };

  for (const row of rows || []) {
    if (!row.mode) continue;
    const rowEffort = row.selectedEffort || row.effort || '';
    add({
      label: row.label,
      mode: row.mode,
      effort: rowEffort,
      row,
      requiresEffortSelection: false,
    });
    for (const effort of row.effortOptions || []) {
      const normalizedEffort = effort.replace(/\b\w/g, (s) => s.toUpperCase());
      add({
        label: `${row.mode} ${normalizedEffort}`,
        mode: row.mode,
        effort: normalizedEffort,
        row,
        requiresEffortSelection: normalizeModelLabel(row.selectedEffort || row.effort || '') !== normalizeModelLabel(normalizedEffort),
      });
    }
  }
  return choices.filter((choice) => choice.rank >= 0);
}

function requestedModelRank(selection) {
  const mode = selection.mode || (selection.effort ? 'Thinking' : '');
  return effortRankForMode(mode, selection.effort);
}

function choiceMatchesSelection(choice, selection) {
  if (!choice) return false;
  if (selection.mode && normalizeModelLabel(choice.mode) !== normalizeModelLabel(selection.mode)) return false;
  if (selection.effort && normalizeModelLabel(choice.effort) !== normalizeModelLabel(selection.effort)) return false;
  if (!selection.mode && !selection.effort && selection.normalized) {
    return normalizeModelLabel(choice.label).includes(selection.normalized)
      || normalizeModelLabel(modelChoiceLabel(choice)).includes(selection.normalized);
  }
  return true;
}

function chooseFallbackModelChoice(choices, selection) {
  const requestedRank = requestedModelRank(selection);
  if (requestedRank < 0 || !choices.length) return null;
  const byRank = choices.slice().sort((a, b) => b.rank - a.rank);
  const notHigher = byRank.find((choice) => choice.rank <= requestedRank);
  return notHigher || byRank[byRank.length - 1] || null;
}

function formatModelSelectionResult(result, kind = 'model') {
  if (!result) return '';
  if (result.fallback) {
    const availableChoices = [...new Set(result.available || [])];
    const available = availableChoices.length ? ` Available: ${availableChoices.join(', ')}.` : '';
    return `Requested ${kind} "${result.requested}" is not available; selected "${result.selected}" instead.${available}`;
  }
  return `Selected ${kind}: ${result.selected || result.requested}`;
}

async function applyModelChoice(page, choice) {
  if (!choice) throw new Error('No model choice selected');
  const currentChoiceEffort = choice.row?.selectedEffort || choice.row?.effort || '';
  if (choice.requiresEffortSelection || (choice.effort && normalizeModelLabel(currentChoiceEffort) !== normalizeModelLabel(choice.effort) && choice.row?.effortTestid)) {
    await setEffortForMenuRow(page, choice.row, choice.effort);
    await page.waitForTimeout(700);
    const stateAfterEffort = await getTargetAppState(page).catch(() => null);
    const selectionAfterEffort = parseModeAndEffort(stateAfterEffort?.model || '');
    if (choice.mode && normalizeModelLabel(selectionAfterEffort.mode) === normalizeModelLabel(choice.mode)) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
      return;
    }
    await openModelSwitcher(page);
  }
  let state = await getModelMenuState(page);
  const freshRow = (state.rows || []).find((row) => choiceMatchesSelection({
    label: row.label,
    mode: row.mode,
    effort: row.effort || '',
  }, { mode: choice.mode, effort: choice.effort }))
    || (choice.row?.testid ? (state.rows || []).find((row) => row.testid === choice.row.testid) : null)
    || (state.rows || []).find((row) => normalizeModelLabel(row.label) === normalizeModelLabel(choice.row?.label || ''))
    || choice.row;
  if (!await clickModelMenuRow(page, freshRow)) {
    throw new Error(`No visible model option matching: ${modelChoiceLabel(choice)}`);
  }
  await page.waitForTimeout(700);
}

async function applySliderModelSelection(page, selection, menuState, label) {
  // 1. Model selection
  if (selection.model) {
    let targetModelRegex = null;
    if (selection.model === '5.6' || /5\.6|sol/i.test(selection.normalized)) {
      targetModelRegex = /5\.6|sol/i;
    } else if (selection.model === '5.5' || /5\.5/i.test(selection.normalized)) {
      targetModelRegex = /5\.5/i;
    } else if (selection.model === 'Latest' || /latest|astra|(?<!\.)\b6\b(?!\.)/i.test(selection.normalized)) {
      targetModelRegex = /latest/i;
    } else {
      targetModelRegex = new RegExp(selection.model, 'i');
    }

    const currentChecked = await page.evaluate(() => {
      const checkedRadio = Array.from(document.querySelectorAll('[role="menuitemradio"]')).find((r) => r.getAttribute('aria-checked') === 'true');
      return checkedRadio ? (checkedRadio.innerText || '').trim() : '';
    });

    if (!targetModelRegex.test(currentChecked)) {
      // Ensure advanced view is open
      await page.evaluate(() => {
        const menu = document.querySelector('.d1BZWq_Menu, [role="menu"]');
        const toggle = document.querySelector('[class*="ViewToggle"], [aria-label="Select model"], [aria-label*="model" i]');
        if (menu && menu.getAttribute('data-view') !== 'advanced' && toggle) {
          toggle.click();
        }
      });
      await page.waitForTimeout(400);

      // Click target model radio via evaluate click
      await page.evaluate((pattern) => {
        const regex = new RegExp(pattern, 'i');
        const target = Array.from(document.querySelectorAll('[role="menuitemradio"]')).find((r) => regex.test(r.innerText || ''));
        if (target) {
          target.click();
          return target.innerText.trim();
        }
        return null;
      }, targetModelRegex.source);
      await page.waitForTimeout(400);
    }
  }

  // 2. Effort selection
  const targetEffort = selection.effort || (selection.mode === 'Instant' ? 'Instant' : (selection.mode === 'Pro' ? 'Pro' : ''));
  if (targetEffort) {
    const effortMap = {
      'instant': 0, 'fast': 0, 'auto': 0,
      'medium': 1, 'light': 1, 'low': 1,
      'high': 2, 'standard': 2,
      'extra high': 3, 'extended': 3,
      'pro': 4, 'heavy': 4,
    };
    const targetIndex = effortMap[targetEffort.toLowerCase()];
    if (targetIndex !== undefined) {
      // Ensure simple view is open
      await page.evaluate(() => {
        const menu = document.querySelector('.d1BZWq_Menu, [role="menu"]');
        const toggle = document.querySelector('[class*="ViewToggle"], [aria-label="Select model"], [aria-label*="model" i]');
        if (menu && menu.getAttribute('data-view') === 'advanced' && toggle) {
          toggle.click();
        }
      });
      await page.waitForTimeout(400);

      const openMenus = page.locator('[role="menu"][data-state="open"], [data-radix-popper-content-wrapper] [role="menu"]');
      const menuCount = await openMenus.count();
      const matchingMenus = [];
      for (let i = 0; i < menuCount; i++) {
        const candidate = openMenus.nth(i);
        if (await candidate.locator('[role="slider"]').count() === 1) {
          matchingMenus.push(candidate);
        }
      }
      if (matchingMenus.length === 0) {
        throw cbError('REASONING_SELECTION_UNVERIFIED', 'Could not locate active open model menu containing exactly one reasoning slider');
      }
      if (matchingMenus.length > 1) {
        throw cbError('REASONING_SELECTION_AMBIGUOUS', `Multiple open menus (${matchingMenus.length}) contain a reasoning slider`);
      }
      const targetMenu = matchingMenus[0];

      const slider = targetMenu.locator('[role="slider"]');
      const sliderControl = targetMenu.locator('[aria-label="Power"], [class*="SliderKeyboardControl"], [role="menuitem"]:has([role="slider"]), [role="slider"]');
      const controlToFocus = (await sliderControl.count()) ? sliderControl.first() : slider.first();
      await controlToFocus.focus();
      let currentVal = parseInt(await slider.first().getAttribute('aria-valuenow') || '-1', 10);
      let steps = 0;
      while (currentVal !== targetIndex && steps < 10) {
        steps++;
        if (currentVal < targetIndex) {
          await page.keyboard.press('ArrowRight');
        } else {
          await page.keyboard.press('ArrowLeft');
        }
        await page.waitForTimeout(100);
        const nextVal = parseInt(await slider.first().getAttribute('aria-valuenow') || '-1', 10);
        if (nextVal === currentVal) break;
        currentVal = nextVal;
      }
      if (currentVal !== targetIndex) {
        throw cbError('REASONING_SELECTION_UNVERIFIED', `Slider adjustment failed: reached valuenow ${currentVal}, expected ${targetIndex}`);
      }
    }
  }

  // Close picker
  await page.keyboard.press('Escape').catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);

  const stateAfter = await getTargetAppState(page).catch(() => null);
  const parsedAfter = parseModeAndEffort(stateAfter?.model || '');
  if (targetEffort && normalizeModelLabel(parsedAfter.effort || parsedAfter.mode || '').toLowerCase() !== normalizeModelLabel(targetEffort).toLowerCase()) {
    throw cbError('REASONING_SELECTION_UNVERIFIED', `Model effort post-verification failed: expected "${targetEffort}", got "${stateAfter?.model || 'unknown'}"`);
  }

  const selectedPill = await page.evaluate(() => {
    const btn = document.querySelector('form button.__composer-pill, form button:not(#composer-plus-btn)[aria-haspopup="menu"]');
    return btn ? btn.innerText.replace(/\s+/g, ' ').trim() : '';
  });

  const available = (menuState.models || []).map((m) => m.label).concat(
    (menuState.efforts || []).map((e) => e.label)
  );

  return {
    requested: label,
    selected: selectedPill || label,
    fallback: false,
    available,
  };
}

async function selectModel(page, label) {
  const selection = parseModelSelection(label);
  const currentButtonSelection = parseModeAndEffort((await getTargetAppState(page).catch(() => null))?.model || '');
  if (!await openModelSwitcher(page)) throw new Error('No visible model picker found');
  const menuState = await getModelMenuState(page);
  if (menuState.hasSlider) {
    return applySliderModelSelection(page, selection, menuState, label);
  }
  let state = await hydrateModelRows(page, menuState.rows, currentButtonSelection);
  const currentModel = state.current?.model || '';
  const needsConfigure = Boolean(selection.model && (!currentModel || selection.model !== currentModel));
  if (needsConfigure) {
    await selectInConfigureModal(page, selection);
    return {
      requested: label,
      selected: label,
      fallback: false,
      available: modelChoicesFromRows(state.rows).map(modelChoiceLabel),
    };
  }

  const targetMode = selection.mode
    || (selection.effort ? parseModeAndEffort((await getTargetAppState(page).catch(() => null))?.model || '').mode : '');
  if (targetMode && !selection.mode) selection.mode = targetMode;
  const choices = modelChoicesFromRows(state.rows);
  let choice = choices.find((item) => choiceMatchesSelection(item, selection));
  let fallback = false;

  if (!choice) {
    if (selection.model || selection.mode || selection.effort) {
      choice = chooseFallbackModelChoice(choices, selection);
      fallback = Boolean(choice);
      if (!choice) {
        await selectInConfigureModal(page, selection);
        return {
          requested: label,
          selected: label,
          fallback: false,
          available: choices.map(modelChoiceLabel),
        };
      }
    } else {
      await clickOptionByText(page, label);
      return {
        requested: label,
        selected: label,
        fallback: false,
        available: choices.map(modelChoiceLabel),
      };
    }
  }

  await applyModelChoice(page, choice);
  return {
    requested: label,
    selected: modelChoiceLabel(choice),
    fallback,
    available: choices.map(modelChoiceLabel),
  };
}

async function selectReasoning(page, label) {
  const selection = parseModelSelection(label);
  const state = await getTargetAppState(page).catch(() => null);
  const currentModelLabel = state?.model || '';
  const currentParsed = parseModeAndEffort(currentModelLabel);
  const currentEffort = normalizeModelLabel(currentParsed.effort || currentModelLabel);
  const targetEffort = normalizeModelLabel(selection.effort || '');
  const currentMode = normalizeModelLabel(currentParsed.mode || '');
  const targetMode = normalizeModelLabel(selection.mode || '');
  const noModelOverride = !selection.model;

  if (noModelOverride && targetEffort && currentEffort.toLowerCase() === targetEffort.toLowerCase() && (!targetMode || currentMode.toLowerCase() === targetMode.toLowerCase())) {
    info(`[reasoning] "${currentModelLabel}" is already selected (mode: ${currentMode || 'none'}, effort: ${currentEffort}); skipping switcher`);
    return {
      requested: label,
      selected: currentModelLabel,
      fallback: false,
      available: [currentModelLabel],
    };
  }

  if (!selection.mode && selection.effort) {
    selection.mode = currentParsed.mode;
  }
  const requested = [selection.mode, selection.effort].filter(Boolean).join(' ') || label;
  const result = await selectModel(page, requested);
  if (result) result.requested = label;
  return result;
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
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.locator('#prompt-textarea, [data-testid="composer-input"], div[contenteditable="true"]').last()
    .waitFor({ state: 'visible', timeout: 5000 })
    .catch(() => {});
  await page.waitForTimeout(500);
}

async function openNewConversation(page) {
  const currentRouteId = routeSessionIdFromUrl(page.url());
  const isCanonicalRoot = isTargetAppUrl(page.url()) && !currentRouteId;
  if (isCanonicalRoot) {
    await settlePage(page);
    return;
  }
  await page.goto(targetAppUrl(), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await settlePage(page);
}

async function waitForConversationHydration(page, sessionId, timeoutMs = CONVERSATION_HYDRATION_TIMEOUT_MS) {
  if (!STABLE_SESSION_ID_RE.test(sessionId || '')) {
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
        if (cIndex === -1 || !parts[cIndex + 1]) return '';
        const decoded = decodeURIComponent(parts[cIndex + 1]);
        if (/^WEB:[a-f0-9-]{20,}$/i.test(decoded)) {
          return decoded;
        }
        const m = decoded.match(/^(?:local-chatgpt:)?([a-f0-9-]{20,})$/i);
        return m ? m[1] : '';
      };
      const turns = [...document.querySelectorAll('[data-testid^="conversation-turn-"], [data-turn-key], [data-content-search-turn-key]')].filter(isVisible);
      const roleNodes = [...document.querySelectorAll('[data-message-author-role], [data-turn-key]')].filter(isVisible);
      const composer = [...document.querySelectorAll('#prompt-textarea, [data-testid="composer-input"], div[contenteditable="true"]')].find(isVisible);
      const currentSessionId = sessionIdFromLocation();
      return {
        hydrated: currentSessionId === expectedSessionId && (turns.length > 0 || roleNodes.length > 0) && Boolean(composer),
        sessionId: currentSessionId,
        turnCount: turns.length,
        roleNodeCount: roleNodes.length,
        composerVisible: Boolean(composer),
      };
    }, sessionId).catch(() => last);

    if (last.hydrated) return last;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(500);
  }

  return { ...last, hydrated: false, timedOut: true };
}

async function reloadExactConversation(page, expectedSessionId, phase = 'exact-reload') {
  if (!STABLE_SESSION_ID_RE.test(expectedSessionId || '')) {
    throw cbError('INVALID_TARGET_SESSION', `reloadExactConversation: invalid target session id: ${expectedSessionId}`, { expectedSessionId, phase });
  }
  await assertThreadIdentity(page, expectedSessionId, `${phase}: before reload`);
  info(`[recovery] Reloading exact conversation ${expectedSessionId} (${phase})...`);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await settlePage(page);
  const hydration = await waitForConversationHydration(page, expectedSessionId);
  if (!hydration.hydrated) {
    throw cbError(
      'CONVERSATION_NOT_HYDRATED',
      `Conversation ${expectedSessionId} did not hydrate after reload (${phase})`,
      { sessionId: expectedSessionId, hydration, url: page.url(), phase }
    );
  }
  await assertThreadIdentity(page, expectedSessionId, `${phase}: after reload`);
  info(`[recovery] Exact conversation ${expectedSessionId} reloaded and hydrated.`);
  return hydration;
}

async function openConversationBySessionId(page, sessionId) {
  if (!STABLE_SESSION_ID_RE.test(sessionId || '')) {
    throw cbError('INVALID_TARGET_SESSION', `Invalid target app session id: ${sessionId}`, { sessionId });
  }
  if (sessionIdFromUrl(page.url()) !== sessionId) {
    await page.goto(targetConversationUrl(sessionId), { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  await settlePage(page);
  const hydration = await waitForConversationHydration(page, sessionId);
  if (!hydration.hydrated) {
    throw cbError(
      'CONVERSATION_NOT_HYDRATED',
      `Conversation ${sessionId} did not hydrate before access`,
      { sessionId, hydration, url: page.url() }
    );
  }
  await assertThreadIdentity(page, sessionId, 'after hydration');
  return hydration;
}

function validateStage1Mode(args) {
  if (!args.retryEdit) return;

  if (args.retryEdit !== 'latest') {
    throw cbError('INVALID_STAGE1_MODE', `--retry-edit currently only supports "latest", got "${args.retryEdit}"`);
  }
  if (!args.recoveryIncidentId || !args.recoveryIncidentId.trim()) {
    throw cbError('RECOVERY_INCIDENT_REQUIRED', '--retry-edit requires --recovery-incident <id>');
  }
  if (typeof args.editSuffix !== 'string' || !args.editSuffix.length) {
    throw cbError('EDIT_SUFFIX_REQUIRED', '--edit-suffix cannot be empty');
  }
  if (typeof args.message === 'string' && args.message.length > 0) {
    throw cbError('INVALID_STAGE1_MODE', '--retry-edit cannot be combined with --message');
  }
  if (args.recoveryResend) {
    throw cbError('INVALID_STAGE1_MODE', '--retry-edit cannot be combined with --recovery-resend');
  }
  if (args.newConversation) {
    throw cbError('INVALID_STAGE1_MODE', '--retry-edit cannot be combined with --new-conversation');
  }
  if (args.schedule || args.runQueue || args.queueWatch || args.queueStatus || args.recoverQueue) {
    throw cbError('INVALID_STAGE1_MODE', '--retry-edit cannot be combined with scheduling or queue operations');
  }
  const conflictingStage1Actions = [
    args.status,
    args.watchState,
    args.waitReady,
    args.syncTranscript,
    args.latestAssistant,
    args.dismissBlocker,
    Boolean(args.searchQuery),
    args.models,
    args.stop,
    args.compactConversation,
    args.handoffNewSession,
    args.recoverInterrupted,
    args.downloadArtifacts,
  ];
  if (conflictingStage1Actions.some(Boolean)) {
    throw cbError('INVALID_STAGE1_MODE', '--retry-edit cannot be combined with another primary operation');
  }
}

function sameTurnRevision(turn, ref) {
  if (!turn || !ref) return false;
  const hashMatches = messageHash(normalizeTurnText(turn.text)) === ref.textHash;
  if (!hashMatches) return false;

  const turnId = turn.messageId || turn.id || '';
  const refId = ref.messageId || ref.id || '';

  // Strong message identity wins when both sides expose it
  if (turnId && refId) {
    return turnId === refId;
  }

  // Only fall back to positional/testid identity when message ID is unavailable
  if (turn.testid && ref.testid) {
    return turn.testid === ref.testid;
  }

  return false;
}

async function resolveEditableUserTurn(page, selection = 'latest', editSuffix = '.', expectedHash = null) {
  const turns = await page.$$eval('[data-message-author-role]', els => els.map(e => ({
    role: e.getAttribute('data-message-author-role'),
    id: e.getAttribute('data-message-id') || '',
    testid: e.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') || '',
    text: e.textContent || ''
  })));

  const userTurns = turns.filter(t => t.role === 'user');
  if (!userTurns.length) {
    throw cbError('EDIT_SOURCE_UNVERIFIED', 'No user turns found on active conversation page');
  }

  let sourceUser = null;
  if (selection && selection !== 'latest') {
    sourceUser = userTurns.find(t =>
      (t.id && t.id === selection) ||
      (t.testid && t.testid === selection)
    );
    if (!sourceUser) {
      throw cbError('EDIT_SOURCE_NOT_FOUND', `Could not find source user turn matching ${selection}`);
    }
  } else {
    sourceUser = userTurns[userTurns.length - 1];
  }

  if (sourceUser !== userTurns[userTurns.length - 1]) {
    throw cbError('CONCURRENT_CONVERSATION_MUTATION', 'Selected user turn is no longer the latest user turn in thread');
  }
  const originalText = sourceUser.text;
  const originalHash = messageHash(normalizeTurnText(originalText));

  if (expectedHash && originalHash !== expectedHash) {
    throw cbError('REVISION_HASH_DRIFT', `User turn revision textHash ${originalHash} does not match frozen hash ${expectedHash}`);
  }

  const editedText = `${originalText.trimEnd()}${editSuffix}`;
  const editedHash = messageHash(normalizeTurnText(editedText));

  if (originalHash === editedHash) {
    throw cbError('EDIT_MUTATION_NOT_DISTINCT', `Suffix "${editSuffix}" does not produce a distinct turn hash after text normalization`);
  }

  const canonicalTurns = await getConversationTurns(page).catch(() => []);
  if (!canonicalTurns || !canonicalTurns.length) {
    throw cbError('EDIT_SOURCE_UNVERIFIED', 'Could not extract canonical conversation turns from page');
  }

  const sourceUserIdx = canonicalTurns.findIndex(t =>
    (sourceUser.id && t.messageId === sourceUser.id) ||
    (sourceUser.testid && t.testid === sourceUser.testid)
  );
  if (sourceUserIdx === -1) {
    throw cbError('EDIT_SOURCE_UNVERIFIED', 'Selected source user turn was not found within canonical conversation turns');
  }

  let sourceAssistant = null;
  if (sourceUserIdx + 1 < canonicalTurns.length) {
    const nextTurn = canonicalTurns[sourceUserIdx + 1];
    if (nextTurn.role === 'assistant') {
      sourceAssistant = {
        messageId: nextTurn.messageId || nextTurn.id || '',
        id: nextTurn.messageId || nextTurn.id || '',
        testid: nextTurn.testid || '',
        role: 'assistant',
        text: nextTurn.text,
        textHash: messageHash(normalizeTurnText(nextTurn.text)),
      };
    }
  }

  return {
    sourceUser: {
      messageId: sourceUser.id,
      id: sourceUser.id,
      testid: sourceUser.testid,
      role: 'user',
      text: originalText,
      textHash: originalHash,
    },
    sourceAssistant,
    originalText,
    editedText,
    originalHash,
    editedHash,
  };
}

function inlineEditorContainer(editor) {
  return editor.locator(
    'xpath=ancestor::*[' +
      './/button[normalize-space(.)="Cancel"] and ' +
      './/button[normalize-space(.)="Send"]' +
    '][1]'
  );
}

async function readInlineEditorSource(editor) {
  let text = '';
  let method = 'none';
  if (typeof editor.innerText === 'function') {
    text = await editor.innerText().catch(() => '');
    if (text) {
      method = 'prosemirror_innerText';
    }
  }
  if (!text && typeof editor.textContent === 'function') {
    text = await editor.textContent().catch(() => '');
    if (text) {
      method = 'prosemirror_textContent_fallback';
    }
  }
  return {
    text: String(text).replace(/\r\n?/g, '\n'),
    method: method === 'none' ? 'prosemirror_innerText' : method,
  };
}

async function openUserTurnEditor(page, sourceUserTurn) {
  let turnRoot = null;
  if (sourceUserTurn.testid) {
    turnRoot = page.locator(`[data-testid="${sourceUserTurn.testid}"]`).first();
  }
  if (!turnRoot || !(await turnRoot.count().catch(() => 0))) {
    if (sourceUserTurn.id) {
      turnRoot = page.locator(`[data-message-id="${sourceUserTurn.id}"]`).first();
    }
  }
  if (!turnRoot || !(await turnRoot.count().catch(() => 0))) {
    throw cbError('EDIT_SOURCE_UNVERIFIED', `Could not locate turn root for user turn ${sourceUserTurn.id || sourceUserTurn.testid}`);
  }

  await turnRoot.scrollIntoViewIfNeeded().catch(() => {});
  await turnRoot.hover().catch(() => {});
  await page.waitForTimeout(300);

  const editBtn = turnRoot.locator('button[aria-label="Edit message"], button[aria-label*="Edit"]').first();
  if (!(await editBtn.count().catch(() => 0)) || !(await editBtn.isVisible().catch(() => false))) {
    throw cbError('EDIT_CONTROL_NOT_FOUND', `Could not find visible Edit button on user turn ${sourceUserTurn.id || sourceUserTurn.testid}`);
  }

  await editBtn.click();
  await page.waitForTimeout(500);

  let editor = null;
  if (sourceUserTurn.id) {
    const exactLocator = turnRoot.locator(`div[id="message-edit-${sourceUserTurn.id}"][contenteditable="true"]`);
    const count = await exactLocator.count().catch(() => 0);
    if (count !== 1) {
      throw cbError('EDIT_EDITOR_NOT_FOUND', `Expected exactly 1 matching message-edit editor for turn ${sourceUserTurn.id}, found ${count}`);
    }
    editor = exactLocator.first();
  } else {
    const genericLocator = turnRoot.locator('div[contenteditable="true"].ProseMirror');
    if (!(await genericLocator.count().catch(() => 0))) {
      throw cbError('EDIT_EDITOR_NOT_FOUND', `Could not find inline editor for user turn ${sourceUserTurn.testid}`);
    }
    editor = genericLocator.first();
  }
  if (!(await editor.isVisible().catch(() => false))) {
    throw cbError('EDIT_EDITOR_NOT_FOUND', `Inline editor for user turn ${sourceUserTurn.id || sourceUserTurn.testid} is not visible`);
  }

  return { turnRoot, editor };
}

async function populateAndVerifyEditor(page, editor, sourceUserTurn, originalText, editSuffix, editedText) {
  const container = inlineEditorContainer(editor);
  const cancelBtn = container.locator('button:has-text("Cancel"), button[aria-label="Cancel"]').first();

  const initialSource = await readInlineEditorSource(editor);
  const initialRaw = initialSource.text;
  if (!initialRaw.trim()) {
    if (await cancelBtn.isVisible().catch(() => false)) {
      await cancelBtn.click().catch(() => {});
    }
    throw cbError('EDIT_EDITOR_MISMATCH', 'Initial inline editor text is empty');
  }

  const expectedEditorText = `${initialRaw}${editSuffix}`;

  if (typeof editor.focus === 'function') {
    await editor.focus().catch(() => {});
  }
  if (typeof editor.evaluate === 'function') {
    await editor.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }).catch(() => {});
  }
  if (page?.keyboard?.insertText) {
    await page.keyboard.insertText(editSuffix);
    if (typeof page.waitForTimeout === 'function') {
      await page.waitForTimeout(300);
    }
  }

  let populatedSource = await readInlineEditorSource(editor);
  let attempts = 0;
  while (populatedSource.text !== expectedEditorText && attempts < 10) {
    if (typeof page?.waitForTimeout === 'function') {
      await page.waitForTimeout(100);
    }
    populatedSource = await readInlineEditorSource(editor);
    attempts++;
  }

  if (populatedSource.text !== expectedEditorText) {
    if (await cancelBtn.isVisible().catch(() => false)) {
      await cancelBtn.click().catch(() => {});
    }
    throw cbError('EDIT_EDITOR_POPULATION_FAILED', 'Inline editor content verification failed after text insertion');
  }

  let actualDomId = '';
  if (typeof editor.getAttribute === 'function') {
    actualDomId = await editor.getAttribute('id').catch(() => '');
  }
  if (!actualDomId && sourceUserTurn?.id) {
    actualDomId = `message-edit-${sourceUserTurn.id}`;
  }

  return {
    sourceMethod: initialSource.method,
    editorId: actualDomId || 'prosemirror',
    sourceHash: crypto.createHash('sha256').update(initialRaw).digest('hex'),
    expectedHash: crypto.createHash('sha256').update(expectedEditorText).digest('hex'),
    suffix: editSuffix,
  };
}

async function submitEditedUserTurn(page, editor, expectedSessionId, editorAttestation = null) {
  const container = inlineEditorContainer(editor);
  const sendBtns = container.locator('button:has-text("Send"), button[aria-label="Send"]');
  const cancelBtn = container.locator('button:has-text("Cancel"), button[aria-label="Cancel"]').first();

  const count = await sendBtns.count().catch(() => 0);
  if (count !== 1) {
    if (await cancelBtn.isVisible().catch(() => false)) {
      await cancelBtn.click().catch(() => {});
    }
    throw cbError('EDIT_SUBMIT_CONTROL_UNVERIFIED', `Expected exactly 1 scoped Send button for inline editor, found ${count}`);
  }

  const sendBtn = sendBtns.first();
  if (!(await sendBtn.isVisible().catch(() => false)) || !(await sendBtn.isEnabled().catch(() => false))) {
    if (await cancelBtn.isVisible().catch(() => false)) {
      await cancelBtn.click().catch(() => {});
    }
    throw cbError('EDIT_SUBMIT_CONTROL_UNVERIFIED', 'Scoped Send button is not visible and enabled');
  }

  await assertThreadIdentity(page, expectedSessionId, 'immediately before edit submission');
  let generation;
  try {
    generation = await getCombinedGenerationState(page);
  } catch (genErr) {
    if (await cancelBtn.isVisible().catch(() => false)) {
      await cancelBtn.click().catch(() => {});
    }
    throw genErr;
  }
  if (generation.isGenerating) {
    if (await cancelBtn.isVisible().catch(() => false)) {
      await cancelBtn.click().catch(() => {});
    }
    throw cbError('CONVERSATION_BUSY', 'Generation became active before edit could be submitted');
  }

  if (editorAttestation && editorAttestation.expectedHash) {
    const preSubmitSource = await readInlineEditorSource(editor);
    const preSubmitHash = crypto.createHash('sha256').update(preSubmitSource.text).digest('hex');
    if (preSubmitHash !== editorAttestation.expectedHash) {
      if (await cancelBtn.isVisible().catch(() => false)) {
        await cancelBtn.click().catch(() => {});
      }
      throw cbError('EDIT_EDITOR_CHANGED_BEFORE_SUBMIT', 'Editor source content mutated between population and submission boundary');
    }
  }

  return sendBtn;
}

async function waitForEditedTurnAccepted(page, sourceUserTurn, editedHash, expectedSessionId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await assertThreadIdentity(page, expectedSessionId, 'while waiting for edited turn acceptance');

    const turns = await page.$$eval('[data-message-author-role="user"]', els => els.map(e => ({
      id: e.getAttribute('data-message-id') || '',
      testid: e.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') || '',
      text: e.textContent || ''
    })));

    const matchingTurns = [];
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const h = messageHash(normalizeTurnText(turn.text));
      if (h === editedHash) {
        matchingTurns.push({ turn, index: i });
      }
    }

    if (matchingTurns.length > 0) {
      // 1. Same messageId match
      const sameId = matchingTurns.find(m => m.turn.id && m.turn.id === sourceUserTurn.id);
      if (sameId) {
        return {
          acceptedTurn: {
            messageId: sameId.turn.id,
            testid: sameId.turn.testid,
            role: 'user',
            textHash: editedHash,
          },
          attestationMethod: 'same_message_id_edited_hash',
        };
      }

      // 2. Same testid match
      const sameTestid = matchingTurns.find(m => m.turn.testid && m.turn.testid === sourceUserTurn.testid);
      if (sameTestid) {
        return {
          acceptedTurn: {
            messageId: sameTestid.turn.id,
            testid: sameTestid.turn.testid,
            role: 'user',
            textHash: editedHash,
          },
          attestationMethod: 'same_testid_edited_hash',
        };
      }

      // 3. Structural fallback: requires exactly ONE candidate and it MUST be the latest user turn
      if (matchingTurns.length === 1 && matchingTurns[0].index === turns.length - 1) {
        const candidate = matchingTurns[0].turn;
        return {
          acceptedTurn: {
            messageId: candidate.id,
            testid: candidate.testid,
            role: 'user',
            textHash: editedHash,
          },
          attestationMethod: 'structural_latest_edited_hash',
        };
      }
    }

    await page.waitForTimeout(300);
  }

  throw cbError('EDIT_ATTRIBUTION_UNVERIFIED', 'Timed out waiting for edited user turn to be accepted in DOM');
}


async function resolveUserTurnRoot(page, sourceUserTurn) {
  let turnRoot = null;
  if (sourceUserTurn.testid) {
    turnRoot = page.locator(`[data-testid="${sourceUserTurn.testid}"]`).first();
  }
  if (!turnRoot || !(await turnRoot.count().catch(() => 0))) {
    if (sourceUserTurn.id) {
      turnRoot = page.locator(`[data-message-id="${sourceUserTurn.id}"]`).first();
    }
  }
  if (!turnRoot || !(await turnRoot.count().catch(() => 0))) {
    throw cbError('EDIT_SOURCE_UNVERIFIED', `Could not locate turn root for user turn ${sourceUserTurn.id || sourceUserTurn.testid}`);
  }
  return turnRoot;
}

async function resolveNumericVersionIndex(page, viewerHeader) {
  let labelEl = viewerHeader.locator('div:has-text("Version")').first();
  if (!(await labelEl.count().catch(() => 0))) {
    labelEl = viewerHeader.locator('div:has-text("Current version")').first();
  }
  if (!(await labelEl.count().catch(() => 0))) {
    labelEl = viewerHeader.locator('div.font-semibold').first();
  }
  if (!(await labelEl.count().catch(() => 0))) {
    throw cbError('EDIT_VERSION_VIEWER_UNVERIFIED', 'Version indicator label element not found in viewer header');
  }
  const text = await labelEl.innerText().catch(() => '');
  const m = text.match(/Version\s*(\d+)/i);
  if (m) {
    return { numericIndex: parseInt(m[1], 10), labelKind: 'numeric' };
  }
  if (/Current version/i.test(text)) {
    const prevBtn = viewerHeader.locator('button[aria-label="Previous version"]').first();
    const nextBtn = viewerHeader.locator('button[aria-label="Next version"]').first();
    const isPrevDisabled = await prevBtn.isDisabled().catch(() => false);
    if (isPrevDisabled) {
      return { numericIndex: 1, labelKind: 'current' };
    }
    await prevBtn.click();
    await page.waitForTimeout(250);
    let predLabelEl = viewerHeader.locator('div:has-text("Version")').first();
    if (!(await predLabelEl.count().catch(() => 0))) {
      predLabelEl = viewerHeader.locator('div.font-semibold').first();
    }
    const predText = await predLabelEl.innerText().catch(() => '');
    const predM = predText.match(/Version\s*(\d+)/i);
    if (!predM) {
      throw cbError('EDIT_VERSION_VIEWER_UNVERIFIED', `Failed to resolve predecessor numeric version from label "${predText}"`);
    }
    const predIndex = parseInt(predM[1], 10);
    await nextBtn.click();
    await page.waitForTimeout(250);
    const restoredNextDisabled = await nextBtn.isDisabled().catch(() => false);
    if (!restoredNextDisabled) {
      throw cbError('EDIT_VERSION_VIEWER_UNVERIFIED', 'Failed to restore Current version with Next disabled after predecessor probe');
    }
    return { numericIndex: predIndex + 1, labelKind: 'current' };
  }
  throw cbError('EDIT_VERSION_VIEWER_UNVERIFIED', `Malformed version label in viewer header: "${text}"`);
}

async function openAndResolveVersionViewer(page, turnRoot) {
  const variantsBtn = turnRoot.locator('button[data-testid="variants-turn-action-button"]').first();
  if (!(await variantsBtn.count().catch(() => 0))) {
    throw cbError('EDIT_VERSION_VIEWER_UNVERIFIED', 'Variants action button is absent on turn root');
  }

  if (typeof variantsBtn.scrollIntoViewIfNeeded === 'function') {
    await variantsBtn.scrollIntoViewIfNeeded().catch(() => {});
  }
  await page.waitForTimeout(200);

  try {
    await variantsBtn.click({ timeout: 2000 });
  } catch {
    await variantsBtn.click({ force: true });
  }

  let viewerHeader = null;
  let closeBtn = null;

  const prevLoc = page.locator('button[aria-label="Previous version"]');
  const prevAnchor = typeof prevLoc.first === 'function' ? prevLoc.first() : (typeof prevLoc.last === 'function' ? prevLoc.last() : prevLoc);

  if (prevAnchor && typeof prevAnchor.waitFor === 'function') {
    await prevAnchor.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  }

  if (prevAnchor && typeof prevAnchor.locator === 'function') {
    try {
      const candidateRoot = prevAnchor.locator(
        'xpath=ancestor::*[' +
          './/button[@aria-label="Next version"] and ' +
          './/button[@data-testid="close-button"]' +
        '][1]'
      );
      if (candidateRoot && typeof candidateRoot.locator === 'function') {
        const h = candidateRoot.locator('div:has(> button[aria-label="Previous version"])');
        const c = candidateRoot.locator('button[data-testid="close-button"][aria-label="Close"]');
        if (h && typeof h.first === 'function' && (await h.first().count().catch(() => 0))) {
          viewerHeader = h.first();
          closeBtn = c.first();
        }
      }
    } catch {}
  }

  // Fallback ONLY allowed in test environments where page is a mock without context/CDP
  if (!viewerHeader && (!page.context || typeof page.context !== 'function' || page._isMockPage)) {
    const headerLoc = page.locator('div:has(> button[aria-label="Previous version"])');
    viewerHeader = typeof headerLoc.last === 'function' ? headerLoc.last() : headerLoc;
    const closeLoc = page.locator('button[data-testid="close-button"][aria-label="Close"]');
    closeBtn = typeof closeLoc.last === 'function' ? closeLoc.last() : closeLoc;
  }

  if (!viewerHeader || !closeBtn) {
    throw cbError('EDIT_VERSION_VIEWER_UNVERIFIED', 'Failed to resolve structural version viewer ancestor container');
  }

  if (typeof closeBtn?.waitFor === 'function') {
    await closeBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  }
  if (typeof viewerHeader?.waitFor === 'function') {
    await viewerHeader.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  }

  if (closeBtn && typeof closeBtn.count === 'function') {
    if (!(await closeBtn.count().catch(() => 0)) || (typeof closeBtn.isVisible === 'function' && !(await closeBtn.isVisible().catch(() => false)))) {
      throw cbError('EDIT_VERSION_VIEWER_UNVERIFIED', 'Failed to open prompt version viewer header or close button');
    }
  }

  return { viewerHeader, closeBtn };
}

async function captureUserTurnVersionBaseline(page, sourceUserTurn, sourceAssistantTurn = null, roundId = null) {
  const turnRoot = await resolveUserTurnRoot(page, sourceUserTurn);

  await turnRoot.scrollIntoViewIfNeeded().catch(() => {});
  await turnRoot.hover().catch(() => {});
  await page.waitForTimeout(300);

  const actionsBar = turnRoot.locator('div[aria-label="Your message actions"]').first();
  const hasActionsBar = (await actionsBar.count().catch(() => 0)) > 0 && (await actionsBar.isVisible().catch(() => false));
  if (!hasActionsBar) {
    throw cbError('EDIT_VERSION_BASELINE_UNVERIFIED', 'Message actions bar not visible after hovering user turn; hydration incomplete');
  }

  const variantsBtn = turnRoot.locator('button[data-testid="variants-turn-action-button"]').first();
  const hasVariantsBtn = (await variantsBtn.count().catch(() => 0)) > 0 && (await variantsBtn.isVisible().catch(() => false));

  if (!hasVariantsBtn) {
    return {
      count: 1,
      activeIndex: 1,
      activeRenderedHash: sourceUserTurn.textHash || messageHash(normalizeTurnText(sourceUserTurn.text)),
      method: 'variants_ui_implicit_v1',
      capturedAt: nowIso(),
    };
  }

  const { viewerHeader, closeBtn } = await openAndResolveVersionViewer(page, turnRoot);



  const initialResolution = await resolveNumericVersionIndex(page, viewerHeader);
  const initialIndex = initialResolution.numericIndex;

  if (roundId) {
    updateRound(roundId, {
      versionProbe: {
        initialLabelKind: initialResolution.labelKind,
        initialActiveIndex: initialResolution.numericIndex,
        initialUserHash: sourceUserTurn.textHash || messageHash(normalizeTurnText(sourceUserTurn.text)),
        initialAssistantRef: sourceAssistantTurn,
        probedAt: nowIso(),
      },
    }, 'round_version_probed');
  }

  const nextBtn = viewerHeader.locator('button[aria-label="Next version"]').first();
  let currentIndex = initialIndex;
  let traversalSteps = 0;
  const MAX_TRAVERSAL = 50;

  while (traversalSteps < MAX_TRAVERSAL) {
    let isNextDisabled;
    try {
      isNextDisabled = await nextBtn.isDisabled();
    } catch (err) {
      throw cbError('EDIT_VERSION_VIEWER_UNVERIFIED', `Failed to determine Next version disabled state: ${err.message || err}`);
    }
    if (isNextDisabled) break;
    traversalSteps++;
    const before = currentIndex;
    await nextBtn.click();
    await page.waitForTimeout(250);
    const readVal = await resolveNumericVersionIndex(page, viewerHeader);
    currentIndex = readVal.numericIndex;
    if (currentIndex !== before + 1) {
      throw cbError('EDIT_VERSION_VIEWER_UNVERIFIED', `Next version step failed: expected ${before + 1}, got ${currentIndex}`);
    }
  }
  if (traversalSteps >= MAX_TRAVERSAL) {
    throw cbError('EDIT_VERSION_VIEWER_UNVERIFIED', 'Exceeded maximum version traversal bound without reaching latest version');
  }
  const totalCount = currentIndex;

  const prevBtn = viewerHeader.locator('button[aria-label="Previous version"]').first();
  while (currentIndex > initialIndex) {
    let isPrevDisabled;
    try {
      isPrevDisabled = await prevBtn.isDisabled();
    } catch (err) {
      throw cbError('EDIT_VERSION_VIEWER_UNVERIFIED', `Failed to determine Previous version disabled state: ${err.message || err}`);
    }
    if (isPrevDisabled) break;
    const before = currentIndex;
    await prevBtn.click();
    await page.waitForTimeout(250);
    const readVal = await resolveNumericVersionIndex(page, viewerHeader);
    currentIndex = readVal.numericIndex;
    if (currentIndex !== before - 1) {
      throw cbError('EDIT_VERSION_RESTORE_FAILED', `Previous version step failed: expected ${before - 1}, got ${currentIndex}`);
    }
  }

  if (currentIndex !== initialIndex) {
    await closeBtn.click().catch(() => {});
    throw cbError('EDIT_VERSION_RESTORE_FAILED', `Failed to restore initial prompt version ${initialIndex} (ended at ${currentIndex})`);
  }

  await closeBtn.click().catch(() => {});
  await page.waitForTimeout(300);

  // Re-attest restored user and assistant revisions
  const turns = await getConversationTurns(page);
  const restoredUser = turns.find(t => t.role === 'user' && sameTurnRevision(t, sourceUserTurn));
  if (!restoredUser || !turnRevisionMatchesRef(restoredUser, sourceUserTurn)) {
    throw cbError('EDIT_VERSION_RESTORE_FAILED', 'Restored user turn content does not match source user revision');
  }
  if (sourceAssistantTurn) {
    const restoredAssistant = turns.find(t => t.role === 'assistant' && sameTurnRevision(t, sourceAssistantTurn));
    if (!restoredAssistant || !turnRevisionMatchesRef(restoredAssistant, sourceAssistantTurn)) {
      throw cbError('EDIT_VERSION_RESTORE_FAILED', 'Restored assistant turn content does not match source assistant revision');
    }
  }

  return {
    count: totalCount,
    activeIndex: initialIndex,
    labelKind: initialResolution.labelKind,
    activeRenderedHash: sourceUserTurn.textHash || messageHash(normalizeTurnText(sourceUserTurn.text)),
    method: 'variants_ui_traversal',
    capturedAt: nowIso(),
  };
}

async function attestEditedUserTurnVersion(page, sourceUserTurn, baseline, editedHash) {
  const turnRoot = await resolveUserTurnRoot(page, sourceUserTurn);

  await turnRoot.scrollIntoViewIfNeeded().catch(() => {});
  await turnRoot.hover().catch(() => {});
  await page.waitForTimeout(300);

  const variantsBtn = turnRoot.locator('button[data-testid="variants-turn-action-button"]').first();
  const hasVariantsBtn = (await variantsBtn.count().catch(() => 0)) > 0 && (await variantsBtn.isVisible().catch(() => false));
  if (!hasVariantsBtn) {
    throw cbError('EDIT_VERSION_COUNT_MISMATCH', `Expected prompt version count ${baseline.count + 1}, but "See versions" button is absent`);
  }

  const { viewerHeader, closeBtn } = await openAndResolveVersionViewer(page, turnRoot);



  const activeResolution = await resolveNumericVersionIndex(page, viewerHeader);
  const activeVersion = activeResolution.numericIndex;
  const nextBtn = viewerHeader.locator('button[aria-label="Next version"]').first();
  let isNextDisabled;
  try {
    isNextDisabled = await nextBtn.isDisabled();
  } catch (err) {
    await closeBtn.click().catch(() => {});
    throw cbError('EDIT_VERSION_VIEWER_UNVERIFIED', `Failed to determine Next version disabled state: ${err.message || err}`);
  }

  const expectedVersion = baseline.count + 1;
  if (activeVersion !== expectedVersion || !isNextDisabled) {
    await closeBtn.click().catch(() => {});
    throw cbError('EDIT_VERSION_COUNT_MISMATCH', `Expected prompt Version ${expectedVersion} with Next disabled, got numeric Version ${activeVersion} (labelKind: ${activeResolution.labelKind}, nextDisabled: ${isNextDisabled})`);
  }

  const userMessageEl = turnRoot.locator('[data-message-author-role="user"]').first();
  const displayedText = await userMessageEl.innerText().catch(() => '');
  const displayedHash = messageHash(normalizeTurnText(displayedText));

  if (displayedHash !== editedHash) {
    await closeBtn.click().catch(() => {});
    throw cbError('EDIT_VERSION_CONTENT_MISMATCH', `Version ${activeVersion} displayed content hash does not match editedHash`);
  }

  await closeBtn.click().catch(() => {});
  await page.waitForTimeout(300);

  return {
    baselineCount: baseline.count,
    acceptedCount: expectedVersion,
    acceptedIndex: activeVersion,
    labelKind: activeResolution.labelKind,
    contentHash: displayedHash,
    nextDisabled: true,
    method: 'variants_ui_post_reload',
    commitBarrier: {
      method: 'exact_thread_reload',
      phase: 'stage1-post-submit-rehydration',
      verifiedAt: nowIso(),
    },
    verifiedAt: nowIso(),
  };
}

function stage1CommitIsAttested(round) {
  return Boolean(
    round &&
    round.dispatchState === 'accepted' &&
    round.versionBaseline &&
    typeof round.versionBaseline.count === 'number' &&
    round.versionAttestation &&
    round.versionAttestation.baselineCount === round.versionBaseline.count &&
    round.versionAttestation.acceptedCount === round.versionBaseline.count + 1 &&
    round.versionAttestation.contentHash === round.editedMessageHash &&
    round.versionAttestation.nextDisabled === true &&
    (
      round.versionAttestation.method === 'variants_ui_post_reload' ||
      round.versionAttestation.method === 'variants_ui_reconciled_post_reload' ||
      round.versionAttestation.commitBarrier?.method === 'exact_thread_reload'
    )
  );
}

async function reconcileStage1EditTurn(page, args, round) {
  if (!round || round.operationKind !== 'edit_retry' || round.recoveryStage !== 1) {
    return { outcome: 'not_applicable', round };
  }
  if (round.dispatchState === 'preparing') {
    if (round.versionProbe) {
      const sessionId = round.expectedSessionId || round.sessionId;
      if (sessionId && typeof page.reload === 'function') {
        try {
          await reloadExactConversation(page, sessionId, 'stage1-reconcile-preparing-reload');
          const sourceUser = round.sourceUserTurn;
          if (!sourceUser) {
            throw cbError('EDIT_VERSION_RESTORE_FAILED', 'Missing source user turn for preparing restoration');
          }
          const turnRoot = await resolveUserTurnRoot(page, sourceUser);
          await turnRoot.scrollIntoViewIfNeeded().catch(() => {});
          await turnRoot.hover().catch(() => {});
          await page.waitForTimeout(300);

          const variantsBtn = turnRoot.locator('button[data-testid="variants-turn-action-button"]').first();
          const hasVariants = (await variantsBtn.count().catch(() => 0)) > 0 && (await variantsBtn.isVisible().catch(() => false));
          if (!hasVariants) {
            throw cbError('EDIT_VERSION_RESTORE_FAILED', 'Variants action button absent or invisible after reload during preparing restoration');
          }

          const { viewerHeader, closeBtn } = await openAndResolveVersionViewer(page, turnRoot);

          const targetKind = round.versionProbe.initialLabelKind || 'current';
          const targetIndex = round.versionProbe.initialActiveIndex;

          if (targetKind === 'current') {
            const nextBtn = viewerHeader.locator('button[aria-label="Next version"]').first();
            while ((await nextBtn.count().catch(() => 0)) > 0 && !(await nextBtn.isDisabled().catch(() => true))) {
              await nextBtn.click().catch(() => {});
              await page.waitForTimeout(200);
            }
            const finalRes = await resolveNumericVersionIndex(page, viewerHeader);
            const isNextDis = await nextBtn.isDisabled().catch(() => false);
            if (!isNextDis || finalRes.labelKind !== 'current' || (typeof targetIndex === 'number' && finalRes.numericIndex !== targetIndex)) {
              throw cbError('EDIT_VERSION_RESTORE_FAILED', `Failed to restore Current version with Next disabled (got index ${finalRes.numericIndex}, labelKind ${finalRes.labelKind}, nextDisabled ${isNextDis}, expected index ${targetIndex})`);
            }
          } else if (typeof targetIndex === 'number') {
            let cur = await resolveNumericVersionIndex(page, viewerHeader);
            const prevBtn = viewerHeader.locator('button[aria-label="Previous version"]').first();
            const nextBtn = viewerHeader.locator('button[aria-label="Next version"]').first();
            while (cur.numericIndex > targetIndex && !(await prevBtn.isDisabled().catch(() => true))) {
              await prevBtn.click();
              await page.waitForTimeout(200);
              cur = await resolveNumericVersionIndex(page, viewerHeader);
            }
            while (cur.numericIndex < targetIndex && !(await nextBtn.isDisabled().catch(() => true))) {
              await nextBtn.click();
              await page.waitForTimeout(200);
              cur = await resolveNumericVersionIndex(page, viewerHeader);
            }
            if (cur.numericIndex !== targetIndex) {
              throw cbError('EDIT_VERSION_RESTORE_FAILED', `Failed to restore numeric version ${targetIndex}, ended at ${cur.numericIndex}`);
            }
          }

          await closeBtn.click().catch(() => {});
          await page.waitForTimeout(300);

          // Re-attest user turn hash matches initialUserHash
          const turns = await getConversationTurns(page);
          const restoredUser = turns.find(t => t.role === 'user' && sameTurnRevision(t, sourceUser));
          if (!restoredUser || !turnRevisionMatchesRef(restoredUser, sourceUser)) {
            throw cbError('EDIT_VERSION_RESTORE_FAILED', 'Restored user turn does not match initial user revision');
          }
          if (round.versionProbe.initialAssistantRef) {
            const restoredAssistant = turns.find(t => t.role === 'assistant' && sameTurnRevision(t, round.versionProbe.initialAssistantRef));
            if (!restoredAssistant || !turnRevisionMatchesRef(restoredAssistant, round.versionProbe.initialAssistantRef)) {
              throw cbError('EDIT_VERSION_RESTORE_FAILED', 'Restored assistant turn does not match initial assistant revision');
            }
          }

          const updated = updateRound(round.id, {
            status: 'failed',
            dispatchState: 'aborted_precommit',
            lastError: 'Process crashed during Stage 1 version baseline preparation; active branch positively restored',
          }, 'round_aborted_precommit');
          return { outcome: 'aborted_precommit', round: updated || Object.assign(round, { status: 'failed', dispatchState: 'aborted_precommit' }) };
        } catch (restorationErr) {
          const updated = updateRound(round.id, {
            status: 'failed',
            dispatchState: 'preparing_needs_reconciliation',
            lastError: `Active branch restoration failed: ${restorationErr.message || restorationErr}`,
          }, 'round_conflict');
          return { outcome: 'conflict', round: updated || Object.assign(round, { status: 'failed', dispatchState: 'preparing_needs_reconciliation' }) };
        }
      }
    }
    const updated = updateRound(round.id, {
      status: 'failed',
      dispatchState: 'aborted_precommit',
      lastError: 'Process exited before Stage 1 version baseline probe',
    }, 'round_aborted_precommit');
    return { outcome: 'aborted_precommit', round: updated || Object.assign(round, { status: 'failed', dispatchState: 'aborted_precommit' }) };
  }
  if (round.dispatchState === 'prepared') {
    const updated = updateRound(round.id, {
      status: 'failed',
      dispatchState: 'aborted_precommit',
      lastError: 'Process exited before Stage 1 edit submission',
    }, 'round_aborted_precommit');
    return { outcome: 'aborted_precommit', round: updated || Object.assign(round, { status: 'failed', dispatchState: 'aborted_precommit' }) };
  }
  if (round.dispatchState === 'accepted') {
    if (stage1CommitIsAttested(round)) {
      return { outcome: 'already_accepted', round };
    }
    return { outcome: 'uncertain', round };
  }
  const postDispatchStates = ['dispatching', 'client_accepted', 'commit_verifying', 'uncertain'];
  if (!postDispatchStates.includes(round.dispatchState)) {
    return { outcome: 'unchanged', round };
  }

  const sessionId = round.expectedSessionId || round.sessionId;
  if (!sessionId) {
    return { outcome: 'uncertain', round };
  }

  if (round.dispatchState === 'dispatching') {
    return { outcome: 'uncertain', round };
  }

  if (round.dispatchState === 'client_accepted') {
    const q = await waitForStage1PostSendQuiescence(page, sessionId, {
      acceptedUserTurnRef: round.clientAcceptedUserTurn || round.sourceUserTurn,
      priorAssistantTurnRef: round.sourceAssistantTurn,
      timeoutMs: 0,
    });
    if (!q.quiescent) {
      return { outcome: 'uncertain', round };
    }
    round = updateRound(round.id, {
      dispatchState: 'commit_verifying',
      quiescenceAttestation: q,
    }, 'round_commit_verifying') || round;
  }

  if (round.dispatchState === 'uncertain' && !round.quiescenceAttestation) {
    return { outcome: 'uncertain', round };
  }

  if (round.dispatchState !== 'commit_verifying' && !round.quiescenceAttestation) {
    return { outcome: 'uncertain', round };
  }

  await reloadExactConversation(page, sessionId, 'stage1-reconcile-reload');
  await assertThreadIdentity(page, sessionId, 'during stage1 crash reconciliation');

  const sourceUser = round.sourceUserTurn;
  const baseline = round.versionBaseline;
  const expectedHash = round.editedMessageHash;

  if (!sourceUser || !baseline || !expectedHash) {
    return { outcome: 'uncertain', round };
  }

  let turnRoot = null;
  try {
    turnRoot = await resolveUserTurnRoot(page, sourceUser);
    await turnRoot.scrollIntoViewIfNeeded().catch(() => {});
    await turnRoot.hover().catch(() => {});
    await page.waitForTimeout(300);
  } catch {
    return { outcome: 'uncertain', round };
  }

  const variantsBtn = turnRoot.locator('button[data-testid="variants-turn-action-button"]').first();
  const hasVariantsBtn = (await variantsBtn.count().catch(() => 0)) > 0 && (await variantsBtn.isVisible().catch(() => false));

  if (!hasVariantsBtn) {
    return { outcome: 'uncertain', round };
  }

  let viewerObj;
  try {
    viewerObj = await openAndResolveVersionViewer(page, turnRoot);
  } catch {
    return { outcome: 'uncertain', round };
  }
  const { viewerHeader, closeBtn } = viewerObj;

  let activeResolution;
  try {
    activeResolution = await resolveNumericVersionIndex(page, viewerHeader);
  } catch {
    await closeBtn.click().catch(() => {});
    return { outcome: 'uncertain', round };
  }

  const activeVersion = activeResolution.numericIndex;
  const nextBtn = viewerHeader.locator('button[aria-label="Next version"]').first();
  let isNextDisabled = false;
  try {
    isNextDisabled = await nextBtn.isDisabled();
  } catch {}

  const userMessageEl = turnRoot.locator('[data-message-author-role="user"]').first();
  const displayedText = await userMessageEl.innerText().catch(() => '');
  const displayedHash = messageHash(normalizeTurnText(displayedText));

  await closeBtn.click().catch(() => {});
  await page.waitForTimeout(250);

  const expectedVersion = baseline.count + 1;

  if (activeVersion === expectedVersion && isNextDisabled && displayedHash === expectedHash) {
    const versionAttestation = {
      baselineCount: baseline.count,
      acceptedCount: expectedVersion,
      acceptedIndex: activeVersion,
      labelKind: activeResolution.labelKind,
      contentHash: displayedHash,
      nextDisabled: true,
      method: 'variants_ui_reconciled_post_reload',
      commitBarrier: {
        method: 'exact_thread_reload',
        phase: 'stage1-reconcile-reload',
        verifiedAt: nowIso(),
      },
      verifiedAt: nowIso(),
    };
    const updated = updateRound(round.id, {
      dispatchState: 'accepted',
      dispatchAcceptedAt: nowIso(),
      versionAttestation,
    }, 'round_dispatch_accepted');
    const finalRound = updated || Object.assign(round, {
      dispatchState: 'accepted',
      dispatchAcceptedAt: nowIso(),
      versionAttestation,
    });
    return { outcome: 'promoted_to_accepted', round: finalRound };
  }

  if (activeVersion > expectedVersion) {
    const patch = {
      status: 'failed',
      lastError: `Concurrent mutation detected: observed Version ${activeVersion} > expected ${expectedVersion}`,
    };
    const updated = updateRound(round.id, patch, 'round_conflict');
    return { outcome: 'conflict', round: updated || Object.assign(round, patch) };
  }

  if (activeVersion === expectedVersion && displayedHash !== expectedHash) {
    const patch = {
      status: 'failed',
      lastError: `Attribution conflict: Version ${activeVersion} content hash does not match expected editedHash`,
    };
    const updated = updateRound(round.id, patch, 'round_conflict');
    return { outcome: 'conflict', round: updated || Object.assign(round, patch) };
  }

  return { outcome: 'uncertain', round };
}
async function waitForStage1PostSendQuiescence(page, expectedSessionId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 0;
  const acceptedUserTurnRef = options.acceptedUserTurnRef || null;
  const priorAssistantTurnRef = options.priorAssistantTurnRef || null;

  const start = Date.now();
  let generationObserved = false;
  let idleCountAfterActive = 0;
  let lastDescendantKey = null;
  let completedDescendantSamples = 0;

  while (true) {
    if (timeoutMs > 0 && Date.now() - start > timeoutMs) {
      return { quiescent: false, timedOut: true, generationObserved };
    }

    await assertThreadIdentity(page, expectedSessionId, 'while awaiting stage1 post-send quiescence');
    const gen = await getCombinedGenerationState(page);

    if (gen.isGenerating) {
      generationObserved = true;
      idleCountAfterActive = 0;
      lastDescendantKey = null;
      completedDescendantSamples = 0;
    } else if (generationObserved) {
      idleCountAfterActive++;
      if (idleCountAfterActive >= 2) {
        return { quiescent: true, generationObserved: true, reason: 'generation_completed' };
      }
    } else if (acceptedUserTurnRef) {
      const turns = await getConversationTurns(page).catch(() => []);
      const outcome = responseAfterAcceptedTurnExcludingRevision(turns, acceptedUserTurnRef, priorAssistantTurnRef);
      if (outcome && outcome.text && outcome.text.trim()) {
        const descendantKey = [
          outcome.assistantTurn?.messageId || '',
          outcome.assistantTurn?.testid || '',
          messageHash(normalizeTurnText(outcome.text)),
        ].join(':');

        if (descendantKey === lastDescendantKey) {
          completedDescendantSamples++;
          if (completedDescendantSamples >= 2) {
            return { quiescent: true, generationObserved: false, reason: 'assistant_descendant_completed', outcome };
          }
        } else {
          lastDescendantKey = descendantKey;
          completedDescendantSamples = 1;
        }
      } else {
        lastDescendantKey = null;
        completedDescendantSamples = 0;
      }
    }

    if (typeof page.waitForTimeout === 'function') {
      await page.waitForTimeout(500);
    } else {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function retryEditTurn(page, args) {
  await prepareConversationForRead(page, args);
  const expectedSessionId = args.expectedSessionId;
  if (!expectedSessionId) {
    throw cbError('EDIT_TARGET_REQUIRED', 'Stage 1 recovery requires an existing stable conversation');
  }

  const action = async () => {
    const provisionalRoundId = randomId('round-edit');
    const leaseHandle = await acquireConversationLease(expectedSessionId, provisionalRoundId);

    let round = null;
    let localDispatchState = 'unregistered';
    try {
      if (sessionIdFromUrl(page.url()) !== expectedSessionId) {
        await openConversationBySessionId(page, expectedSessionId);
      }
      await reloadExactConversation(page, expectedSessionId, 'stage1-edit-reload');
      await assertThreadIdentity(page, expectedSessionId, 'before stage1 edit preparation');

      const preState = await getTargetAppState(page);
      const generation = await getCombinedGenerationState(page, preState);
      if (generation.isGenerating) {
        throw cbError('CONVERSATION_BUSY', 'Cannot perform Stage 1 edit retry while generation is active');
      }

      await syncTranscriptFromPage(page, args);

      const resolution = await resolveEditableUserTurn(page, args.retryEdit || 'latest', args.editSuffix || '.', args.expectedRevisionHash || null);
      const { sourceUser, sourceAssistant, originalText, editedText, originalHash, editedHash } = resolution;

      const roundExtra = {
        expectedSessionId,
        operationKind: 'edit_retry',
        recoveryStage: 1,
        recoveryIncidentId: args.recoveryIncidentId || '',
        sourceUserTurn: sourceUser,
        sourceAssistantTurn: sourceAssistant,
        originalMessageHash: originalHash,
        editedMessageHash: editedHash,
        editSuffix: args.editSuffix || '.',
        versionBaseline: null,
        versionAttestation: null,
        dispatchState: 'preparing',
      };
      round = registerPendingRound(args, page, editedText, sourceUser.testid, roundExtra);
      localDispatchState = 'preparing';

      let versionBaseline = null;
      try {
        versionBaseline = await captureUserTurnVersionBaseline(page, sourceUser, sourceAssistant, round.id);
      } catch (baseErr) {
        localDispatchState = 'aborted_precommit';
        round = updateRound(round.id, {
          status: 'failed',
          dispatchState: 'aborted_precommit',
          lastError: baseErr.message || String(baseErr),
        }, 'round_aborted') || round;
        throw baseErr;
      }

      localDispatchState = 'prepared';
      round = updateRound(round.id, {
        versionBaseline,
        dispatchState: 'prepared',
      }, 'round_prepared') || round;

      const { editor } = await openUserTurnEditor(page, sourceUser);
      const editorAttestation = await populateAndVerifyEditor(page, editor, sourceUser, originalText, args.editSuffix || '.', editedText);

      const sendBtn = await submitEditedUserTurn(page, editor, expectedSessionId, editorAttestation);

      localDispatchState = 'dispatching';
      round = updateRound(round.id, {
        editorAttestation,
        dispatchState: 'dispatching',
        dispatchStartedAt: nowIso(),
      }, 'round_dispatching') || round;

      try {
        await sendBtn.click();
      } catch (submitErr) {
        localDispatchState = 'uncertain';
        round = updateRound(round.id, {
          status: 'pending',
          dispatchState: 'uncertain',
          lastError: submitErr.message || String(submitErr),
        }, 'round_dispatch_uncertain') || round;
        throw cbError('EDIT_DISPATCH_UNCERTAIN', `Stage 1 edit submit uncertainty: ${submitErr.message || submitErr}`);
      }

      // 1. Client Acceptance: editor unmounts and live DOM reflects editedHash
      try {
        if (typeof editor.waitFor === 'function') {
          await editor.waitFor({ state: 'detached', timeout: 15000 });
        }
      } catch (detachErr) {
        localDispatchState = 'uncertain';
        round = updateRound(round.id, {
          status: 'pending',
          dispatchState: 'uncertain',
          lastError: `Editor failed to detach after Send click: ${detachErr.message || detachErr}`,
        }, 'round_dispatch_uncertain') || round;
        throw cbError('EDIT_DISPATCH_UNCERTAIN', 'Editor failed to detach after Send click');
      }

      let clientAttestation;
      try {
        clientAttestation = await waitForEditedTurnAccepted(page, sourceUser, editedHash, expectedSessionId, 15000);
      } catch (attestErr) {
        localDispatchState = 'uncertain';
        round = updateRound(round.id, {
          status: 'pending',
          dispatchState: 'uncertain',
          lastError: attestErr.message || String(attestErr),
        }, 'round_dispatch_uncertain') || round;
        throw attestErr;
      }

      localDispatchState = 'client_accepted';
      round = updateRound(round.id, {
        dispatchState: 'client_accepted',
        clientAcceptedUserTurn: clientAttestation.acceptedTurn,
        clientAcceptanceMethod: 'live_dom_after_send',
      }, 'round_client_accepted') || round;

      // 2. Passive Quiescence Observation (never reload or click Stop during this phase)
      const quiescenceTimeout = args.timeout > 0 ? args.timeout : 0;
      const q = await waitForStage1PostSendQuiescence(page, expectedSessionId, {
        acceptedUserTurnRef: clientAttestation.acceptedTurn,
        priorAssistantTurnRef: sourceAssistant,
        timeoutMs: quiescenceTimeout,
      });

      if (!q.quiescent) {
        localDispatchState = 'uncertain';
        round = updateRound(round.id, {
          status: 'pending',
          dispatchState: 'uncertain',
          lastError: 'Post-Send quiescence could not be verified within timeout window',
        }, 'round_dispatch_uncertain') || round;
        throw cbError('POST_SEND_QUIESCENCE_UNVERIFIED', 'Post-Send quiescence could not be verified');
      }

      localDispatchState = 'commit_verifying';
      round = updateRound(round.id, {
        dispatchState: 'commit_verifying',
        quiescenceAttestation: q,
      }, 'round_commit_verifying') || round;

      // 3. Exact Thread Reload as a Commit Barrier against frontend pretense:
      // Executed ONLY after the post-Send transaction is quiescent.
      if (typeof page.reload === 'function') {
        await reloadExactConversation(page, expectedSessionId, 'stage1-post-submit-rehydration');
      }

      // 4. Server-Rehydrated Proof: verify edited turn and numeric K+1
      let serverAttestation;
      try {
        serverAttestation = await waitForEditedTurnAccepted(page, sourceUser, editedHash, expectedSessionId, 15000);
      } catch (attestErr) {
        localDispatchState = 'uncertain';
        round = updateRound(round.id, {
          status: 'pending',
          dispatchState: 'uncertain',
          lastError: attestErr.message || String(attestErr),
        }, 'round_dispatch_uncertain') || round;
        throw attestErr;
      }

      let versionAttestation = null;
      try {
        versionAttestation = await attestEditedUserTurnVersion(page, serverAttestation.acceptedTurn || sourceUser, versionBaseline, editedHash);
      } catch (verErr) {
        localDispatchState = 'uncertain';
        round = updateRound(round.id, {
          status: 'pending',
          dispatchState: 'uncertain',
          lastError: verErr.message || String(verErr),
        }, 'round_dispatch_uncertain') || round;
        throw verErr;
      }

      localDispatchState = 'accepted';
      round = updateRound(round.id, {
        dispatchState: 'accepted',
        dispatchAcceptedAt: nowIso(),
        acceptedUserTurn: serverAttestation.acceptedTurn,
        editAttestation: { method: serverAttestation.attestationMethod },
        versionAttestation,
      }, 'round_dispatch_accepted') || round;

      const authoritativeSessionId = expectedSessionId || round.sessionId;
      args.transcript = args.transcriptOverride ? args.transcript : transcriptPathForSession(authoritativeSessionId);
      if (args.transcript) {
        appendTranscript(args.transcript, 'user', editedText);
      }

      const watchBaseline = stateBaseline(await getTargetAppState(page));
      const streamer = (args.stream || args.stateJsonl) ? createStreamPrinter(args, watchBaseline) : null;
      let response = '';
      try {
        response = await waitForAssistantResponse(
          page,
          editedText,
          sourceUser.testid,
          args.timeout,
          streamer ? (event) => streamer.update(event) : null,
          {
            expectedSessionId: authoritativeSessionId,
            acceptedUserTurnRef: serverAttestation.acceptedTurn,
            priorAssistantTurnRef: sourceAssistant,
          }
        );
      } catch (error) {
        const observedSessionId = sessionIdFromUrl(page.url());
        const isTerminal = error.code === 'ASSISTANT_TERMINAL_ERROR';
        round = updateRound(round.id, {
          status: isTerminal ? 'failed' : 'pending',
          assistantOutcome: isTerminal ? 'terminal_error' : 'uncertain',
          lastErrorCode: error.code || '',
          lastError: error.message || String(error),
          observedSessionId,
          observedUrl: page.url(),
        }, isTerminal ? 'round_failed' : 'round_waiting_for_recovery') || round;
        throw error;
      }
      if (streamer) streamer.finish();

      if (args.transcript) {
        appendTranscript(args.transcript, 'assistant', response);
      }

      localDispatchState = 'done';
      round = updateRound(round.id, {
        status: 'done',
        assistantOutcome: 'succeeded',
        sessionId: authoritativeSessionId,
        responseChars: response.length,
        lastError: '',
        url: authoritativeSessionId ? targetConversationUrl(authoritativeSessionId) : page.url(),
        transcript: args.transcript,
      }, 'round_completed') || round;

      info(`[stage1] Successfully completed Stage 1 recovery edit for ${expectedSessionId}`);
      return { response, round };
    } catch (err) {
      if (round && localDispatchState === 'prepared') {
        localDispatchState = 'aborted_precommit';
        round = updateRound(round.id, {
          status: 'failed',
          dispatchState: 'aborted_precommit',
          lastError: err.message || String(err),
        }, 'round_aborted') || round;
      }
      throw err;
    } finally {
      if (leaseHandle) {
        await releaseConversationLease(leaseHandle);
      }
    }
  };

  return await withBrowserLaneLease(args, randomId('stage1-edit-op'), action);
}


function validateAutoRecoverMode(args) {
  if (!args.autoRecover) return;

  const rawTarget = args.expectedSessionId || args.conversation || '';
  if (!rawTarget || !STABLE_SESSION_ID_RE.test(rawTarget)) {
    throw cbError('RECOVERY_TARGET_REQUIRED', '--auto-recover requires an explicit stable conversation: --conversation <uuid>');
  }
  args.expectedSessionId = rawTarget;

  if (!args.recoveryIncidentId?.trim()) {
    throw cbError('RECOVERY_INCIDENT_REQUIRED', '--auto-recover requires an explicit incident identifier: --recovery-incident <id>');
  }

  const conflicting = [
    args.message,
    args.newConversation,
    args.recoveryResend,
    args.retryEdit,
    args.branchTurn,
    args.recoverBranchId,
    args.schedule,
    args.runQueue,
    args.queueStatus,
    args.queueWatch,
    args.recoverQueue,
    args.stop,
    args.status,
    args.watchState,
    args.waitReady,
    args.syncTranscript,
    args.latestAssistant,
    args.dismissBlocker,
    Boolean(args.searchQuery),
    args.models,
    args.compactConversation,
    args.handoffNewSession,
    args.recoverInterrupted,
    args.downloadArtifacts,
  ];
  if (conflicting.some(Boolean)) {
    throw cbError('INVALID_RECOVERY_MODE', '--auto-recover cannot be combined with another primary operation or prompt');
  }

  if (args.timeout === undefined || args.timeout === 120) {
    args.timeout = 0;
  }
}

function loadRecoveryIncidentsState() {
  if (!fs.existsSync(RECOVERY_INCIDENTS_PATH)) {
    return { version: 1, updatedAt: '', incidents: [] };
  }
  try {
    const raw = fs.readFileSync(RECOVERY_INCIDENTS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.incidents)) {
      throw cbError('INCIDENT_STATE_CORRUPT', 'recovery-incidents.json has invalid schema');
    }
    return parsed;
  } catch (err) {
    if (err.code === 'INCIDENT_STATE_CORRUPT') throw err;
    throw cbError('INCIDENT_STATE_CORRUPT', `Failed to parse recovery-incidents.json: ${err.message || err}`);
  }
}

function saveRecoveryIncidentsState(state) {
  atomicWriteJson(RECOVERY_INCIDENTS_PATH, state);
}

function registerRecoveryIncident(incidentId, parentSessionId, sourceUserTurnRef, branchAnchorTurnRef, sourcePromptPath, sourcePromptHash) {
  return withSchedulerLock(() => {
    const state = loadRecoveryIncidentsState();
    const existing = state.incidents.find(i => i.id === incidentId);
    if (existing) return existing;

    const record = {
      id: incidentId,
      operationKind: 'auto_recovery',
      parentSessionId,
      sourceUserTurnRef,
      branchAnchorTurnRef,
      sourcePromptPath,
      sourcePromptHash,
      state: 'prepared',
      stage1RoundId: '',
      stage2RoundId: '',
      stage3BranchId: '',
      finalSessionId: '',
      finalOutcome: '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      pid: process.pid,
      lastError: '',
    };
    state.incidents.push(record);
    state.updatedAt = record.updatedAt;
    saveRecoveryIncidentsState(state);
    appendJsonl(RECOVERY_EVENTS_PATH, {
      type: 'incident_registered',
      at: record.createdAt,
      incident: record,
    });
    return record;
  });
}

function updateRecoveryIncident(incidentId, patch, eventType = 'incident_updated') {
  return withSchedulerLock(() => {
    const state = loadRecoveryIncidentsState();
    const incident = state.incidents.find(i => i.id === incidentId);
    if (!incident) return null;

    Object.assign(incident, patch);
    incident.updatedAt = nowIso();
    state.updatedAt = incident.updatedAt;
    saveRecoveryIncidentsState(state);

    appendJsonl(RECOVERY_EVENTS_PATH, {
      type: eventType,
      at: incident.updatedAt,
      incident,
    });
    return incident;
  });
}

function recoveryIncidentLeasePath(incidentId) {
  return path.join(RECOVERY_LEASES_DIR, `${incidentId}.lock`);
}

async function acquireRecoveryIncidentLease(incidentId, token = randomId('incident-lease')) {
  fs.mkdirSync(RECOVERY_LEASES_DIR, { recursive: true });
  const leasePath = recoveryIncidentLeasePath(incidentId);

  return withSchedulerLock(() => {
    if (fs.existsSync(leasePath)) {
      try {
        const current = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
        if (current.pid && processExists(current.pid) && current.token !== token) {
          throw cbError('INCIDENT_BUSY', `Recovery incident ${incidentId} is currently held by active PID ${current.pid}`);
        }
      } catch (err) {
        if (err.code === 'INCIDENT_BUSY') throw err;
      }
    }
    const payload = {
      incidentId,
      token,
      pid: process.pid,
      acquiredAt: nowIso(),
    };
    atomicWriteJson(leasePath, payload);
    return { incidentId, token, leasePath };
  });
}

function releaseRecoveryIncidentLease(leaseHandle) {
  if (!leaseHandle?.leasePath || !leaseHandle?.token) return;
  const { leasePath, token } = leaseHandle;
  return withSchedulerLock(() => {
    try {
      if (fs.existsSync(leasePath)) {
        const current = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
        if (current.token === token) {
          fs.unlinkSync(leasePath);
        }
      }
    } catch {}
  });
}

async function captureAndFreezeSourcePrompt(page, sourceUserTurn, incidentId) {
  const { editor } = await openUserTurnEditor(page, sourceUserTurn);
  const sourceRes = await readInlineEditorSource(editor);
  const rawText = sourceRes.text;
  const container = inlineEditorContainer(editor);
  const cancelBtn = container.locator('button:has-text("Cancel"), button[aria-label="Cancel"]').first();
  if (await cancelBtn.isVisible().catch(() => false)) {
    await cancelBtn.click().catch(() => {});
  }
  if (typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(300);
  }

  if (!rawText.trim()) {
    throw cbError('EDIT_SOURCE_UNVERIFIED', 'Failed to capture non-empty raw editor source prompt');
  }

  const promptDir = path.join(RECOVERY_ARTIFACTS_DIR, incidentId);
  fs.mkdirSync(promptDir, { recursive: true });
  const promptPath = path.join(promptDir, 'source-prompt.txt');
  fs.writeFileSync(promptPath, rawText, 'utf8');
  const promptHash = crypto.createHash('sha256').update(rawText).digest('hex');

  return { promptPath, promptHash, rawText };
}

async function captureBranchAnchorTurn(page, sourceUserTurn) {
  const canonicalTurns = await getConversationTurns(page).catch(() => []);
  if (!canonicalTurns || !canonicalTurns.length) {
    throw cbError('RECOVERY_ANCHOR_NOT_FOUND', 'Could not extract canonical conversation turns to locate branch anchor');
  }

  const userIdx = canonicalTurns.findIndex(t =>
    (sourceUserTurn.id && (t.messageId === sourceUserTurn.id || t.id === sourceUserTurn.id)) ||
    (sourceUserTurn.testid && t.testid === sourceUserTurn.testid)
  );
  if (userIdx === -1) {
    throw cbError('RECOVERY_ANCHOR_NOT_FOUND', 'Source user turn not found in canonical turns');
  }

  let anchorTurn = null;
  for (let i = userIdx - 1; i >= 0; i--) {
    if (canonicalTurns[i].role === 'assistant') {
      anchorTurn = canonicalTurns[i];
      break;
    }
  }

  if (!anchorTurn) {
    throw cbError('RECOVERY_ANCHOR_NOT_FOUND', 'No prior assistant turn exists preceding the source user turn');
  }

  return {
    messageId: anchorTurn.messageId || anchorTurn.id || '',
    id: anchorTurn.messageId || anchorTurn.id || '',
    testid: anchorTurn.testid || '',
    role: 'assistant',
    text: anchorTurn.text,
    textHash: messageHash(normalizeTurnText(anchorTurn.text)),
  };
}

async function autoRecoverConversationTurn(page, args) {
  await prepareConversationForRead(page, args);
  const expectedParentSessionId = args.expectedSessionId;
  if (!expectedParentSessionId) {
    throw cbError('RECOVERY_TARGET_REQUIRED', 'Auto-recovery requires an existing stable conversation');
  }

  const incidentId = args.recoveryIncidentId;
  if (!incidentId) {
    throw cbError('RECOVERY_INCIDENT_REQUIRED', 'Auto-recovery requires an explicit incident identifier');
  }

  const incidentLease = await acquireRecoveryIncidentLease(incidentId);

  try {
    let state = loadRecoveryIncidentsState();
    let incident = state.incidents.find(i => i.id === incidentId);

    // Phase 1: Validate or initialize incident under endpoint browser lane and parent conversation lease
    if (incident) {
      if (incident.parentSessionId !== expectedParentSessionId) {
        throw cbError('INCIDENT_TARGET_MISMATCH', `Incident ${incidentId} is bound to parent ${incident.parentSessionId}, but targeting ${expectedParentSessionId}`);
      }
    } else {
      const provisionalId = randomId('incident-init');
      await withBrowserLaneLease(args, provisionalId, async () => {
        const convLease = await acquireConversationLease(expectedParentSessionId, provisionalId);
        try {
          await assertThreadIdentity(page, expectedParentSessionId, 'before auto-recovery initialization');
          await syncTranscriptFromPage(page, args);

          const resolution = await resolveEditableUserTurn(page, 'latest', args.editSuffix || '.');
          const sourceUserTurn = resolution.sourceUser;

          const { promptPath, promptHash } = await captureAndFreezeSourcePrompt(page, sourceUserTurn, incidentId);
          const branchAnchorTurnRef = await captureBranchAnchorTurn(page, sourceUserTurn);

          incident = registerRecoveryIncident(
            incidentId,
            expectedParentSessionId,
            sourceUserTurn,
            branchAnchorTurnRef,
            promptPath,
            promptHash
          );
          info(`[auto-recover] Initialized and froze incident ${incidentId} (parent ${expectedParentSessionId}, anchor ${branchAnchorTurnRef.messageId || branchAnchorTurnRef.testid})`);
        } finally {
          releaseConversationLease(convLease);
        }
      });
    }

    // Phase 2: Stage 1 execution (In-place edit)
    if (incident.state === 'prepared' || incident.state === 'stage1_running') {
      const roundState = loadRoundState();
      // Select the newest attempt rather than the first historical one
      const existingRound = [...roundState.rounds].reverse().find(r => r.recoveryIncidentId === incidentId && r.recoveryStage === 1);

      let safeToRetryStage1 = false;
      if (incident.state === 'stage1_running' && existingRound) {
        if (isPositivelyCompletedRound(existingRound)) {
          incident = updateRecoveryIncident(incidentId, {
            state: 'completed_stage1',
            stage1RoundId: existingRound.id,
            finalSessionId: incident.parentSessionId,
            finalOutcome: 'stage1_succeeded',
          }) || incident;
          info(`[auto-recover] Prior Stage 1 round ${existingRound.id} already completed successfully`);
          return { incident, state: 'completed_stage1', sessionId: incident.parentSessionId, responseText: existingRound.responseText };
        }

        const convLease = await acquireConversationLease(expectedParentSessionId, randomId('stage1-recon'));
        let recon;
        try {
          recon = await withBrowserLaneLease(args, randomId('stage1-recon-lane'), async () => {
            return await reconcileStage1EditTurn(page, args, existingRound);
          });
        } finally {
          await releaseConversationLease(convLease);
        }
        if (recon.outcome === 'promoted_to_accepted' || recon.outcome === 'already_accepted') {
          info(`[auto-recover] Reconciled Stage 1 round ${existingRound.id} as accepted`);
          if (recon.round?.assistantOutcome === 'terminal_error') {
            incident = updateRecoveryIncident(incidentId, {
              state: 'stage1_terminal_failed',
              stage1RoundId: existingRound.id,
              lastError: existingRound.lastError,
            }) || incident;
            info(`[auto-recover] Reconciled Stage 1 was terminal model failure; escalating to Stage 2`);
          } else {
            incident = updateRecoveryIncident(incidentId, {
              state: 'stage1_needs_reconciliation',
              stage1RoundId: existingRound.id,
              lastError: 'Stage 1 round accepted; awaiting assistant completion',
            }) || incident;
            return { incident, state: 'stage1_needs_reconciliation', round: recon.round };
          }
        } else if (recon.outcome === 'aborted_precommit') {
          info(`[auto-recover] Stage 1 round ${existingRound.id} aborted precommit; re-attempting Stage 1 preparation`);
          safeToRetryStage1 = true;
        } else {
          incident = updateRecoveryIncident(incidentId, {
            state: 'stage1_needs_reconciliation',
            stage1RoundId: existingRound.id,
            lastError: `Stage 1 in-flight round ${existingRound.id} outcome uncertain (${recon.outcome}); human intervention required`,
          }) || incident;
          return { incident, state: 'stage1_needs_reconciliation', error: incident.lastError };
        }
      }

      if (incident.state === 'prepared' || safeToRetryStage1 || (incident.state === 'stage1_running' && !existingRound)) {
        incident = updateRecoveryIncident(incidentId, { state: 'stage1_running' }) || incident;

        const stage1Args = {
          ...args,
          retryEdit: incident.sourceUserTurnRef.messageId || incident.sourceUserTurnRef.testid || 'latest',
          editSuffix: args.editSuffix || '.',
          recoveryIncidentId: incidentId,
          expectedRevisionHash: incident.sourceUserTurnRef.textHash || '',
        };

        try {
          const res = await retryEditTurn(page, stage1Args);
          incident = updateRecoveryIncident(incidentId, {
            state: 'completed_stage1',
            stage1RoundId: res?.round?.id || '',
            finalSessionId: incident.parentSessionId,
            finalOutcome: 'stage1_succeeded',
          }) || incident;
          info(`[auto-recover] Stage 1 succeeded for incident ${incidentId}`);
          return { incident, state: 'completed_stage1', sessionId: incident.parentSessionId };
        } catch (err) {
          const postState = loadRoundState();
          const round = [...postState.rounds].reverse().find(r => r.recoveryIncidentId === incidentId && r.recoveryStage === 1);
          const isTerminalModelFailure = (
            stage1CommitIsAttested(round) &&
            round?.assistantOutcome === 'terminal_error'
          );

          if (isTerminalModelFailure) {
            incident = updateRecoveryIncident(incidentId, {
              state: 'stage1_terminal_failed',
              stage1RoundId: round?.id || '',
              lastError: err.message || String(err),
            }) || incident;
            info(`[auto-recover] Stage 1 proven terminal model failure; escalating to Stage 2`);
          } else {
            incident = updateRecoveryIncident(incidentId, {
              state: 'stage1_needs_reconciliation',
              stage1RoundId: round?.id || '',
              lastError: err.message || String(err),
            }) || incident;
            throw err;
          }
        }
      }
    }

    // Phase 3: Stage 2 execution (Same-session resend with auto-discriminator)
    if (incident.state === 'stage1_terminal_failed' || incident.state === 'stage2_running') {
      const roundState = loadRoundState();
      // Select the newest attempt rather than the first historical one
      const existingStage2Round = [...roundState.rounds].reverse().find(r => r.recoveryIncidentId === incidentId && r.recoveryStage === 2);

      let safeToRetryStage2 = false;
      if (incident.state === 'stage2_running' && existingStage2Round) {
        if (existingStage2Round.dispatchState === 'prepared' || existingStage2Round.dispatchState === 'aborted_precommit') {
          info(`[auto-recover] Prior Stage 2 attempt ${existingStage2Round.id} aborted precommit; re-attempting Stage 2 preparation`);
          safeToRetryStage2 = true;
        } else if (existingStage2Round.dispatchState === 'accepted') {
          if (existingStage2Round.assistantOutcome === 'succeeded') {
            incident = updateRecoveryIncident(incidentId, {
              state: 'completed_stage2',
              stage2RoundId: existingStage2Round.id,
              finalSessionId: incident.parentSessionId,
              finalOutcome: 'stage2_succeeded',
            }) || incident;
            info(`[auto-recover] Reconciled Stage 2 round ${existingStage2Round.id} as completed`);
            return { incident, state: 'completed_stage2', sessionId: incident.parentSessionId };
          } else if (existingStage2Round.assistantOutcome === 'terminal_error') {
            incident = updateRecoveryIncident(incidentId, {
              state: 'stage2_terminal_failed',
              stage2RoundId: existingStage2Round.id,
              lastError: existingStage2Round.lastError,
            }) || incident;
            info(`[auto-recover] Reconciled Stage 2 round was terminal failure; escalating to Stage 3`);
          } else {
            incident = updateRecoveryIncident(incidentId, {
              state: 'stage2_needs_reconciliation',
              stage2RoundId: existingStage2Round.id,
              lastError: 'Stage 2 round accepted; awaiting assistant completion',
            }) || incident;
            return { incident, state: 'stage2_needs_reconciliation', round: existingStage2Round };
          }
        } else {
          incident = updateRecoveryIncident(incidentId, {
            state: 'stage2_needs_reconciliation',
            stage2RoundId: existingStage2Round.id,
            lastError: `Stage 2 round ${existingStage2Round.id} in uncertain dispatch state (${existingStage2Round.dispatchState}); human intervention required`,
          }) || incident;
          return { incident, state: 'stage2_needs_reconciliation', error: incident.lastError };
        }
      }

      if (incident.state === 'stage1_terminal_failed' || safeToRetryStage2 || (incident.state === 'stage2_running' && !existingStage2Round)) {
        incident = updateRecoveryIncident(incidentId, { state: 'stage2_running' }) || incident;

        const rawPrompt = fs.readFileSync(incident.sourcePromptPath, 'utf8');
        const actualHash = crypto.createHash('sha256').update(rawPrompt).digest('hex');
        if (actualHash !== incident.sourcePromptHash) {
          throw cbError('INCIDENT_PROMPT_INTEGRITY_MISMATCH', `Source prompt artifact hash mismatch for incident ${incidentId}`);
        }

        const stage2Args = {
          ...args,
          recoveryResend: true,
          message: rawPrompt,
          recoveryIncidentId: incidentId,
        };
        validateRecoveryMode(stage2Args);
        const stage2Message = stage2Args.message;

        try {
          const convLease = await acquireConversationLease(stage2Args.expectedSessionId, randomId('stage2-prep'));
          try {
            await withBrowserLaneLease(stage2Args, randomId('stage2-prep-lane'), async () => {
              await prepareConversationForRead(page, stage2Args);
              if (stage2Args.expectedSessionId && sessionIdFromUrl(page.url()) !== stage2Args.expectedSessionId) {
                await openConversationBySessionId(page, stage2Args.expectedSessionId);
              }
              await reloadExactConversation(page, stage2Args.expectedSessionId, 'auto-recovery-stage2-reload');
              await assertThreadIdentity(page, stage2Args.expectedSessionId, 'before stage2 resend');
              await syncTranscriptFromPage(page, stage2Args);
            });
          } finally {
            await releaseConversationLease(convLease);
          }

          // ask() acquires and owns the browser lane lease internally!
          const responseText = await ask(page, stage2Message, stage2Args);

          const postState = loadRoundState();
          const round = [...postState.rounds].reverse().find(r => r.recoveryIncidentId === incidentId && r.recoveryStage === 2);

          incident = updateRecoveryIncident(incidentId, {
            state: 'completed_stage2',
            stage2RoundId: round?.id || '',
            finalSessionId: incident.parentSessionId,
            finalOutcome: 'stage2_succeeded',
          }) || incident;
          info(`[auto-recover] Stage 2 succeeded for incident ${incidentId}`);
          return { incident, state: 'completed_stage2', sessionId: incident.parentSessionId, responseText };
        } catch (err) {
          const postState = loadRoundState();
          const round = [...postState.rounds].reverse().find(r => r.recoveryIncidentId === incidentId && r.recoveryStage === 2);
          const isTerminalModelFailure = (
            round?.dispatchState === 'accepted' &&
            round?.assistantOutcome === 'terminal_error'
          );

          if (isTerminalModelFailure) {
            incident = updateRecoveryIncident(incidentId, {
              state: 'stage2_terminal_failed',
              stage2RoundId: round?.id || '',
              lastError: err.message || String(err),
            }) || incident;
            info(`[auto-recover] Stage 2 proven terminal model failure; escalating to Stage 3`);
          } else {
            incident = updateRecoveryIncident(incidentId, {
              state: 'stage2_needs_reconciliation',
              stage2RoundId: round?.id || '',
              lastError: err.message || String(err),
            }) || incident;
            throw err;
          }
        }
      }
    }

    // Phase 4: Stage 3 execution (Native backend branching at frozen anchor)
    if (incident.state === 'stage2_terminal_failed' || incident.state === 'stage3_running') {
      const lineageState = loadLineageState();
      // Select the newest attempt rather than the first historical one
      const existingBranch = [...lineageState.branches].reverse().find(b => b.recoveryIncidentId === incidentId);

      let safeToRetryStage3 = false;
      if (incident.state === 'stage3_running' && existingBranch) {
        if (isPositivelyBoundBranch(existingBranch, incident.parentSessionId)) {
          incident = updateRecoveryIncident(incidentId, {
            state: 'completed_stage3_bound',
            stage3BranchId: existingBranch.id,
            finalSessionId: existingBranch.childSessionId,
            finalOutcome: 'stage3_bound',
          }) || incident;
          info(`[auto-recover] Reconciled Stage 3 branch ${existingBranch.id} as bound`);
          return { incident, state: 'completed_stage3_bound', childSessionId: existingBranch.childSessionId, childUrl: existingBranch.childUrl };
        } else if (existingBranch.dispatchState === 'stable_candidate' || existingBranch.dispatchState === 'destination_unverified' || existingBranch.dispatchState === 'lineage_attested') {
          info(`[auto-recover] In-flight Stage 3 branch ${existingBranch.id} requires candidate recovery`);
          const rec = await recoverCandidateBranchLineage(page, args, existingBranch);
          if (rec.dispatchState === 'bound' || (rec.status === 'done' && rec.childSessionId)) {
            incident = updateRecoveryIncident(incidentId, {
              state: 'completed_stage3_bound',
              stage3BranchId: existingBranch.id,
              finalSessionId: rec.childSessionId,
              finalOutcome: 'stage3_bound',
            }) || incident;
            return { incident, state: 'completed_stage3_bound', childSessionId: rec.childSessionId, childUrl: rec.childUrl };
          } else {
            incident = updateRecoveryIncident(incidentId, {
              state: 'stage3_needs_reconciliation',
              stage3BranchId: existingBranch.id,
              lastError: `Stage 3 candidate recovery outcome: ${rec.dispatchState || rec.status}`,
            }) || incident;
            return { incident, state: 'stage3_needs_reconciliation', error: incident.lastError };
          }
        } else if (existingBranch.dispatchState === 'prepared' || existingBranch.dispatchState === 'aborted_precommit') {
          info(`[auto-recover] Prior Stage 3 branch ${existingBranch.id} aborted precommit; re-attempting Stage 3`);
          safeToRetryStage3 = true;
        } else {
          incident = updateRecoveryIncident(incidentId, {
            state: 'stage3_needs_reconciliation',
            stage3BranchId: existingBranch.id,
            lastError: `Stage 3 branch ${existingBranch.id} in uncertain state (${existingBranch.dispatchState}); human intervention required`,
          }) || incident;
          return { incident, state: 'stage3_needs_reconciliation', error: incident.lastError };
        }
      }

      if (incident.state === 'stage2_terminal_failed' || safeToRetryStage3 || (incident.state === 'stage3_running' && !existingBranch)) {
        incident = updateRecoveryIncident(incidentId, { state: 'stage3_running' }) || incident;

        const stage3Args = {
          ...args,
          branchTurn: incident.branchAnchorTurnRef.messageId || incident.branchAnchorTurnRef.testid,
          recoveryIncidentId: incidentId,
          expectedAnchorRevisionHash: incident.branchAnchorTurnRef.textHash || '',
        };

        try {
          const res = await branchConversationTurn(page, stage3Args);
          incident = updateRecoveryIncident(incidentId, {
            state: 'completed_stage3_bound',
            stage3BranchId: res.branchRecord?.id || '',
            finalSessionId: res.childSessionId,
            finalOutcome: 'stage3_bound',
          }) || incident;
          info(`[auto-recover] Stage 3 succeeded (bound to child ${res.childSessionId}) for incident ${incidentId}`);
          return { incident, state: 'completed_stage3_bound', childSessionId: res.childSessionId, childUrl: res.childUrl };
        } catch (err) {
          incident = updateRecoveryIncident(incidentId, {
            state: 'stage3_needs_reconciliation',
            lastError: err.message || String(err),
          }) || incident;
          throw err;
        }
      }
    }
return { incident, state: incident.state };
  } finally {
    try { releaseRecoveryIncidentLease(incidentLease); } catch {}
  }
}

function validateRecoverBranchMode(args) {
  if (!args.recoverBranchId) return;

  const conflicting = [
    args.message,
    args.newConversation,
    args.recoveryResend,
    args.retryEdit,
    args.branchTurn,
    args.schedule,
    args.runQueue,
    args.queueStatus,
    args.queueWatch,
    args.recoverQueue,
    args.stop,
    args.status,
    args.watchState,
    args.waitReady,
    args.syncTranscript,
    args.latestAssistant,
    args.dismissBlocker,
    Boolean(args.searchQuery),
    args.models,
    args.compactConversation,
    args.handoffNewSession,
    args.recoverInterrupted,
    args.downloadArtifacts,
  ];
  if (conflicting.some(Boolean)) {
    throw cbError('INVALID_RECOVERY_MODE', '--recover-branch cannot be combined with another primary operation');
  }
}

function validateStage3Mode(args) {
  if (!args.branchTurn) return;

  const rawTarget = args.expectedSessionId || args.conversation || '';
  if (!rawTarget || !STABLE_SESSION_ID_RE.test(rawTarget)) {
    throw cbError('BRANCH_TARGET_REQUIRED', 'Stage 3 recovery branching requires an explicit stable conversation: --conversation <uuid>');
  }
  args.expectedSessionId = rawTarget;

  if (!args.recoveryIncidentId?.trim()) {
    if (args.branchCarryForward) {
      args.recoveryIncidentId = `INC-CAPACITY-${randomId()}`;
    } else {
      throw cbError('RECOVERY_INCIDENT_REQUIRED', 'Stage 3 recovery branching requires an explicit incident identifier: --recovery-incident <id>');
    }
  }

  const conflictingStage3Actions = [
    args.branchCarryForward ? null : args.message,
    args.newConversation,
    args.recoveryResend,
    args.retryEdit,
    args.schedule,
    args.runQueue,
    args.queueStatus,
    args.queueWatch,
    args.recoverQueue,
    args.stop,
    args.status,
    args.watchState,
    args.waitReady,
    args.syncTranscript,
    args.latestAssistant,
    args.dismissBlocker,
    Boolean(args.searchQuery),
    args.models,
    args.compactConversation,
    args.handoffNewSession,
    args.recoverInterrupted,
    args.downloadArtifacts,
  ];
  if (conflictingStage3Actions.some(Boolean)) {
    throw cbError('INVALID_STAGE3_MODE', '--branch-turn cannot be combined with another primary operation or send prompt');
  }
}

async function resolveBranchableTurn(page, selection = 'latest', expectedAnchorRevisionHash = null) {
  const canonicalTurns = await getConversationTurns(page).catch(() => []);
  if (!canonicalTurns || !canonicalTurns.length) {
    throw cbError('BRANCH_SOURCE_UNVERIFIED', 'Could not extract canonical conversation turns from page');
  }

  const assistantTurns = canonicalTurns.filter(t => t.role === 'assistant');
  if (!assistantTurns.length) {
    throw cbError('BRANCH_SOURCE_UNVERIFIED', 'No assistant turns found in conversation');
  }

  let targetTurn = null;
  if (selection === 'latest') {
    targetTurn = assistantTurns[assistantTurns.length - 1];
  } else if (selection === 'prior-assistant') {
    const latestUserIndex = canonicalTurns
      .map((t, i) => [t, i])
      .filter(([t]) => t.role === 'user')
      .at(-1)?.[1];

    if (latestUserIndex === undefined) {
      throw cbError('BRANCH_SOURCE_UNVERIFIED', 'No user turns found in conversation to anchor prior-assistant');
    }

    const priorAssistant = [...canonicalTurns.slice(0, latestUserIndex)]
      .reverse()
      .find(t => t.role === 'assistant');

    if (!priorAssistant) {
      throw cbError('BRANCH_SOURCE_UNVERIFIED', 'No assistant turn exists prior to the latest user prompt');
    }
    targetTurn = priorAssistant;
  } else {
    targetTurn = assistantTurns.find(t => (t.messageId && t.messageId === selection) || (t.testid && t.testid === selection) || (t.turnKey && t.turnKey === selection));
    if (!targetTurn) {
      throw cbError('BRANCH_SOURCE_UNVERIFIED', `Target turn "${selection}" not found among assistant turns`);
    }
  }

  const computedHash = messageHash(normalizeTurnText(targetTurn.text));
  if (expectedAnchorRevisionHash && computedHash !== expectedAnchorRevisionHash) {
    throw cbError(
      'ANCHOR_REVISION_DRIFT',
      `Resolved anchor turn ${targetTurn.messageId || targetTurn.testid} text hash ${computedHash} does not match expected frozen anchor hash ${expectedAnchorRevisionHash}`
    );
  }

  return {
    messageId: targetTurn.messageId || targetTurn.id || '',
    id: targetTurn.messageId || targetTurn.id || '',
    testid: targetTurn.testid || '',
    turnKey: targetTurn.turnKey || '',
    role: 'assistant',
    text: targetTurn.text,
    textHash: computedHash,
  };
}

async function openBranchMenu(page, sourceAssistant) {
  let turnEl = null;
  const turnKey = sourceAssistant.turnKey || (sourceAssistant.testid?.startsWith('asst-') ? sourceAssistant.testid.slice(5) : null);
  if (turnKey) {
    turnEl = page.locator(`[data-turn-key="${turnKey}"]`);
  }
  if (!turnEl || !(await turnEl.count().catch(() => 0))) {
    if (sourceAssistant.testid) {
      turnEl = page.locator(`[data-testid="${sourceAssistant.testid}"]`);
      if (!(await turnEl.count().catch(() => 0))) {
        turnEl = page.locator(`[data-turn-key="${sourceAssistant.testid}"]`);
      }
    } else if (sourceAssistant.messageId) {
      turnEl = page.locator(`[data-message-id="${sourceAssistant.messageId}"]`);
    }
  }
  const matchCount = await turnEl?.count().catch(() => 0);
  if (matchCount !== 1) {
    throw cbError('BRANCH_SOURCE_UNVERIFIED', `Exact source turn "${sourceAssistant.turnKey || sourceAssistant.testid || sourceAssistant.messageId}" could not be uniquely located in DOM (matched ${matchCount})`);
  }

  await turnEl.scrollIntoViewIfNeeded().catch(() => {});
  await turnEl.hover().catch(() => {});
  await page.waitForTimeout(300);

  const moreBtn = turnEl.locator('button[aria-label="More actions"], button:has-text("More actions")').first();
  if (!(await moreBtn.count().catch(() => 0)) || !(await moreBtn.isVisible().catch(() => false))) {
    throw cbError('BRANCH_ACTION_UNVERIFIED', 'Could not locate More actions button on target assistant turn');
  }

  // Snapshot visible menus fail-closed before clicking More actions
  try {
    await page.evaluate(() => {
      const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      window.__cbExistingMenus = new Set(
        Array.from(document.querySelectorAll('[role="menu"]')).filter(isVisible)
      );
    });
  } catch (err) {
    throw cbError('BRANCH_ACTION_UNVERIFIED', `Could not snapshot visible action menus before opening: ${err.message || err}`);
  }

  try {
    await moreBtn.click({ timeout: 2000 });
  } catch {
    await moreBtn.click({ force: true });
  }
  await page.waitForTimeout(400);

  // Identify newly visible menu strictly via asElement() handle
  let menuHandle = null;
  try {
    menuHandle = await page.evaluateHandle(() => {
      const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const current = Array.from(document.querySelectorAll('[role="menu"]')).filter(isVisible);
      const existing = window.__cbExistingMenus || new Set();
      const newlyVisible = current.filter(m => !existing.has(m));
      delete window.__cbExistingMenus;
      return newlyVisible.length === 1 ? newlyVisible[0] : null;
    });
  } catch (err) {
    throw cbError('BRANCH_ACTION_UNVERIFIED', `Failed to evaluate newly visible action menu: ${err.message || err}`);
  }

  const newMenuEl = menuHandle?.asElement ? menuHandle.asElement() : null;
  if (!newMenuEl) {
    if (menuHandle?.dispose) await menuHandle.dispose().catch(() => {});
    throw cbError('BRANCH_ACTION_UNVERIFIED', 'Failed to uniquely identify newly opened action menu after clicking More actions');
  }

  // Require exactly one "Open new branch" item inside the proven menu
  const openBranchItems = await newMenuEl.$$('[role="menuitem"]:has-text("Open new branch")');
  if (!openBranchItems || openBranchItems.length !== 1) {
    await page.keyboard.press('Escape').catch(() => {});
    if (menuHandle?.dispose) await menuHandle.dispose().catch(() => {});
    throw cbError('BRANCH_ACTION_UNVERIFIED', `Expected exactly 1 "Open new branch" item in menu, found ${openBranchItems?.length || 0}`);
  }
  const openBranchItem = openBranchItems[0];

  // Snapshot visible menus fail-closed before hovering "Open new branch"
  try {
    await page.evaluate(() => {
      const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      window.__cbExistingSubmenus = new Set(
        Array.from(document.querySelectorAll('[role="menu"]')).filter(isVisible)
      );
    });
  } catch (err) {
    await page.keyboard.press('Escape').catch(() => {});
    if (menuHandle?.dispose) await menuHandle.dispose().catch(() => {});
    throw cbError('BRANCH_ACTION_UNVERIFIED', `Could not snapshot visible submenus before hover: ${err.message || err}`);
  }

  await openBranchItem.hover().catch(() => {});
  await page.waitForTimeout(400);

  // Identify newly visible submenu strictly via asElement() handle
  let submenuHandle = null;
  try {
    submenuHandle = await page.evaluateHandle(() => {
      const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const current = Array.from(document.querySelectorAll('[role="menu"]')).filter(isVisible);
      const existing = window.__cbExistingSubmenus || new Set();
      const newlyVisible = current.filter(m => !existing.has(m));
      delete window.__cbExistingSubmenus;
      return newlyVisible.length === 1 ? newlyVisible[0] : null;
    });
  } catch (err) {
    await page.keyboard.press('Escape').catch(() => {});
    if (menuHandle?.dispose) await menuHandle.dispose().catch(() => {});
    throw cbError('BRANCH_ACTION_UNVERIFIED', `Failed to evaluate newly visible branch submenu: ${err.message || err}`);
  }

  const newSubmenuEl = submenuHandle?.asElement ? submenuHandle.asElement() : null;
  if (!newSubmenuEl) {
    await page.keyboard.press('Escape').catch(() => {});
    if (submenuHandle?.dispose) await submenuHandle.dispose().catch(() => {});
    if (menuHandle?.dispose) await menuHandle.dispose().catch(() => {});
    throw cbError('BRANCH_ACTION_UNVERIFIED', 'Failed to uniquely identify newly opened branch submenu after hovering Open new branch');
  }

  // Require exactly one "Branch in new Chat" item inside the proven submenu
  const branchInNewChatItems = await newSubmenuEl.$$('[role="menuitem"]:has-text("Branch in new Chat"), [role="menuitem"]:has-text("Branch in new chat")');
  if (!branchInNewChatItems || branchInNewChatItems.length !== 1) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(100);
    await page.keyboard.press('Escape').catch(() => {});
    if (submenuHandle?.dispose) await submenuHandle.dispose().catch(() => {});
    if (menuHandle?.dispose) await menuHandle.dispose().catch(() => {});
    throw cbError('BRANCH_ACTION_UNVERIFIED', `Expected exactly 1 "Branch in new Chat" item in submenu, found ${branchInNewChatItems?.length || 0}`);
  }
  const branchInNewChatItem = branchInNewChatItems[0];

  return {
    moreBtn,
    openBranchItem,
    branchInNewChatItem,
  };
}

async function recoverCandidateBranchLineage(page, args, branch) {
  const childSessionId = branch.candidateChildSessionId || branch.childSessionId;
  const parentSessionId = branch.parentSessionId;
  if (!childSessionId || !parentSessionId || !STABLE_SESSION_ID_RE.test(childSessionId)) return branch;

  const action = async () => {
    let parentLease = null;
    let childLease = null;
    try {
      parentLease = await acquireConversationLease(parentSessionId, randomId('recover-branch-p'));
      childLease = await acquireConversationLease(childSessionId, randomId('recover-branch-c'));

      await openConversationBySessionId(page, childSessionId);
      await settlePage(page, 5000).catch(() => {});

      const branchInfo = await getBranchInfo(page).catch(() => null);
      if (branchInfo?.isFork && branchInfo.parentResolution === 'dom_divider') {
        if (branchInfo.parentSessionId === parentSessionId) {
          updateBranchLineage(branch.id, {
            dispatchState: 'lineage_attested',
            childSessionId,
            parentAttestation: {
              parentSessionId,
              verifiedVia: 'dom_divider',
            },
            lineageAttestation: {
              parentSessionId: branchInfo.parentSessionId,
              parentResolution: branchInfo.parentResolution,
              detectionVectors: branchInfo.detectionVectors,
              branchText: branchInfo.branchText,
            },
          }, 'branch_lineage_attested');

          ensureTranscript(transcriptPathForSession(childSessionId));

          const updated = updateBranchLineage(branch.id, {
            status: 'done',
            dispatchState: 'bound',
            childSessionId,
            childUrl: targetConversationUrl(childSessionId),
            lastError: '',
          }, 'branch_bound');

          info(`[stage3-recover] Successfully attested and bound stranded branch ${branch.id} -> ${childSessionId}`);
          return updated || branch;
        } else {
          // Positively contradictory parent recorded
          const updated = updateBranchLineage(branch.id, {
            status: 'failed',
            dispatchState: 'lineage_unverified',
            lastError: `Candidate child ${childSessionId} divider parent "${branchInfo.parentSessionId}" contradicts expected parent "${parentSessionId}"`,
          }, 'branch_lineage_unverified');
          info(`[stage3-recover] Candidate child ${childSessionId} has contradictory parent "${branchInfo.parentSessionId}" (expected "${parentSessionId}")`);
          return updated || branch;
        }
      } else {
        info(`[stage3-recover] Candidate child ${childSessionId} divider could not be verified against parent ${parentSessionId}`);
        return branch;
      }
    } finally {
      if (childLease) try { releaseConversationLease(childLease); } catch {}
      if (parentLease) try { releaseConversationLease(parentLease); } catch {}
    }
  };

  return await withBrowserLaneLease(args, randomId('stage3-recover-branch'), action);
}


function formatCarryForwardPrompt(options = {}) {
  const { carryRequest = '', carryResponse = '', carryPrompt = '', parentSessionId = '', branchAnchorDesc = '' } = options;
  const noticeLines = [
    `[Thread Continuity Notice: The previous session (${parentSessionId || 'parent'}) reached maximum length capacity. This conversation was branched from the preceding stable checkpoint${branchAnchorDesc ? ` (${branchAnchorDesc})` : ''}. For full continuity, here is the immediate preceding exchange that occurred as capacity was reached:]`,
    '',
    '---',
    '### Preceding Request:',
    carryRequest.trim(),
    '',
    '---',
    '### Preceding Agent Response:',
    carryResponse.trim(),
    '',
    '---',
    (carryPrompt || 'Please acknowledge receipt of this context and confirm readiness to continue from this state.').trim(),
  ];
  return noticeLines.join('\n');
}

function extractLastTurnFromTranscript(transcriptPath) {
  let candidatePaths = [transcriptPath];
  const dir = path.dirname(transcriptPath);
  const base = path.basename(transcriptPath);
  if (fs.existsSync(dir)) {
    const stales = fs.readdirSync(dir)
      .filter(f => f.startsWith(`${base}.stale-`))
      .sort()
      .reverse()
      .map(f => path.join(dir, f));
    candidatePaths = [...candidatePaths, ...stales];
  }

  for (const p of candidatePaths) {
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    const entries = parseTranscriptEntries(text);
    if (entries.length < 2) continue;
    let lastUser = null;
    let lastAssistant = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (!lastAssistant && entries[i].role === 'assistant') {
        lastAssistant = entries[i];
      } else if (lastAssistant && entries[i].role === 'user') {
        lastUser = entries[i];
        break;
      }
    }
    if (lastUser && lastAssistant) {
      const isStale = p !== transcriptPath;
      return {
        sourceFile: p,
        sourceFileHash: messageHash(text),
        provenance: isStale ? 'quarantined_stale_fallback' : 'active_transcript',
        request: lastUser.text,
        response: lastAssistant.text,
        userAt: lastUser.at,
        assistantAt: lastAssistant.at,
      };
    }
  }
  return null;
}

function canonicalCarryForwardPayloadHash(payload) {
  return messageHash(JSON.stringify({
    parentSessionId: payload.parentSessionId || '',
    request: payload.request || '',
    response: payload.response || '',
    prompt: payload.prompt || '',
    anchor: payload.anchor || 'latest',
  }));
}

function getOrCreateCarryForwardIncident(args, parentSessionId, payloadHash, provenanceMeta = {}) {
  return withSchedulerLock(() => {
    const state = loadRecoveryIncidentsState();
    if (args.recoveryIncidentId) {
      const existing = state.incidents.find(i => i.id === args.recoveryIncidentId);
      if (existing) {
        if (existing.operationKind !== 'carry_forward') {
          throw cbError('INCIDENT_BINDING_MISMATCH', `Recovery incident ${existing.id} operationKind "${existing.operationKind}" does not match requested "carry_forward"`);
        }
        if (existing.parentSessionId !== parentSessionId) {
          throw cbError('INCIDENT_BINDING_MISMATCH', `Recovery incident ${existing.id} parentSessionId "${existing.parentSessionId}" does not match requested "${parentSessionId}"`);
        }
        if (existing.carryPayloadHash !== payloadHash) {
          throw cbError('INCIDENT_BINDING_MISMATCH', `Recovery incident ${existing.id} payload hash "${existing.carryPayloadHash}" does not match requested "${payloadHash}"`);
        }
        return existing;
      }
    }

    const existingMatch = state.incidents.find(i =>
      i.operationKind === 'carry_forward' &&
      i.parentSessionId === parentSessionId &&
      i.carryPayloadHash === payloadHash &&
      i.state !== 'failed'
    );
    if (existingMatch) return existingMatch;

    const incidentId = args.recoveryIncidentId || `INC-CAPACITY-${randomId()}`;
    const branchOperationId = `branch-${incidentId}`;
    const continuationRoundId = `round-${incidentId}`;
    const record = {
      id: incidentId,
      operationKind: 'carry_forward',
      parentSessionId,
      carryPayloadHash: payloadHash,
      provenance: provenanceMeta.provenance || 'unknown',
      sourceFile: provenanceMeta.sourceFile || '',
      sourceFileHash: provenanceMeta.sourceFileHash || '',
      userAt: provenanceMeta.userAt || '',
      assistantAt: provenanceMeta.assistantAt || '',
      branchOperationId,
      continuationRoundId,
      childSessionId: '',
      childPageTargetId: '',
      state: 'prepared',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      pid: process.pid,
      lastError: '',
    };
    state.incidents.push(record);
    state.updatedAt = record.updatedAt;
    saveRecoveryIncidentsState(state);
    appendJsonl(RECOVERY_EVENTS_PATH, {
      type: 'carry_forward_registered',
      at: record.createdAt,
      incident: record,
    });
    return record;
  });
}

async function branchWithContextCarryForward(page, args) {
  const parentSessionId = args.expectedSessionId || sessionIdFromUrl(page.url());
  if (!parentSessionId) {
    throw cbError('BRANCH_TARGET_REQUIRED', 'Branch carry-forward requires a stable parent conversation UUID');
  }

  let carryRequest = args.carryRequest || '';
  let carryResponse = args.carryResponse || '';
  let extractedMeta = null;

  const readPayload = (val) => {
    if (val && val.startsWith('@') && fs.existsSync(val.slice(1))) {
      return fs.readFileSync(val.slice(1), 'utf8');
    }
    return val;
  };

  carryRequest = readPayload(carryRequest);
  carryResponse = readPayload(carryResponse);

  if (!carryRequest || !carryResponse) {
    const parentTranscript = args.transcript || transcriptPathForSession(parentSessionId);
    extractedMeta = extractLastTurnFromTranscript(parentTranscript);
    if (!carryRequest && extractedMeta?.request) carryRequest = extractedMeta.request;
    if (!carryResponse && extractedMeta?.response) carryResponse = extractedMeta.response;
  }

  if (!carryRequest || !carryResponse) {
    throw cbError('CARRY_FORWARD_PAYLOAD_UNRESOLVED', 'Could not resolve preceding request and response from arguments or parent transcript');
  }

  const payloadHash = canonicalCarryForwardPayloadHash({
    parentSessionId,
    request: carryRequest,
    response: carryResponse,
    prompt: args.carryPrompt || args.message || '',
    anchor: args.branchTurn || 'latest',
  });

  let incident = getOrCreateCarryForwardIncident(args, parentSessionId, payloadHash, {
    provenance: extractedMeta?.provenance || 'explicit_payload',
    sourceFile: extractedMeta?.sourceFile || '',
    sourceFileHash: extractedMeta?.sourceFileHash || '',
    userAt: extractedMeta?.userAt || '',
    assistantAt: extractedMeta?.assistantAt || '',
  });

  const incidentLease = await acquireRecoveryIncidentLease(incident.id);
  try {
    incident = getOrCreateCarryForwardIncident(args, parentSessionId, payloadHash);

    if (incident.state === 'completed' && incident.childSessionId) {
      info(`[stage3-carry] Carry-forward incident ${incident.id} already completed on child session ${incident.childSessionId}`);
      return {
        incidentId: incident.id,
        childSessionId: incident.childSessionId,
        childUrl: targetConversationUrl(incident.childSessionId),
        continuityPrompt: incident.continuityPrompt || '',
        continuationResponse: incident.continuationResponse || null,
        status: 'completed',
      };
    }

    // Check if continuation round was already dispatched/completed BEFORE allocating any child page
    if (incident.state === 'continuation_dispatching' && incident.continuationRoundId) {
      const roundsState = loadRoundState();
      const existingRound = roundsState.rounds.find((r) => r.id === incident.continuationRoundId);
      if (isPositivelyCompletedRound(existingRound)) {
        const respText = extractRoundResponseFromTranscript(existingRound.transcript, existingRound) || existingRound.responseText || '';
        if (!respText) {
          throw cbError('CONTINUATION_RESPONSE_UNAVAILABLE', `Continuation round "${existingRound.id}" completed but attributed response could not be extracted from transcript`);
        }
        const askResult = { text: respText, roundId: existingRound.id };
        updateRecoveryIncident(incident.id, {
          state: 'completed',
          continuationResponse: askResult,
        }, 'carry_forward_completed');
        return {
          incidentId: incident.id,
          childSessionId: incident.childSessionId,
          childUrl: targetConversationUrl(incident.childSessionId),
          continuityPrompt: incident.continuityPrompt || '',
          continuationResponse: askResult,
          status: 'completed',
        };
      }
      throw cbError('CONTINUATION_ROUND_UNCERTAIN', `Carry-forward continuation round "${incident.continuationRoundId}" is in uncertain state "${existingRound?.status || 'missing'}" and requires reconciliation`);
    }

    let childSessionId = incident.childSessionId;
    let childPage = null;
    let branchResult = null;

    const childArgs = {
      ...args,
      pageTargetId: '',
      targetId: '',
      conversation: childSessionId,
      expectedSessionId: childSessionId,
      roundId: incident.continuationRoundId,
      branchTurn: '',
      branchCarryForward: false,
      _laneLease: null,
    };

    // Reconcile branch_started using lower-level lineage if child was not recorded
    if (!childSessionId && incident.state === 'branch_started' && incident.branchOperationId) {
      const lineageState = loadLineageState();
      const existingBranch = lineageState.branches.find(b => b.id === incident.branchOperationId || b.id === incident.id);
      if (isPositivelyBoundBranch(existingBranch, parentSessionId)) {
        childSessionId = existingBranch.childSessionId;
        updateRecoveryIncident(incident.id, {
          state: 'branched',
          childSessionId,
          branchOperationId: existingBranch.id,
        }, 'carry_forward_branch_reconciled');
      }
    }

    if (!childSessionId && incident.state === 'branch_started') {
      throw cbError('BRANCH_OPERATION_UNCERTAIN', `Carry-forward branch operation "${incident.branchOperationId}" is uncertain and requires manual reconciliation before retry`);
    }

    if (!childSessionId) {
      updateRecoveryIncident(incident.id, { state: 'branch_started' }, 'carry_forward_branch_started');
      info(`[stage3-carry] Branching from parent session ${parentSessionId}...`);
      const branchArgs = {
        ...args,
        branchId: incident.branchOperationId,
      };
      branchResult = await branchConversationTurn(page, branchArgs);
      childSessionId = branchResult.childSessionId;
      childPage = branchResult.childPage;
      childArgs.conversation = childSessionId;
      childArgs.expectedSessionId = childSessionId;
      updateRecoveryIncident(incident.id, {
        state: 'branched',
        childSessionId,
        branchOperationId: branchResult.branchRecord?.id || incident.branchOperationId,
      }, 'carry_forward_branched');
    } else {
      info(`[stage3-carry] Reusing established child session ${childSessionId} for incident ${incident.id}...`);
      const browser = page.context ? (typeof page.context === 'function' ? page.context().browser() : page.context.browser?.()) : null;
      if (browser) {
        const matchingPages = [];
        for (const ctx of browser.contexts()) {
          for (const p of ctx.pages()) {
            if (sessionIdFromUrl(p.url()) === childSessionId) {
              matchingPages.push(p);
            }
          }
        }
        if (matchingPages.length > 1) {
          throw cbError('MULTIPLE_CONVERSATION_TABS', `Multiple open tabs matched child conversation "${childSessionId}"`);
        }
        if (matchingPages.length === 1) {
          childPage = matchingPages[0];
        }
      }
      if (!childPage && browser) {
        childArgs.newTab = true;
        childPage = await findTargetAppPage(browser, childArgs);
      }
      if (!childPage) {
        throw cbError('CHILD_PAGE_UNAVAILABLE', `Could not allocate or locate dedicated page for child conversation "${childSessionId}"`);
      }
      branchResult = {
        childSessionId,
        childUrl: targetConversationUrl(childSessionId),
        childPage,
      };
    }

    let continuityPrompt = '';
    try {
      info(`[stage3-carry] Synthesizing continuity prompt for child session ${childSessionId}...`);
      continuityPrompt = formatCarryForwardPrompt({
        carryRequest,
        carryResponse,
        carryPrompt: args.carryPrompt || args.message || '',
        parentSessionId,
        branchAnchorDesc: branchResult.branchRecord?.sourceTurnMessageId || branchResult.branchRecord?.sourceTurnTestid || '',
      });

      childArgs.conversation = childSessionId;
      childArgs.expectedSessionId = childSessionId;
      const targetPage = childPage || branchResult.childPage;
      if (!targetPage) {
        throw cbError('PAGE_TARGET_ID_UNVERIFIED', 'Stage 3 carry-forward did not resolve a bound child Page');
      }

      const childTid = await getPageTargetId(targetPage);
      if (typeof childTid !== 'string' || !childTid.trim()) {
        throw cbError('PAGE_TARGET_ID_UNVERIFIED', 'Cannot dispatch carry-forward prompt without verified physical child target identity');
      }

      updateRecoveryIncident(incident.id, { childPageTargetId: childTid });

      if (targetPage._laneLease && !childArgs._laneLease) {
        childArgs._laneLease = targetPage._laneLease;
        targetPage._laneLease = null;
      }

      childArgs.pageTargetId = childTid;
      childArgs.targetId = childTid;
      childArgs.message = continuityPrompt;

      updateRecoveryIncident(incident.id, {
        state: 'continuation_dispatching',
        continuityPrompt,
      }, 'carry_forward_dispatching');

      info(`[stage3-carry] Dispatching continuity prompt to child ${childSessionId}...`);
      // Ownership adopted by ask() via takeBrowserLaneLease(childArgs), setting childArgs._laneLease = null
      const askResult = await ask(targetPage, continuityPrompt, childArgs);

      updateRecoveryIncident(incident.id, {
        state: 'completed',
        continuationResponse: askResult,
      }, 'carry_forward_completed');

      return {
        ...branchResult,
        incidentId: incident.id,
        continuityPrompt,
        continuationResponse: askResult,
      };
    } finally {
      if (childArgs._laneLease) {
        try { releaseBrowserLaneLease(childArgs._laneLease); } catch {}
        childArgs._laneLease = null;
      }
    }
  } finally {
    releaseRecoveryIncidentLease(incidentLease);
  }
}

async function branchConversationTurn(page, args) {
  await prepareConversationForRead(page, args);
  const expectedParentSessionId = args.expectedSessionId;
  if (!expectedParentSessionId) {
    throw cbError('BRANCH_TARGET_REQUIRED', 'Stage 3 recovery branching requires an existing stable conversation');
  }

  const action = async () => {
    const provisionalBranchId = args.branchId || randomId('branch');

    // Preflight disposition check: validate existing branch before acquiring parent lease or reloading
    if (args.branchId) {
      const existingBranch = loadLineageState().branches.find((b) => b.id === args.branchId);
      if (existingBranch) {
        if (existingBranch.parentSessionId && expectedParentSessionId && existingBranch.parentSessionId !== expectedParentSessionId) {
          throw cbError('BRANCH_BINDING_MISMATCH', `Reserved branch "${existingBranch.id}" parent mismatch: expected "${existingBranch.parentSessionId}", got "${expectedParentSessionId}"`);
        }
        if (args.expectedAnchorRevisionHash && existingBranch.sourceTurnRef?.textHash) {
          if (existingBranch.sourceTurnRef.textHash !== args.expectedAnchorRevisionHash) {
            throw cbError('BRANCH_BINDING_MISMATCH', `Reserved branch "${existingBranch.id}" anchor revision mismatch: expected "${existingBranch.sourceTurnRef.textHash}", got "${args.expectedAnchorRevisionHash}"`);
          }
        }
        if (args.branchTurn && existingBranch.sourceTurnRef) {
          const reqTurn = String(args.branchTurn).trim();
          const storedKeys = [
            existingBranch.sourceTurnRef.turnKey,
            existingBranch.sourceTurnRef.logicalTurnId,
            existingBranch.sourceTurnRef.messageId,
            existingBranch.sourceTurnRef.testid,
          ].filter(Boolean);
          if (reqTurn && !['latest', 'prior-assistant', ''].includes(reqTurn) && storedKeys.length && !storedKeys.includes(reqTurn)) {
            throw cbError('BRANCH_BINDING_MISMATCH', `Reserved branch "${existingBranch.id}" source turn mismatch: requested "${reqTurn}" not found in stored turn identities [${storedKeys.join(', ')}]`);
          }
        }
        if (args.recoveryIncidentId && existingBranch.recoveryIncidentId && args.recoveryIncidentId !== existingBranch.recoveryIncidentId) {
          throw cbError('BRANCH_BINDING_MISMATCH', `Reserved branch "${existingBranch.id}" recovery incident mismatch: expected "${existingBranch.recoveryIncidentId}", got "${args.recoveryIncidentId}"`);
        }
        if (existingBranch.dispatchState !== 'prepared') {
          if (isPositivelyBoundBranch(existingBranch, expectedParentSessionId)) {
            info(`[stage3] Branch "${existingBranch.id}" already resolved to child ${existingBranch.childSessionId}`);
            return {
              childSessionId: existingBranch.childSessionId,
              childUrl: targetConversationUrl(existingBranch.childSessionId),
              branchRecord: existingBranch,
            };
          }
          throw cbError('BRANCH_OPERATION_UNCERTAIN', `Branch operation "${existingBranch.id}" is in state "${existingBranch.dispatchState}" (status: ${existingBranch.status || 'unknown'}) and cannot be re-dispatched`);
        }
      }
    }

    const parentLease = await acquireConversationLease(expectedParentSessionId, provisionalBranchId);

    let branchRecord = null;
    let localDispatchState = 'unregistered';
    let childLease = null;
    let childPageLane = null;
    try {
      if (sessionIdFromUrl(page.url()) !== expectedParentSessionId) {
        await openConversationBySessionId(page, expectedParentSessionId);
      }

      // POSITIVELY ESTABLISH RELOAD-SAFE LIFECYCLE STATE BEFORE RELOADING!
      const initialPreState = await getTargetAppState(page);
      const initialGen = await getCombinedGenerationState(page, initialPreState);

      const isStrandedAtCapacity = async (currentState, currentGen) => {
        if (!currentState?.maxLengthReached) return false;
        if (currentGen.hasStopControl) return false;
        if (currentGen.activity && /thinking|thought|searching|reading|analyzing|running|tool|generating/i.test(currentGen.activity)) {
          return false;
        }
        // Positively assert stop button absence without swallowing errors
        const stopLoc = page.locator('button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop answering"], button[aria-label="Stop"]');
        const count = await stopLoc.count().catch(() => 1);
        if (count > 0) return false;
        try {
          const t1 = await getConversationTurns(page);
          if (!t1 || !t1.length) return false;
          const s1 = t1.map(t => `${t.logicalTurnId || t.testid}:${t.text}`).join('|');
          if (typeof page.waitForTimeout === 'function') {
            await page.waitForTimeout(600);
          } else {
            await new Promise((r) => setTimeout(r, 600));
          }
          const t2 = await getConversationTurns(page);
          if (!t2 || !t2.length) return false;
          const s2 = t2.map(t => `${t.logicalTurnId || t.testid}:${t.text}`).join('|');
          return s1 === s2;
        } catch {
          return false;
        }
      };

      if (initialGen.isGenerating) {
        const stranded = await isStrandedAtCapacity(initialPreState, initialGen);
        if (!stranded) {
          throw cbError('CONVERSATION_BUSY', 'Cannot perform Stage 3 branching while active token generation is in progress');
        }
        info('[stage3] Notice: Tail generation control is stranded at capacity limit (quiescent); verified safe to reload');
      }

      await reloadExactConversation(page, expectedParentSessionId, 'stage3-branch-reload');
      await assertThreadIdentity(page, expectedParentSessionId, 'before stage3 branch preparation');

      const preState = await getTargetAppState(page);
      const generation = await getCombinedGenerationState(page, preState);
      if (generation.isGenerating) {
        const stranded = await isStrandedAtCapacity(preState, generation);
        if (!stranded) {
          throw cbError('CONVERSATION_BUSY', 'Cannot perform Stage 3 branching while active token generation is in progress');
        }
        info('[stage3] Notice: Post-reload tail generation control is stranded at capacity limit (quiescent); proceeding with Stage 3 branch recovery');
      }

      await syncTranscriptFromPage(page, args);

      const sourceAssistant = await resolveBranchableTurn(page, args.branchTurn || 'latest', args.expectedAnchorRevisionHash);
      branchRecord = registerPendingBranch(args, page, sourceAssistant, {
        id: args.branchId || provisionalBranchId,
        parentSessionId: expectedParentSessionId,
      });

      if (branchRecord.dispatchState !== 'prepared') {
        if (isPositivelyBoundBranch(branchRecord, expectedParentSessionId)) {
          info(`[stage3] Branch "${branchRecord.id}" already resolved to child ${branchRecord.childSessionId}`);
          return {
            childSessionId: branchRecord.childSessionId,
            childUrl: targetConversationUrl(branchRecord.childSessionId),
            branchRecord,
          };
        }
        throw cbError('BRANCH_OPERATION_UNCERTAIN', `Branch operation "${branchRecord.id}" is in state "${branchRecord.dispatchState}" (status: ${branchRecord.status || 'unknown'}) and cannot be re-dispatched`);
      }
      localDispatchState = 'prepared';

      const controls = await openBranchMenu(page, sourceAssistant);
      const { branchInNewChatItem } = controls;

      await assertThreadIdentity(page, expectedParentSessionId, 'immediately before branch click');

      // Re-verify that source turn revision is still present in canonical turns
      const currentTurns = await getConversationTurns(page).catch(() => []);
      const sourceStillPresent = currentTurns.some(t => t.role === 'assistant' && sameTurnRevision(t, sourceAssistant));
      if (!sourceStillPresent) {
        throw cbError('BRANCH_SOURCE_UNVERIFIED', 'Source turn revision changed or disappeared before branch dispatch');
      }

      const genCheck = await getCombinedGenerationState(page);
      if (genCheck.isGenerating) {
        const stranded = await isStrandedAtCapacity();
        if (!stranded) {
          throw cbError('CONVERSATION_BUSY', 'Generation became active before branch could be clicked');
        }
        info('[stage3] Notice: Proceeding with branch click as generation is quiescent at capacity limit');
      }

      let destinationPage = null;
      await withTopologyLease(args, randomId('branch-destination-alloc'), async () => {
        const parentUrlBefore = page.url();
        const pagesBefore = new Set(page.context().pages());

        localDispatchState = 'dispatching';
        branchRecord = updateBranchLineage(branchRecord.id, {
          dispatchState: 'dispatching',
          dispatchStartedAt: nowIso(),
        }, 'branch_dispatching') || branchRecord;

        try {
          await branchInNewChatItem.click();
        } catch (clickErr) {
          localDispatchState = 'uncertain';
          branchRecord = updateBranchLineage(branchRecord.id, {
            status: 'pending',
            dispatchState: 'dispatch_uncertain',
            lastError: clickErr.message || String(clickErr),
          }, 'branch_dispatch_uncertain') || branchRecord;
          throw cbError('BRANCH_DISPATCH_UNCERTAIN', `Stage 3 branch click uncertainty: ${clickErr.message || clickErr}`);
        }

        // Discover destination page fail-closed against destination ambiguity
        const startWait = Date.now();
        while (Date.now() - startWait < 15000) {
          const currentPages = page.context().pages();
          const newPages = currentPages.filter((p) => !pagesBefore.has(p));
          const parentNavigated = page.url() !== parentUrlBefore;

          if (newPages.length > 0 && parentNavigated) {
            localDispatchState = 'destination_unverified';
            branchRecord = updateBranchLineage(branchRecord.id, {
              status: 'pending',
              dispatchState: 'destination_unverified',
              lastError: 'Ambiguous destination: newly opened page detected and source page also navigated',
            }, 'branch_destination_unverified') || branchRecord;
            throw cbError('BRANCH_DESTINATION_UNVERIFIED', 'Ambiguous destination: newly opened page detected and source page also navigated');
          }

          if (newPages.length > 1) {
            localDispatchState = 'destination_unverified';
            branchRecord = updateBranchLineage(branchRecord.id, {
              status: 'pending',
              dispatchState: 'destination_unverified',
              lastError: 'Multiple newly opened pages detected after branch click',
            }, 'branch_destination_unverified') || branchRecord;
            throw cbError('BRANCH_DESTINATION_UNVERIFIED', 'Multiple newly opened pages detected after branch click');
          }

          if (newPages.length === 1 && !parentNavigated) {
            destinationPage = newPages[0];
            break;
          }

          if (newPages.length === 0 && parentNavigated) {
            destinationPage = page;
            break;
          }

          await page.waitForTimeout(300);
        }

        if (destinationPage && destinationPage !== page) {
          const childTid = await getPageTargetId(destinationPage);
          if (!childTid) {
            throw cbError('PAGE_TARGET_ID_UNVERIFIED', 'Could not establish physical CDP target identity for Stage 3 child page');
          }
          childPageLane = acquireBrowserLaneLease({ cdp: args.cdp, pageTargetId: childTid }, randomId('stage3-child-lane'));
        }
      });

      if (!destinationPage) {
        localDispatchState = 'destination_unverified';
        branchRecord = updateBranchLineage(branchRecord.id, {
          status: 'pending',
          dispatchState: 'destination_unverified',
          lastError: 'Timed out waiting for destination page to navigate or open',
        }, 'branch_destination_unverified') || branchRecord;
        throw cbError('BRANCH_DESTINATION_UNVERIFIED', 'Timed out waiting for branch destination page to navigate or open');
      }

      await destinationPage.waitForLoadState('domcontentloaded').catch(() => {});

      const expectedOrigin = new URL(branchRecord.sourceUrl).origin;
      const destUrl = new URL(destinationPage.url());
      if (destUrl.origin !== expectedOrigin) {
        localDispatchState = 'destination_unverified';
        branchRecord = updateBranchLineage(branchRecord.id, {
          status: 'pending',
          dispatchState: 'destination_unverified',
          lastError: `Destination page origin "${destUrl.origin}" does not match target origin "${expectedOrigin}"`,
        }, 'branch_destination_unverified') || branchRecord;
        throw cbError('BRANCH_DESTINATION_UNVERIFIED', 'Destination page origin does not match ChatGPT target origin');
      }

      // Handle provisional route (/c/WEB:*)
      if (isEphemeralRouteId(routeSessionIdFromUrl(destinationPage.url()))) {
        localDispatchState = 'provisional';
        branchRecord = updateBranchLineage(branchRecord.id, {
          dispatchState: 'provisional',
          provisionalRoute: destinationPage.url(),
        }, 'branch_provisional') || branchRecord;
      }

      // Wait for stable child UUID
      const childSessionId = await waitForSessionIdInUrl(destinationPage, 30000);
      if (!childSessionId || !STABLE_SESSION_ID_RE.test(childSessionId)) {
        localDispatchState = 'destination_unverified';
        branchRecord = updateBranchLineage(branchRecord.id, {
          status: 'pending',
          dispatchState: 'destination_unverified',
          lastError: 'Stable child session ID was not observed in URL',
        }, 'branch_destination_unverified') || branchRecord;
        throw cbError('BRANCH_DESTINATION_UNVERIFIED', 'Stable child session ID was not observed');
      }

      if (childSessionId === expectedParentSessionId) {
        localDispatchState = 'destination_unverified';
        branchRecord = updateBranchLineage(branchRecord.id, {
          status: 'failed',
          dispatchState: 'destination_unverified',
          candidateChildSessionId: childSessionId,
          lastError: 'Child session ID matches parent session ID',
        }, 'branch_destination_unverified') || branchRecord;
        throw cbError('BRANCH_IDENTITY_INVALID', 'Child session ID matches parent session ID');
      }

      // Persist stable_candidate state before acquiring child lease
      localDispatchState = 'stable_candidate';
      branchRecord = updateBranchLineage(branchRecord.id, {
        dispatchState: 'stable_candidate',
        candidateChildSessionId: childSessionId,
      }, 'branch_stable_candidate') || branchRecord;

      // Acquire child lease while still holding parent lease (overlapping leases)
      childLease = await acquireConversationLease(childSessionId, branchRecord.id);

      // Settle and verify lineage via dom_divider
      await settlePage(destinationPage, 5000).catch(() => {});
      const branchInfo = await getBranchInfo(destinationPage).catch(() => null);

      if (!branchInfo?.isFork || branchInfo.parentResolution !== 'dom_divider' || branchInfo.parentSessionId !== expectedParentSessionId) {
        localDispatchState = 'lineage_unverified';
        branchRecord = updateBranchLineage(branchRecord.id, {
          status: 'failed',
          dispatchState: 'lineage_unverified',
          candidateChildSessionId: childSessionId,
          lastError: `Parent resolution "${branchInfo?.parentResolution}" / parent ID "${branchInfo?.parentSessionId}" does not match expected parent "${expectedParentSessionId}"`,
        }, 'branch_lineage_unverified') || branchRecord;
        throw cbError('BRANCH_LINEAGE_UNVERIFIED', `DOM divider parent ID "${branchInfo?.parentSessionId}" does not match expected parent "${expectedParentSessionId}"`);
      }

      localDispatchState = 'lineage_attested';
      branchRecord = updateBranchLineage(branchRecord.id, {
        dispatchState: 'lineage_attested',
        childSessionId,
        parentAttestation: {
          parentSessionId: expectedParentSessionId,
          verifiedVia: 'dom_divider',
        },
        lineageAttestation: {
          parentSessionId: branchInfo.parentSessionId,
          parentResolution: branchInfo.parentResolution,
          detectionVectors: branchInfo.detectionVectors,
          branchText: branchInfo.branchText,
        },
      }, 'branch_lineage_attested') || branchRecord;

      // Ensure child transcript exists cleanly without fabricating ancestry
      ensureTranscript(transcriptPathForSession(childSessionId));

      localDispatchState = 'bound';
      branchRecord = updateBranchLineage(branchRecord.id, {
        status: 'done',
        dispatchState: 'bound',
        childSessionId,
        childUrl: targetConversationUrl(childSessionId),
        lastError: '',
      }, 'branch_bound') || branchRecord;

      info(`[stage3] Successfully branched ${expectedParentSessionId} -> ${childSessionId} at ${sourceAssistant.testid || sourceAssistant.messageId}`);
      return {
        childSessionId,
        childUrl: targetConversationUrl(childSessionId),
        childPage: destinationPage,
        branchRecord,
      };
    } catch (err) {
      if (branchRecord && localDispatchState === 'prepared') {
        localDispatchState = 'aborted_precommit';
        branchRecord = updateBranchLineage(branchRecord.id, {
          status: 'failed',
          dispatchState: 'aborted_precommit',
          lastError: err.message || String(err),
        }, 'branch_aborted') || branchRecord;
      }
      throw err;
    } finally {
      if (childPageLane) {
        try { releaseBrowserLaneLease(childPageLane); } catch {}
      }
      if (childLease) {
        try { releaseConversationLease(childLease); } catch {}
      }
      if (parentLease) {
        try { releaseConversationLease(parentLease); } catch {}
      }
    }
  };

  return await withBrowserLaneLease(args, randomId('stage3-branch-op'), action);
}

function reconcileIncompleteBranches() {
  return withSchedulerLock(() => {
    const state = loadLineageState();
    let modified = false;

    for (const branch of state.branches) {
      if (branch.status === 'done' || branch.status === 'failed') continue;

      const pid = branch.pid;
      let isAlive = false;
      if (pid) {
        try {
          process.kill(pid, 0);
          isAlive = true;
        } catch {
          isAlive = false;
        }
      }

      if (!isAlive) {
        if (branch.dispatchState === 'prepared') {
          branch.status = 'failed';
          branch.dispatchState = 'aborted_precommit';
          branch.lastError = 'Owner process died before branch dispatch';
          branch.updatedAt = nowIso();
          modified = true;
          appendJsonl(LINEAGE_EVENTS_PATH, {
            type: 'branch_reconciled',
            at: branch.updatedAt,
            branch,
          });
        } else if (branch.dispatchState === 'dispatching') {
          branch.status = 'pending';
          branch.dispatchState = 'dispatch_uncertain';
          branch.lastError = 'Owner process died during branch dispatch';
          branch.updatedAt = nowIso();
          modified = true;
          appendJsonl(LINEAGE_EVENTS_PATH, {
            type: 'branch_reconciled',
            at: branch.updatedAt,
            branch,
          });
        } else if (branch.dispatchState === 'provisional' || branch.dispatchState === 'stable_candidate') {
          branch.status = 'pending';
          branch.dispatchState = 'destination_unverified';
          branch.lastError = 'Owner process died before child lineage verification';
          branch.updatedAt = nowIso();
          modified = true;
          appendJsonl(LINEAGE_EVENTS_PATH, {
            type: 'branch_reconciled',
            at: branch.updatedAt,
            branch,
          });
        } else if (branch.dispatchState === 'lineage_attested') {
          const validChild = STABLE_SESSION_ID_RE.test(branch.childSessionId || '');
          const validAttestation = branch.parentAttestation?.verifiedVia === 'dom_divider' &&
            branch.parentAttestation?.parentSessionId === branch.parentSessionId &&
            (!branch.lineageAttestation?.parentSessionId || branch.lineageAttestation.parentSessionId === branch.parentSessionId);
          if (!validChild || !validAttestation) {
            branch.status = 'failed';
            branch.dispatchState = 'lineage_unverified';
            branch.lastError = 'Stranded lineage_attested record failed schema/parent attestation validation';
            branch.updatedAt = nowIso();
            modified = true;
            appendJsonl(LINEAGE_EVENTS_PATH, {
              type: 'branch_reconciled',
              at: branch.updatedAt,
              branch,
            });
            continue;
          }

          ensureTranscript(transcriptPathForSession(branch.childSessionId));
          branch.status = 'done';
          branch.dispatchState = 'bound';
          branch.childUrl = targetConversationUrl(branch.childSessionId);
          branch.lastError = '';
          branch.updatedAt = nowIso();
          modified = true;
          appendJsonl(LINEAGE_EVENTS_PATH, {
            type: 'branch_bound',
            at: branch.updatedAt,
            branch,
          });
        }
      }
    }

    if (modified) {
      saveLineageState(state);
    }
    return state;
  });
}

function validateRecoveryMode(args) {
  if (!args.recoveryResend) return;

  if (args.newConversation) {
    throw cbError('INVALID_RECOVERY_MODE', '--recovery-resend cannot be combined with --new-conversation');
  }
  if (args.schedule || args.runQueue || args.queueWatch || args.queueStatus || args.recoverQueue) {
    throw cbError('INVALID_RECOVERY_MODE', '--recovery-resend cannot be combined with scheduling or queue operations');
  }
  const conflictingRecoveryActions = [
    args.status,
    args.watchState,
    args.waitReady,
    args.syncTranscript,
    args.latestAssistant,
    args.dismissBlocker,
    Boolean(args.searchQuery),
    args.models,
    args.stop,
    args.compactConversation,
    args.handoffNewSession,
    args.recoverInterrupted,
    args.downloadArtifacts,
  ];
  if (conflictingRecoveryActions.some(Boolean)) {
    throw cbError('INVALID_RECOVERY_MODE', '--recovery-resend cannot be combined with another primary operation');
  }
  if (typeof args.message !== 'string' || !args.message.trim()) {
    throw cbError('RECOVERY_MESSAGE_REQUIRED', '--recovery-resend is a one-shot operation and requires non-empty --message');
  }
  if (!args.recoveryIncidentId || !args.recoveryIncidentId.trim()) {
    throw cbError('RECOVERY_INCIDENT_REQUIRED', '--recovery-resend requires --recovery-incident <id>');
  }

  // Automatic discriminator injection: guarantees WAL transcript uniqueness
  const cleanIncidentId = args.recoveryIncidentId.trim();
  const discriminator = `[Recovery Stage 2: ${cleanIncidentId}]`;
  if (!args.message.startsWith(discriminator)) {
    args.message = `${discriminator} ${args.message.trim()}`;
  }
}

async function prepareRecoveryResendTarget(page, args, expectedSessionId) {
  if (sessionIdFromUrl(page.url()) !== expectedSessionId) {
    await openConversationBySessionId(page, expectedSessionId);
  }
  await reloadExactConversation(page, expectedSessionId, 'recovery-resend');
  await assertThreadIdentity(page, expectedSessionId, 'before recovery-resend prompt preparation');
}

async function prepareConversationForPrompt(page, args) {
  if (args.recoveryResend) {
    if (args.newConversation) {
      throw cbError('INVALID_RECOVERY_MODE', '--recovery-resend cannot be combined with --new-conversation');
    }
    if (args.schedule || args.runQueue || args.queueWatch) {
      throw cbError('INVALID_RECOVERY_MODE', '--recovery-resend cannot be combined with scheduling or queue operations');
    }
    if (!args.message) {
      throw cbError('RECOVERY_MESSAGE_REQUIRED', '--recovery-resend is a one-shot operation and requires --message');
    }
    if (!args.conversation && !args.expectedSessionId) {
      const rawUrl = page.url();
      const currentSessionId = sessionIdFromUrl(rawUrl);
      if (!currentSessionId) {
        throw cbError('RECOVERY_TARGET_REQUIRED', 'Stage 2 recovery requires an existing stable conversation');
      }
    }
  }
  if (args.newConversation) {
    // Leave new conversation root navigation to ask() under the bootstrap lease
    return;
  }
  if (!args.conversation || isCurrentConversationRef(args.conversation)) {
    const rawUrl = page.url();
    const currentSessionId = sessionIdFromUrl(rawUrl);
    if (!currentSessionId) {
      if (args.recoveryResend) {
        throw cbError('RECOVERY_TARGET_REQUIRED', 'Stage 2 recovery requires an existing stable conversation');
      }
      if (isCanonicalTargetRoot(rawUrl)) {
        info('[mode] Active tab is at canonical root; promoting prompt to hardened new-conversation transaction');
        args.newConversation = true;
        return;
      }
      throw cbError(
        'NEW_CHAT_MODE_REQUIRED',
        `Current page (${rawUrl}) has no stable conversation identity; use --new-conversation or target an existing thread with --conversation`,
        { url: rawUrl }
      );
    }
    args.expectedSessionId = currentSessionId;
    const state = await getTargetAppState(page).catch(() => null);
    if (state?.maxLengthReached) {
      info('[state] Note: Maximum conversation length advisory banner visible on thread. If prompt is rejected, follow 3-stage recovery (edit/regenerate -> resend -> native branch).');
    }
    return;
  }

  const index = loadConversationIndex();
  const parsed = parseConversationRef(args.conversation, index);
  const sessionId = parsed.sessionId;
  if (!sessionId) {
    throw new Error(`Conversation "${args.conversation}" is not resolved to a target app session id yet`);
  }
  args.expectedSessionId = sessionId;
  // Navigation for existing threads is ask()-owned strictly under the acquired browserLaneLease
}

async function prepareConversationForRead(page, args) {
  if (!args.conversation || isCurrentConversationRef(args.conversation)) return;

  const index = loadConversationIndex();
  const parsed = parseConversationRef(args.conversation, index);
  const sessionId = parsed.sessionId;
  if (!sessionId) {
    throw new Error(`Conversation "${args.conversation}" is not resolved to a target app session id yet`);
  }
  args.expectedSessionId = sessionId;
}

function recordPromptConversation(args, page, response, explicitSessionId = '') {
  const sessionId = explicitSessionId || args.expectedSessionId || sessionIdFromUrl(page.url());
  if (!sessionId && !args.alias) return null;
  return withSchedulerLock(() => {
    const index = loadConversationIndex();
    const alias = normalizeAlias(args.alias || '', 'conversation alias');
    const record = upsertConversation(index, {
      alias,
      sessionId,
      status: sessionId ? 'active' : 'pending',
      url: sessionId ? targetConversationUrl(sessionId) : page.url(),
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

function recordResolvedConversation(job, page, response, explicitSessionId = '') {
  const sessionId = explicitSessionId || sessionIdFromUrl(page.url());
  if (!sessionId) return null;
  return withSchedulerLock(() => {
    const index = loadConversationIndex();
    const alias = job.target?.alias || '';
    const record = upsertConversation(index, {
      alias,
      sessionId,
      status: 'active',
      url: targetConversationUrl(sessionId),
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
  return sessionIdFromSchedulerRecord(record)
    || job.target?.sessionId
    || sessionIdFromSchedulerRecord(job.result)
    || '';
}

function findRoundForJob(rounds, job, index = null) {
  if (job?.id) {
    const explicit = [...rounds].reverse().find((round) => round.jobId && round.jobId === job.id);
    if (explicit) return explicit;
  }
  const candidates = [...rounds].reverse().filter((round) => jobMatchesRound(job, round));
  if (!candidates.length) return null;

  const expectedSessionId = expectedSessionIdForJob(job, index);
  if (expectedSessionId) {
    return candidates.find((round) => sessionIdFromSchedulerRecord(round) === expectedSessionId) || null;
  }

  const jobHash = messageHash(job.message || '');
  const exactHashMatches = candidates.filter((round) => round.messageHash && round.messageHash === jobHash);
  if (exactHashMatches.length === 1) return exactHashMatches[0];

  const sessionMatches = candidates.filter((round) => sessionIdFromSchedulerRecord(round));
  return sessionMatches.length === 1 ? sessionMatches[0] : null;
}

function scheduledJobIsRecoverable(status) {
  return ['running', 'waiting', 'needs_recovery', 'failed'].includes(status);
}

function scheduledJobNeedsReconciliation(status) {
  return scheduledJobIsRecoverable(status) || status === 'done';
}

function queueHoldStatusForError(error) {
  switch (error?.code) {
    case 'DISPATCH_UNCERTAIN':
    case 'CONVERSATION_NOT_HYDRATED':
    case 'CONVERSATION_LEASE_BUSY':
    case 'BOOTSTRAP_LEASE_BUSY':
    case 'BROWSER_LANE_BUSY':
    case 'NEW_SESSION_ID_UNCERTAIN':
    case 'NEW_SESSION_ATTRIBUTION_MISMATCH':
    case 'NEW_SESSION_ATTRIBUTION_UNVERIFIED':
      return 'needs_recovery';
    case 'THREAD_IDENTITY_DRIFT':
    case 'NEW_CHAT_ROUTE_DRIFT':
    case 'CONCURRENT_CONVERSATION_MUTATION':
    case 'ASSISTANT_TERMINAL_ERROR':
    case 'CONVERSATION_BUSY':
      return 'failed';
  }
  const message = error?.message || String(error || '');
  if (/Timed out after \d+ms while target app was still generating/i.test(message)) return 'waiting';
  if (/target app UI blocker|modal-conversation-history-rate-limit|conversation_history_rate_limit|modal-subscription-failure|subscription_modal|intercepts pointer events|Prompt was not submitted|Prompt was submitted but target app did not assign a session id|send button stayed disabled|not submitted/i.test(message)) return 'needs_recovery';
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
      const roundSessionId = sessionIdFromSchedulerRecord(round);
      const transcript = roundSessionId === context.activeSessionId
        ? args.transcript
        : (round.transcript || '');
      if (!transcript || !fs.existsSync(transcript)) return '';
      if (!transcriptEntries.has(transcript)) {
        transcriptEntries.set(transcript, parseTranscriptEntries(fs.readFileSync(transcript, 'utf8')));
      }
      return responseAfterRound(transcriptEntries.get(transcript), round);
    };

    for (const round of roundState.rounds) {
      if (!roundAllowsTranscriptRecovery(round)) continue;
      const normalized = normalizeSchedulerSessionRecord(round);
      if (normalized.sessionId && (
        round.sessionId !== normalized.sessionId
        || round.url !== normalized.url
        || round.transcript !== normalized.transcript
      )) {
        Object.assign(round, normalized, { updatedAt: now });
        changedRounds.push({ type: 'round_session_backfilled', round });
      }
    }

    for (const job of queue.jobs) {
      if (!scheduledJobNeedsReconciliation(job.status)) continue;
      const round = findRoundForJob(roundState.rounds, job, index);
      if (round && !roundAllowsTranscriptRecovery(round)) continue;
      const sessionId = sessionIdFromSchedulerRecord(round) || sessionIdFromSchedulerRecord(job.result) || '';
      if (!round && !sessionId) continue;

      if (round && (round.dispatchState === 'aborted_precommit' || round.dispatchState === 'prepared')) {
        continue;
      }

      const activeRound = context.activeSessionId && sessionIdFromSchedulerRecord(round) === context.activeSessionId;
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
            sessionId,
            responseChars: 0,
            completedAt: '',
            lastError: message,
            updatedAt: now,
          });
          changedRounds.push({ type: 'round_waiting', round });
        }
        continue;
      }

      if (round && (round.dispatchState === 'aborted_precommit' || round.dispatchState === 'prepared')) {
        continue;
      }
      const finalResponse = round ? finalResponseForRound(round) : '';
      if (round && finalResponse && finalResponse.length > (round.responseChars || 0)) {
        Object.assign(round, {
          status: 'done',
          sessionId,
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
            url: sessionId ? targetConversationUrl(sessionId) : context.url,
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
          url: targetConversationUrl(sessionId),
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
    info(`[queue] #${job.seq} ${job.id}: starting new conversation under bootstrap lease${target.alias ? ` alias=${target.alias}` : ''}`);
  } else if (target.action === 'open') {
    info(`[queue] #${job.seq} ${job.id}: targeting conversation ${target.sessionId}${target.alias ? ` alias=${target.alias}` : ''}`);
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
    jobId: job.id,
    newConversation: target.action === 'new',
    expectedSessionId: target.action === 'open' ? target.sessionId : '',
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
  const sessionId = jobArgs.expectedSessionId || sessionIdFromUrl(page.url());
  const conversation = recordResolvedConversation(job, page, response, sessionId);
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
        if (args.skipFailed && blocked.job.status === 'failed') {
          // A failed job should not pin the whole queue forever. When the
          // operator opts in with --skip-failed, auto-skip the blocking failed
          // job (journaled), then loop to the next pending job. The default
          // remains that a failed job blocks until manually reset, so genuine
          // failures are not silently dropped.
          finishScheduledJob(blocked.job.id, {
            status: 'skipped',
            lastError: blocked.job.lastError || '',
            result: { ...(blocked.job.result || {}), skippedAt: nowIso(), skippedReason: 'auto-skipped by --skip-failed (blocking failed job)' },
          }, 'job_skipped_auto');
          info(`[queue] #${blocked.job.seq} ${blocked.job.id}: auto-skipped (failed; --skip-failed)`);
          continue;
        }
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
      const status = queueHoldStatusForError(error);
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

async function waitForAssistantResponse(page, message, baselineLastTurnId, timeout, onUpdate = null, options = {}) {
  const { expectedSessionId = '', acceptedUserTurnRef = null, priorAssistantTurnRef = null } = options;
  const start = Date.now();
  const noTimeout = timeout === 0 || timeout === Infinity;
  let lastText = '';
  let stableSince = 0;
  let sawResponse = false;
  let reloadedForMissingResponse = false;

  while (noTimeout || Date.now() - start < timeout) {
    if (expectedSessionId) {
      await assertThreadIdentity(page, expectedSessionId, 'while awaiting assistant response');
    }

    const turns = await getConversationTurns(page).catch(() => []);
    let text = '';
    let outcome = null;

    if (acceptedUserTurnRef) {
      outcome = responseAfterAcceptedTurnExcludingRevision(turns, acceptedUserTurnRef, priorAssistantTurnRef);
      if (outcome.concurrentUserTurn) {
        throw cbError('CONCURRENT_CONVERSATION_MUTATION', 'Another user turn appeared before the awaited assistant response', {
          expectedSessionId,
          concurrentUserTurn: outcome.concurrentUserTurn,
        });
      }
      text = outcome.text;
    } else {
      text = responseAfterMessage(turns, message, baselineLastTurnId);
    }

    const placeholder = !text || isProgressOnlyText(text);
    const pageState = await getTargetAppState(page).catch(() => null);

    // Passive connection interrupted notice (never click stop, never blind-resend!)
    if (pageState?.connectionInterrupted) {
      info('[state] Current assistant turn reports connection interruption; observing passively.');
    }

    // Structural error / terminal error detection (scoped to the awaited assistant descendant)
    const targetAssistantError = terminalErrorForAwaitedTurn(pageState, outcome, acceptedUserTurnRef);
    if (targetAssistantError) {
      const error = cbError('ASSISTANT_TERMINAL_ERROR', targetAssistantError, {
        expectedSessionId,
        partialText: lastText,
      });
      throw error;
    }
    if (text && isErrorOnlyResponseText(text)) {
      const error = cbError('ASSISTANT_TERMINAL_ERROR', text, {
        expectedSessionId,
        partialText: text,
      });
      throw error;
    }

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
        const finalTurns = await getConversationTurns(page).catch(() => []);
        let finalText = '';
        if (acceptedUserTurnRef) {
          finalText = responseAfterAcceptedTurnExcludingRevision(finalTurns, acceptedUserTurnRef, priorAssistantTurnRef).text;
        } else {
          finalText = responseAfterMessage(finalTurns, message, baselineLastTurnId);
        }
        const finalState = await getTargetAppState(page).catch(() => null);
        const finalGeneration = await getCombinedGenerationState(page, finalState);
        if (!finalGeneration.isGenerating) {
          const finalOutcome = acceptedUserTurnRef ? responseAfterAcceptedTurnExcludingRevision(finalTurns, acceptedUserTurnRef, priorAssistantTurnRef) : null;
          const targetError = terminalErrorForAwaitedTurn(finalState, finalOutcome, acceptedUserTurnRef);
          if (targetError) {
            throw cbError('ASSISTANT_TERMINAL_ERROR', targetError, { expectedSessionId });
          }
          if (finalText && isErrorOnlyResponseText(finalText)) {
            throw cbError('ASSISTANT_TERMINAL_ERROR', finalText, { expectedSessionId });
          }
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

    // Passive exact-thread reconciliation reload
    if (!sawResponse
      && !reloadedForMissingResponse
      && Date.now() - start >= NO_RESPONSE_RELOAD_MS
      && (acceptedUserTurnRef ? !outcome?.userTurnMissing : hasUserTurnAfterBaseline(turns, message, baselineLastTurnId))
      && expectedSessionId
      && pageState
      && !(await getCombinedGenerationState(page, pageState)).isGenerating) {
      reloadedForMissingResponse = true;
      info('[state] No assistant turn visible while UI is idle; reloading target app once for passive reconciliation');
      await openConversationBySessionId(page, expectedSessionId);
      await assertThreadIdentity(page, expectedSessionId, 'after passive response reconciliation');
      await settlePage(page);
    }

    await page.waitForTimeout(sawResponse ? RESPONSE_POLL_MS : 500);
  }

  if (lastText) {
    const finalTurns = await getConversationTurns(page).catch(() => []);
    let finalText = '';
    let finalOutcome = null;
    if (acceptedUserTurnRef) {
      finalOutcome = responseAfterAcceptedTurnExcludingRevision(finalTurns, acceptedUserTurnRef, priorAssistantTurnRef);
      finalText = finalOutcome.text;
    } else {
      finalText = responseAfterMessage(finalTurns, message, baselineLastTurnId);
    }
    const finalState = await getTargetAppState(page).catch(() => null);
    const finalGeneration = await getCombinedGenerationState(page, finalState);
    if (finalText && !finalGeneration.isGenerating) {
      const targetError = terminalErrorForAwaitedTurn(finalState, finalOutcome, acceptedUserTurnRef);
      if (targetError) {
        throw cbError('ASSISTANT_TERMINAL_ERROR', targetError, { expectedSessionId });
      }
      if (isErrorOnlyResponseText(finalText)) {
        throw cbError('ASSISTANT_TERMINAL_ERROR', finalText, { expectedSessionId });
      }
      return finalText;
    }
    throw new Error(`Timed out after ${timeout}ms while target app was still generating. Partial assistant text was not appended; run CB --sync-transcript after the browser finishes.`);
  }

  throw new Error(`Timed out after ${timeout}ms waiting for assistant response`);
}

async function watchTargetAppState(page, args, options = {}) {
  const expectedSessionId = options.expectedSessionId || args.expectedSessionId || '';
  if (expectedSessionId) {
    await assertThreadIdentity(page, expectedSessionId, 'before starting watch-state');
    if (!args.transcriptOverride) args.transcript = transcriptPathForSession(expectedSessionId);
  } else {
    refreshSessionTranscript(page, args);
  }
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
    if (expectedSessionId) {
      await assertThreadIdentity(page, expectedSessionId, 'while watching target state');
      if (!args.transcriptOverride) args.transcript = transcriptPathForSession(expectedSessionId);
    } else {
      refreshSessionTranscript(page, args);
    }
    const state = await getTargetAppState(page);
    event = emitter.emit(state);
  }
}

async function ask(page, message, args) {
  // Preflight disposition check for reserved round before any browser preparation
  if (args.roundId) {
    const existingRound = loadRoundState().rounds.find((r) => r.id === args.roundId);
    if (existingRound) {
      const incomingExpectedSessionId = args.expectedSessionId || args.conversation || '';
      if (incomingExpectedSessionId && existingRound.sessionId && incomingExpectedSessionId !== existingRound.sessionId) {
        throw cbError('ROUND_BINDING_MISMATCH', `Reserved round "${args.roundId}" is bound to session "${existingRound.sessionId}", cannot rebind to "${incomingExpectedSessionId}"`);
      }
      if (message && existingRound.messageHash) {
        const incomingHash = messageHash(canonicalRawPrompt(message));
        if (existingRound.messageHash !== incomingHash) {
          throw cbError('ROUND_PAYLOAD_MISMATCH', `Reserved round "${args.roundId}" message hash mismatch: expected "${existingRound.messageHash}", got "${incomingHash}"`);
        }
      }
      if (args.recoveryIncidentId && existingRound.recoveryIncidentId && args.recoveryIncidentId !== existingRound.recoveryIncidentId) {
        throw cbError('ROUND_BINDING_MISMATCH', `Reserved round "${args.roundId}" recovery incident mismatch: expected "${existingRound.recoveryIncidentId}", got "${args.recoveryIncidentId}"`);
      }
      if (args.operationKind && existingRound.operationKind && args.operationKind !== existingRound.operationKind) {
        throw cbError('ROUND_BINDING_MISMATCH', `Reserved round "${args.roundId}" operationKind mismatch: expected "${existingRound.operationKind}", got "${args.operationKind}"`);
      }
      if (args.recoveryStage && existingRound.recoveryStage && Number(args.recoveryStage) !== Number(existingRound.recoveryStage)) {
        throw cbError('ROUND_BINDING_MISMATCH', `Reserved round "${args.roundId}" recoveryStage mismatch: expected "${existingRound.recoveryStage}", got "${args.recoveryStage}"`);
      }
      if (isPositivelyCompletedRound(existingRound)) {
        info(`[ask] Round "${existingRound.id}" was already completed; returning existing result without browser preparation`);
        const resp = extractRoundResponseFromTranscript(existingRound.transcript, existingRound) || existingRound.responseText || '';
        if (resp) return resp;
        throw cbError('ROUND_RESPONSE_UNAVAILABLE', `Completed round "${existingRound.id}" response could not be attributed from transcript "${existingRound.transcript}"`);
      }
      if (existingRound.dispatchState !== 'prepared') {
        throw cbError('ROUND_ALREADY_DISPATCHED', `Reserved round "${existingRound.id}" is in post-dispatch state "${existingRound.dispatchState}" (status: ${existingRound.status || 'unknown'}) and cannot be re-dispatched`);
      }
    }
  }

  let laneLease = null;
  let bootstrapLease = null;
  let leaseHandle = null;

  const rawUrl = page.url();
  const currentSessionId = sessionIdFromUrl(rawUrl);
  const implicitNewChat = !args.newConversation && !args.expectedSessionId && !currentSessionId && isCanonicalTargetRoot(rawUrl);
  const isNewChat = Boolean(args.newConversation || implicitNewChat);
  let expectedSessionId = args.expectedSessionId || (!isNewChat ? currentSessionId : '');

  if (!isNewChat && !expectedSessionId) {
    throw cbError(
      'NEW_CHAT_MODE_REQUIRED',
      `Current page (${rawUrl}) has no stable conversation identity; use --new-conversation or target an existing thread with --conversation`,
      { url: rawUrl }
    );
  }

  try {
    laneLease = takeBrowserLaneLease(args, args.jobId || randomId('lane-op'));
    if (isNewChat) {
      bootstrapLease = acquireBootstrapLease(args, args.jobId || randomId('bootstrap-op'));
      await openNewConversation(page);
      assertNewChatBootstrapRoute(page);
    } else if (expectedSessionId) {
      if (args.recoveryResend) {
        await prepareRecoveryResendTarget(page, args, expectedSessionId);
      } else if (sessionIdFromUrl(page.url()) !== expectedSessionId) {
        await openConversationBySessionId(page, expectedSessionId);
        await assertThreadIdentity(page, expectedSessionId, 'before conversation preparation');
      } else {
        await assertThreadIdentity(page, expectedSessionId, 'before conversation preparation');
      }
    }

    await reconcileCurrentConversation(page, args, { suppressAlias: isNewChat }).catch(() => {});
    refreshSessionTranscript(page, args);
    if (args.model) {
      info(`[model] selecting ${args.model}`);
      const result = await selectModel(page, args.model);
      if (result) info(`[model] ${formatModelSelectionResult(result)}`);
    }
    if (args.reasoning) {
      info(`[reasoning] selecting ${args.reasoning}`);
      const result = await selectReasoning(page, args.reasoning);
      if (result) info(`[reasoning] ${formatModelSelectionResult(result, 'reasoning')}`);
    }
    if (args.attachments && args.attachments.length) {
      info(`[attach] ${args.attachments.join(', ')}`);
      const state = await attachFiles(page, args.attachments);
      if (state.composer.attachments.length) {
        info(`[attach] composer attachments: ${state.composer.attachments.map((item) => item.text || item.aria || item.testid).join(' | ')}`);
      }
    }

    if (isNewChat) {
      assertNewChatBootstrapRoute(page);
    } else if (expectedSessionId) {
      await assertThreadIdentity(page, expectedSessionId, 'before send transaction');
    }

    const generationBefore = await getCombinedGenerationState(page, await getTargetAppState(page).catch(() => null));
    if (generationBefore.isGenerating) {
      throw cbError(
        'CONVERSATION_BUSY',
        `Refusing to send while ${expectedSessionId || 'conversation'} is generating`
      );
    }

    const baselineState = await getTargetAppState(page).catch(() => null);
    const watchBaseline = baselineState ? stateBaseline(baselineState) : null;
    const turnsBefore = await getConversationTurns(page);
    const baselineLastTurnId = turnsBefore.length ? turnsBefore[turnsBefore.length - 1].testid : '';

    // Pre-Send WAL round registration
    const roundExtra = {
      expectedSessionId,
      jobId: args.jobId || '',
      dispatchState: 'prepared',
      sessionBindingState: isNewChat ? 'unbound' : 'not_applicable',
    };
    if (args.recoveryResend) {
      roundExtra.operationKind = 'recovery_resend';
      roundExtra.recoveryStage = 2;
      roundExtra.recoveryIncidentId = args.recoveryIncidentId || '';
    }
    if (args.roundId) {
      roundExtra.id = args.roundId;
    }
    const round = registerPendingRound(args, page, message, baselineLastTurnId, roundExtra);

    if (isPositivelyCompletedRound(round)) {
      info(`[ask] Round "${round.id}" was already completed; returning existing result without re-dispatching`);
      const resp = extractRoundResponseFromTranscript(round.transcript, round) || round.responseText || '';
      if (resp) return resp;
      throw cbError('ROUND_RESPONSE_UNAVAILABLE', `Completed round "${round.id}" response could not be attributed from transcript "${round.transcript}"`);
    }

    if (round.dispatchState !== 'prepared') {
      throw cbError('ROUND_ALREADY_DISPATCHED', `Reserved round "${round.id}" is in post-dispatch state "${round.dispatchState}" (status: ${round.status || 'unknown'}) and cannot be re-dispatched`);
    }

    if (!isNewChat && expectedSessionId) {
      try {
        leaseHandle = acquireConversationLease(expectedSessionId, round.id);
      } catch (leaseError) {
        updateRound(round.id, {
          status: 'failed',
          dispatchState: 'aborted_precommit',
          lastError: leaseError.message || String(leaseError),
        }, 'round_aborted');
        throw leaseError;
      }
    }

    const acceptedUserTurn = await sendMessage(page, message, baselineLastTurnId, {
      expectedSessionId,
      roundId: round.id,
      requireNewChatRoot: isNewChat,
    });
    const acceptedUserTurnRef = turnRef(acceptedUserTurn);

    if (isNewChat) {
      updateRound(round.id, {
        sessionBindingState: 'unbound',
        acceptedUserTurn: acceptedUserTurnRef,
      }, 'round_new_session_unbound');

      const candidateSessionId = await waitForSessionIdInUrl(page, NEW_SESSION_ACCEPTANCE_TIMEOUT_MS);
      if (!candidateSessionId) {
        updateRound(round.id, {
          sessionBindingState: 'unbound',
          lastError: 'No stable conversation ID appeared after accepted Send',
        }, 'round_session_binding_uncertain');
        throw cbError('NEW_SESSION_ID_UNCERTAIN', 'No stable conversation ID appeared after accepted Send', { roundId: round.id });
      }

      updateRound(round.id, {
        candidateSessionId,
        sessionBindingState: 'candidate',
      }, 'round_session_candidate');

      let attestation = null;
      try {
        attestation = await waitForAcceptedTurnAttestation(page, candidateSessionId, acceptedUserTurnRef);
      } catch (attestationError) {
        const bindingState = attestationError.code === 'NEW_SESSION_ATTRIBUTION_MISMATCH' ? 'mismatch' : 'unverifiable';
        updateRound(round.id, {
          candidateSessionId,
          sessionBindingState: bindingState,
          lastError: attestationError.message || String(attestationError),
        }, 'round_session_attribution_failed');
        throw attestationError;
      }

      expectedSessionId = candidateSessionId;
      args.expectedSessionId = candidateSessionId;
      args.transcript = transcriptPathForSession(candidateSessionId);

      updateRound(round.id, {
        sessionId: candidateSessionId,
        expectedSessionId: candidateSessionId,
        url: targetConversationUrl(candidateSessionId),
        transcript: args.transcript,
        sessionBindingState: 'attested',
        sessionAttestation: {
          method: attestation.method,
          at: nowIso(),
        },
      }, 'round_session_bound');

      // Overlapping lease: acquire stable session lease while bootstrap lease is held
      leaseHandle = acquireConversationLease(candidateSessionId, round.id);
    }

    const authoritativeSessionId = expectedSessionId || round.sessionId;
    if (authoritativeSessionId) {
      await assertThreadIdentity(page, authoritativeSessionId, 'before persisting accepted user turn');
      args.transcript = args.transcriptOverride ? args.transcript : transcriptPathForSession(authoritativeSessionId);
    } else {
      refreshSessionTranscript(page, args);
    }
    if (args.transcript) {
      appendTranscript(args.transcript, 'user', message);
    }
    await indexCurrentConversation(page, args, 'conversation_prompt_accepted', {
      expectedSessionId: authoritativeSessionId,
      preserveTranscript: true,
    }).catch(() => {});

    const streamer = (args.stream || args.stateJsonl) ? createStreamPrinter(args, watchBaseline) : null;
    let response = '';
    try {
      response = await waitForAssistantResponse(
        page,
        message,
        baselineLastTurnId,
        args.timeout,
        streamer ? (event) => streamer.update(event) : null,
        {
          expectedSessionId: authoritativeSessionId,
          acceptedUserTurnRef,
        }
      );
    } catch (error) {
      const observedSessionId = sessionIdFromUrl(page.url());
      const isTerminal = error.code === 'ASSISTANT_TERMINAL_ERROR';
      updateRound(round.id, {
        status: isTerminal ? 'failed' : 'pending',
        assistantOutcome: isTerminal ? 'terminal_error' : 'uncertain',
        lastErrorCode: error.code || '',
        lastError: error.message || String(error),
        observedSessionId,
        observedUrl: page.url(),
      }, isTerminal ? 'round_failed' : 'round_waiting_for_recovery');
      throw error;
    }
    if (streamer) streamer.finish();

    const finalSessionId = expectedSessionId || round.sessionId;
    if (finalSessionId) {
      await assertThreadIdentity(page, finalSessionId, 'before persisting completed response');
    }
    const finalTranscript = args.transcript || (finalSessionId ? transcriptPathForSession(finalSessionId) : '');
    if (finalTranscript) {
      appendTranscript(finalTranscript, 'assistant', response);
    }

    updateRound(round.id, {
      status: 'done',
      assistantOutcome: 'succeeded',
      sessionId: finalSessionId,
      responseChars: response.length,
      responseText: response,
      lastError: '',
      url: finalSessionId ? targetConversationUrl(finalSessionId) : page.url(),
      transcript: finalTranscript,
    }, 'round_completed');
    await indexCurrentConversation(page, args, 'conversation_turn_completed', {
      expectedSessionId: finalSessionId,
      preserveTranscript: true,
    }).catch(() => {});
    if (args.downloadArtifacts) {
      const saved = await downloadLatestArtifacts(page, args);
      info(`[artifacts] saved ${saved.length} item(s): ${saved.map(formatSavedArtifact).join(', ')}`);
      if (args.showArtifacts) printSavedArtifacts(saved);
    }
    return response;
  } finally {
    releaseConversationLease(leaseHandle);
    releaseBootstrapLease(bootstrapLease);
    releaseBrowserLaneLease(laneLease);
  }
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


function extractThreadCompaction(transcriptText, sessionId, title = '') {
  const entries = parseTranscriptEntries(transcriptText);
  if (!entries.length) {
    throw new Error(`No transcript entries found for session ${sessionId}`);
  }

  const userEntries = entries.filter((e) => e.role === 'user');
  const assistantEntries = entries.filter((e) => e.role === 'assistant');

  // Extract GitHub URLs
  const rawUrls = [...new Set([...transcriptText.matchAll(/https?:\/\/[^\s\)\"',]+/g)].map((m) => m[0]))];
  const githubUrls = [...new Set(rawUrls.filter((u) => u.includes('github.com')).map((u) => u.replace(/[\.,:;]+$/, '')))];

  // Extract key source files referenced (.ts, .tsx, .py, .sh, .yaml, .json, .md)
  const fileMatches = [...new Set([...transcriptText.matchAll(/\b(?:[\w\-]+\/)*[\w\-]+\.(?:tsx?|jsx?|py|sh|yaml|json|md)\b/g)].map((m) => m[0]))]
    .filter((f) => !f.startsWith('http') && (f.includes('/') || f.endsWith('.tsx') || f.endsWith('.ts') || f.endsWith('.py') || f.endsWith('.sh')));

  // Extract git SHAs
  const shaMatches = [...new Set([...transcriptText.matchAll(/\b([0-9a-f]{7,40})\b/gi)].map((m) => m[1]))]
    .filter((s) => !/^\d+$/.test(s) && (s.length === 40 || s.length === 10 || s.length === 7));

  // Initial headline and mission statement from earliest substantive user turn
  const initialTurn = userEntries.find((e) => e.text.length > 200) || userEntries[0];
  const initialText = initialTurn ? initialTurn.text : '';
  const initialLines = initialText.split('\n').map((l) => l.trim()).filter(Boolean);
  const headline = initialLines.find((l) => l.startsWith('#')) || title || 'Architecture & Research Review';
  const missionParagraphs = initialText.split('\n\n').map((p) => p.trim()).filter(Boolean);
  const overarchingMission = missionParagraphs.slice(0, 3).join('\n\n') || initialText.slice(0, 800);

  // Latest findings & standing recommendations (last 1-2 assistant turns)
  const latestAssistant = assistantEntries[assistantEntries.length - 1]?.text || '';
  const priorAssistant = assistantEntries.length > 1 ? assistantEntries[assistantEntries.length - 2]?.text : '';

  // Clean trailing banner text if captured
  const cleanLatestAssistant = latestAssistant
    .replace(/You've reached the maximum length for this conversation.*$/is, '')
    .trim();

  return {
    sessionId,
    title: title || headline.replace(/^#+\s*/, ''),
    turnCount: entries.length,
    userTurnCount: userEntries.length,
    assistantTurnCount: assistantEntries.length,
    totalChars: transcriptText.length,
    compactedAt: new Date().toISOString(),
    overarchingMission,
    githubRepositories: githubUrls,
    keyFiles: fileMatches.slice(0, 30),
    verifiedCommits: shaMatches.slice(-15),
    latestRecommendations: cleanLatestAssistant.slice(0, 5000),
    priorSummary: priorAssistant ? priorAssistant.slice(0, 1500) : '',
  };
}

function buildTurn1HandoffPrompt(compaction) {
  const repoList = compaction.githubRepositories.length
    ? compaction.githubRepositories.map((u) => `- ${u}`).join('\n')
    : '- (None recorded; see referenced local paths)';

  const fileList = compaction.keyFiles.length
    ? compaction.keyFiles.join(', ')
    : 'N/A';

  const shaList = compaction.verifiedCommits.length
    ? compaction.verifiedCommits.join(', ')
    : 'N/A';

  return `[CONTEXT CONTINUATION & THREAD COMPACTION HANDOFF]
The previous conversation thread (ID: ${compaction.sessionId}, Title: "${compaction.title}") reached ChatGPT's maximum length limit (${compaction.turnCount} turns, ~${Math.round(compaction.totalChars / 1024)} KB).
This new session is the direct, seamless continuation of our research and architecture review.

### 1. Overarching Mission & Directives
${compaction.overarchingMission}

### 2. Relevant Repositories & External Resources
${repoList}

### 3. Key Code References & Working State
- **Key Source Files**: ${fileList}
- **Verified Git Commits**: ${shaList}

### 4. Standing Architectural Findings & Immediate Focus
${compaction.latestRecommendations}

---
### MANDATORY PROTOCOL FOR RESEARCH AGENT (TURN 1):
You are acting as our research and architecture advisor in this new continuation thread. Because you run in cloud isolation without direct terminal access to our local host:
1. Thoroughly review all the architectural context, verified findings, and standing recommendations detailed above.
2. Access and inspect all referenced external repositories and documentation links (especially ${compaction.githubRepositories[0] || 'the relevant GitHub repositories'}) to build complete situational awareness.
3. DO NOT generate speculative code or begin unguided implementation yet.
4. Formulate and ask targeted, probing clarifying questions regarding the local environment, current codebase state, and the immediate focus of this session.
5. Conclude your Turn 1 response with these questions. The local model/user will inspect the environment and provide concrete answers in Turn 2 before we proceed.`;
}

async function compactActiveConversation(page, args = {}) {
  await settlePage(page);
  const currentUrl = page.url();
  const sessionId = args.expectedSessionId || sessionIdFromUrl(currentUrl) || args.conversation;
  if (!sessionId) {
    throw new Error('Cannot compact conversation: no session ID found in active URL or --conversation');
  }

  if (args.expectedSessionId && !args.transcriptOverride) {
    args.transcript = transcriptPathForSession(args.expectedSessionId);
  } else {
    refreshSessionTranscript(page, args);
  }
  await syncTranscriptFromPage(page, args);

  const transcriptPath = args.transcript || transcriptPathForSession(sessionId);
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`Transcript file not found: ${transcriptPath}`);
  }

  const transcriptText = fs.readFileSync(transcriptPath, 'utf8');
  const title = await page.title().catch(() => '') || 'Conversation Compaction';
  const compaction = extractThreadCompaction(transcriptText, sessionId, title);
  const turn1Prompt = buildTurn1HandoffPrompt(compaction);

  const compactionDir = path.join(OUTPUT_DIR, 'compactions');
  if (!fs.existsSync(compactionDir)) {
    fs.mkdirSync(compactionDir, { recursive: true });
  }

  const jsonPath = path.join(compactionDir, `${sessionId}-compaction.json`);
  const mdPath = path.join(compactionDir, `${sessionId}-compaction.md`);
  const promptPath = path.join(compactionDir, `${sessionId}-turn1-prompt.txt`);

  fs.writeFileSync(jsonPath, JSON.stringify(compaction, null, 2), 'utf8');
  fs.writeFileSync(promptPath, turn1Prompt, 'utf8');

  const mdContent = `# Thread Compaction: ${compaction.title}
Session ID: ${compaction.sessionId}
Turns: ${compaction.turnCount}
Compacted At: ${compaction.compactedAt}

## Mission & Overarching Directives
${compaction.overarchingMission}

## External Repositories & URLs
${compaction.githubRepositories.map((u) => `- <${u}>`).join('\n') || '- None'}

## Key Source Files
${compaction.keyFiles.map((f) => `- \`${f}\``).join('\n') || '- None'}

## Verified Commits
${compaction.verifiedCommits.map((c) => `- \`${c}\``).join('\n') || '- None'}

## Standing Recommendations & Focus
${compaction.latestRecommendations}
`;
  fs.writeFileSync(mdPath, mdContent, 'utf8');

  return {
    compaction,
    jsonPath,
    mdPath,
    promptPath,
    turn1Prompt,
  };
}

async function compactTargetConversation(page, args, operationId = 'compact-op') {
  await prepareConversationForRead(page, args);
  return await withBrowserLaneLease(args, randomId(operationId), async () => {
    if (args.expectedSessionId && sessionIdFromUrl(page.url()) !== args.expectedSessionId) {
      await openConversationBySessionId(page, args.expectedSessionId);
    }
    if (args.expectedSessionId) {
      await assertThreadIdentity(page, args.expectedSessionId, 'before conversation compaction');
    }
    return await compactActiveConversation(page, args);
  });
}

async function executeCompactionHandoff(page, args) {
  if (process.env.CB_ENABLE_LEGACY_COMPACTION !== '1') {
    throw cbError(
      'LEGACY_COMPACTION_HANDOFF_DISABLED',
      'Compaction handoff is excluded from the Hermes recovery protocol. Use the 3-stage recovery hierarchy (Stage 1 edit/regenerate -> Stage 2 same-thread resend -> Stage 3 native branch). Set CB_ENABLE_LEGACY_COMPACTION=1 to override.'
    );
  }
  info('[handoff] Extracting and compacting context from current thread...');
  const result = await compactTargetConversation(page, args, 'handoff-compact');
  info(`[handoff] Compaction artifacts saved to:
  - JSON: ${result.jsonPath}
  - Markdown: ${result.mdPath}
  - Turn 1 Prompt: ${result.promptPath}`);

  args.expectedSessionId = '';
  args.newConversation = true;
  args.conversation = '';
  args.handoffNewSession = true;

  info('[handoff] Submitting Turn 1 compaction seed prompt under bootstrap lease...');
  const response = await ask(page, result.turn1Prompt, args);

  // Reset handoff flags so subsequent interactive messages continue in the newly created thread
  const newSessionId = args.expectedSessionId;
  const newUrl = targetConversationUrl(newSessionId);
  args.newConversation = false;
  args.handoffNewSession = false;
  args.conversation = '';

  console.log('\n================================================================================');
  console.log('[HANDOFF COMPLETE] Context successfully seeded into new thread:');
  console.log(`URL: ${newUrl}`);
  console.log('--------------------------------------------------------------------------------');
  console.log('RESEARCH AGENT RESPONSE & CLARIFYING QUESTIONS (Turn 1):');
  console.log('--------------------------------------------------------------------------------');
  console.log(response);
  console.log('================================================================================');
  console.log('[NEXT STEP]: Inspect the above questions and answer them in Turn 2 using:');
  console.log('  CB --message "<your answers>"\n');

  return {
    oldSessionId: result.compaction.sessionId,
    newSessionId,
    newUrl,
    response,
  };
}

async function recoverInterruptedConnection(page, args = {}) {
  const currentUrl = page.url();
  const sessionId = sessionIdFromUrl(currentUrl);
  if (!sessionId) {
    info('[recovery] No active stable conversation session id in URL; cannot reload specific conversation');
    return { recovered: false, error: 'No active conversation URL' };
  }

  const before = await getTargetAppState(page);
  const generation = await getCombinedGenerationState(page, before);

  if (generation.isGenerating) {
    info(`[recovery] Generation on ${sessionId} is still active; refusing destructive stop.`);
    return {
      recovered: false,
      active: true,
      sessionId,
      url: currentUrl,
      error: 'Generation is still active; refusing destructive recovery',
    };
  }

  info(`[recovery] Reopening and hydrating exact conversation ${sessionId}...`);
  await openConversationBySessionId(page, sessionId);
  await assertThreadIdentity(page, sessionId, 'after interrupted recovery');

  const state = await getTargetAppState(page);
  const composerReady = Boolean(state.composer?.visible && !state.isGenerating);
  info(`[recovery] Rehydration complete. Composer ready: ${composerReady}`);

  return {
    recovered: composerReady,
    sessionId,
    url: page.url(),
    composerReady,
  };
}

async function interactive(page, args) {
  console.log(`Connected to target app: ${page.url()}`);
  refreshSessionTranscript(page, args);
  console.log(`Transcript: ${args.transcript}`);
  console.log('Type /exit to quit. Use /status, /models, /search <query>, /attach <path>, /artifacts, or /stream off. Multiline paste works at CB>.');
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
      const modelConfig = deepStatus
        ? await withBrowserLaneLease(args, randomId('interactive-deep-status'), () => inspectStatusModelConfig(page))
        : null;
      console.log(summarizeState(state, modelConfig));
      continue;
    }
    if (input.type === 'command' && input.text === '/models') {
      const options = await withBrowserLaneLease(args, randomId('interactive-models'), () => listModelOptions(page));
      console.log(options.length ? options.join('\n') : 'No visible model options found.');
      continue;
    }
    if (input.type === 'command' && input.text === '/reasoning') {
      const options = await withBrowserLaneLease(args, randomId('interactive-reasoning'), () => listReasoningOptions(page));
      console.log(options.length ? options.join('\n') : 'No visible reasoning controls found.');
      continue;
    }
    if (input.type === 'command' && input.text.startsWith('/model ')) {
      const label = input.text.slice('/model '.length).trim();
      if (!label) {
        console.log('Usage: /model <visible label>');
        continue;
      }
      const result = await withBrowserLaneLease(args, randomId('interactive-model'), () => selectModel(page, label));
      console.log(formatModelSelectionResult(result));
      continue;
    }
    if (input.type === 'command' && input.text.startsWith('/reasoning ')) {
      const label = input.text.slice('/reasoning '.length).trim();
      if (!label) {
        console.log('Usage: /reasoning <visible label>');
        continue;
      }
      const result = await withBrowserLaneLease(args, randomId('interactive-reasoning'), () => selectReasoning(page, label));
      console.log(formatModelSelectionResult(result, 'reasoning'));
      continue;
    }
    if (input.type === 'command' && input.text.startsWith('/search ')) {
      const query = input.text.slice('/search '.length).trim();
      if (!query) {
        console.log('Usage: /search <query>');
        continue;
      }
      const result = await withBrowserLaneLease(args, randomId('interactive-search'), () => searchTargetApp(page, query));
      printSearchResults(result);
      continue;
    }
    if (input.type === 'command' && input.text === '/search') {
      console.log('Usage: /search <query>');
      continue;
    }
    if (input.type === 'command' && input.text.startsWith('/search-all ')) {
      const query = input.text.slice('/search-all '.length).trim();
      if (!query) {
        console.log('Usage: /search-all <query>');
        continue;
      }
      const result = await withBrowserLaneLease(args, randomId('interactive-search-all'), () => searchTargetApp(page, query, {
        loadAll: true,
        maxScrolls: SEARCH_ALL_MAX_SCROLLS,
      }));
      printSearchResults(result);
      continue;
    }
    if (input.type === 'command' && input.text === '/search-all') {
      console.log('Usage: /search-all <query>');
      continue;
    }
    if (input.type === 'command' && input.text.startsWith('/search-open ')) {
      const raw = input.text.slice('/search-open '.length).trim();
      const [queryPart, openPart] = raw.split(/\s+\|\s+/, 2);
      const query = (queryPart || '').trim();
      const open = (openPart || '1').trim();
      if (!query) {
        console.log('Usage: /search-open <query>[ | index-or-title]');
        continue;
      }
      const result = await withBrowserLaneLease(args, randomId('interactive-search-open'), async () => {
        const res = await searchTargetApp(page, query, { open });
        if (res.opened) {
          refreshSessionTranscript(page, args);
          await indexCurrentConversation(page, args, 'conversation_search_opened', {
            searchQuery: query,
            openedTitle: res.opened.title || '',
          }).catch(() => {});
        }
        return res;
      });
      printSearchResults(result);
      continue;
    }
    if (input.type === 'command' && input.text === '/search-open') {
      console.log('Usage: /search-open <query>[ | index-or-title]');
      continue;
    }
    if (input.type === 'command' && input.text === '/dismiss-blocker') {
      const result = await withBrowserLaneLease(args, randomId('interactive-dismiss'), () => dismissBlockingModal(page));
      printBlockingDismissal(result);
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
      const saved = await withBrowserLaneLease(args, randomId('interactive-download'), async () => {
        refreshSessionTranscript(page, args);
        return await downloadLatestArtifacts(page, args);
      });
      console.log(saved.map(formatSavedArtifact).join('\n'));
      printSavedArtifacts(saved);
      continue;
    }
    if (input.type === 'command' && input.text === '/stop') {
      const stopped = await withBrowserLaneLease(args, randomId('interactive-stop'), () => stopGeneration(page));
      console.log(stopped ? `Clicked generation control: ${stopped}` : 'No visible generation control found.');
      continue;
    }
    if (input.type === 'command' && input.text === '/compact') {
      const result = await compactTargetConversation(page, args, 'interactive-compact');
      console.log(`Compacted session ${result.compaction.sessionId} (${result.compaction.turnCount} turns):`);
      console.log(`Markdown: ${result.mdPath}`);
      console.log(`Prompt: ${result.promptPath}`);
      continue;
    }
    if (input.type === 'command' && (input.text === '/handoff' || input.text === '/compact-handoff')) {
      await executeCompactionHandoff(page, args);
      continue;
    }
    if (input.type === 'command' && input.text === '/recover-interrupted') {
      const recovery = await withBrowserLaneLease(args, randomId('interactive-recover'), () => recoverInterruptedConnection(page, args));
      console.log(recovery.recovered ? `Recovery successful on ${recovery.url}. Composer is ready.` : `Recovery failed.`);
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

  validateAutoRecoverMode(args);
  validateRecoverBranchMode(args);
  reconcileIncompleteBranches();

  if (args.recoverBranchId) {
    const state = loadLineageState();
    let branch = state.branches.find(b => b.id === args.recoverBranchId || b.recoveryIncidentId === args.recoverBranchId);
    if (!branch) {
      throw cbError('BRANCH_NOT_FOUND', `Branch operation "${args.recoverBranchId}" not found in lineage ledger`);
    }

    const candidateSessionId = branch.candidateChildSessionId || (branch.dispatchState === 'stable_candidate' ? branch.childSessionId : '');
    const canRecoverReadOnly = Boolean(
      candidateSessionId &&
      STABLE_SESSION_ID_RE.test(candidateSessionId) &&
      (branch.dispatchState === 'stable_candidate' || branch.dispatchState === 'destination_unverified') &&
      args.cdp
    );

    if (canRecoverReadOnly) {
      const browser = await chromium.connectOverCDP(args.cdp, { timeout: CDP_CONNECT_TIMEOUT_MS });
      try {
        const page = await findTargetAppPage(browser, args);
        branch = await recoverCandidateBranchLineage(page, args, branch);
      } finally {
        await browser.close().catch(() => {});
      }
    }

    console.log(JSON.stringify(branch, null, 2));
    return;
  }

  validateStage1Mode(args);
  validateStage3Mode(args);
  validateRecoveryMode(args);

  if (args.queueStatus) {
    printQueueStatus(args);
    return;
  }

  if (args.schedule && !scheduleNeedsCurrentPage(args)) {
    const job = enqueueScheduledJob(args);
    printScheduledJob(job, args.stateJsonl);
    return;
  }

  if (args.conversation && !isCurrentConversationRef(args.conversation)) {
    const index = loadConversationIndex();
    const parsed = parseConversationRef(args.conversation, index);
    if (parsed.sessionId) {
      args.expectedSessionId = parsed.sessionId;
    }
  }

  const browser = await chromium.connectOverCDP(args.cdp, { timeout: CDP_CONNECT_TIMEOUT_MS });
  try {
    const page = await findTargetAppPage(browser, args);
    const passiveCurrentPageRead = isPassiveCurrentPageRead(args);
    refreshSessionTranscript(page, args);

    if (args.schedule) {
      const job = enqueueScheduledJob(args, page);
      printScheduledJob(job, args.stateJsonl);
      return;
    }

    if (args.runQueue) {
      const recovery = await withBrowserLaneLease(args, randomId('run-queue-recovery'), () => recoverScheduledQueue(page, args));
      if (recovery.blocked) {
        printQueueRecovery(recovery, args.stateJsonl);
        return;
      }
      await runScheduledQueue(page, args);
      return;
    }

    if (args.recoverQueue) {
      await prepareConversationForRead(page, args);
      const action = async () => {
        if (args.expectedSessionId && sessionIdFromUrl(page.url()) !== args.expectedSessionId) {
          await openConversationBySessionId(page, args.expectedSessionId);
        }
        if (args.expectedSessionId) {
          await assertThreadIdentity(page, args.expectedSessionId, 'before queue recovery');
        }
        return await recoverScheduledQueue(page, args);
      };
      const recovery = await withBrowserLaneLease(args, randomId('recover-queue-op'), action);
      printQueueRecovery(recovery, args.stateJsonl);
      return;
    }

    if (args.syncTranscript) {
      await prepareConversationForRead(page, args);
      const action = async () => {
        if (args.expectedSessionId && sessionIdFromUrl(page.url()) !== args.expectedSessionId) {
          await openConversationBySessionId(page, args.expectedSessionId);
        }
        if (args.expectedSessionId) {
          await assertThreadIdentity(page, args.expectedSessionId, 'before transcript synchronization');
        }
        const state = await getTargetAppState(page).catch(() => null);
        const generation = await getCombinedGenerationState(page, state);
        const result = await syncTranscriptFromPage(page, args, { state, generation });
        const activeSessionId = sessionIdFromUrl(page.url());
        const recoveredRounds = reconcilePendingRoundsFromTranscript(args, {
          skipSessionIds: generation.isGenerating && activeSessionId ? [activeSessionId] : [],
        });
        await indexCurrentConversation(page, args, 'conversation_sync', {
          expectedSessionId: args.expectedSessionId || activeSessionId,
          preserveTranscript: Boolean(args.expectedSessionId),
          recoveredRoundCount: recoveredRounds.length,
          syncedTurnCount: result.appended.length,
        }).catch((error) => {
          info(`[index] ${error.message || error}`);
        });
        const text = args.latestAssistant ? await latestAssistantText(page) : '';
        return { result, recoveredRounds, activeSessionId, generation, text };
      };
      const { result, recoveredRounds, activeSessionId, generation, text } = await withBrowserLaneLease(args, randomId('sync-op'), action);

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
      const action = async () => {
        if (args.expectedSessionId && sessionIdFromUrl(page.url()) !== args.expectedSessionId) {
          await openConversationBySessionId(page, args.expectedSessionId);
        }
        if (args.expectedSessionId) {
          await assertThreadIdentity(page, args.expectedSessionId, 'before latest assistant read');
        }
        return await latestAssistantText(page);
      };
      const text = args.expectedSessionId
        ? await withBrowserLaneLease(args, randomId('latest-op'), action)
        : await action();
      if (!text) throw new Error('No completed assistant response found in the live target app DOM');
      console.log(text);
      return;
    }

    if (args.retryEdit) {
      await retryEditTurn(page, args);
      return;
    }

    if (args.autoRecover) {
      const result = await autoRecoverConversationTurn(page, args);
      console.log(`[auto-recover] State: ${result.state} (session: ${result.sessionId || result.childSessionId || ''})`);
      return;
    }

    if (args.branchTurn) {
      if (args.branchCarryForward) {
        const result = await branchWithContextCarryForward(page, args);
        console.log(`[stage3-carry] Branched and replayed context to child session ${result.childSessionId} (${result.childUrl})`);
        return;
      }
      const result = await branchConversationTurn(page, args);
      console.log(`[stage3] Branched to ${result.childSessionId} (${result.childUrl})`);
      return;
    }

    if (args.status) {
      await prepareConversationForRead(page, args);
      const action = async () => {
        if (args.expectedSessionId && sessionIdFromUrl(page.url()) !== args.expectedSessionId) {
          await openConversationBySessionId(page, args.expectedSessionId);
        }
        if (args.expectedSessionId) {
          await assertThreadIdentity(page, args.expectedSessionId, 'before reading status');
        }
        const state = await getTargetAppState(page);
        state.branchInfo = await getBranchInfo(page).catch(() => null);
        const modelConfig = args.deepStatus ? await inspectStatusModelConfig(page) : null;
        if (modelConfig) state.modelConfig = compactModelConfig(modelConfig);
        return { state, modelConfig };
      };
      const { state, modelConfig } = (args.expectedSessionId || args.deepStatus)
        ? await withBrowserLaneLease(args, randomId('status-op'), action)
        : await action();
      if (args.stateJsonl) {
        console.log(JSON.stringify(buildStateEvent(state, null, args.transcript || '')));
      } else {
        console.log(summarizeState(state, modelConfig));
      }
      return;
    }

    if (args.watchState) {
      await prepareConversationForRead(page, args);
      if (args.expectedSessionId) {
        const action = async () => {
          if (sessionIdFromUrl(page.url()) !== args.expectedSessionId) {
            await openConversationBySessionId(page, args.expectedSessionId);
          }
          await assertThreadIdentity(page, args.expectedSessionId, 'before watch-state');
          if (!args.transcriptOverride) args.transcript = transcriptPathForSession(args.expectedSessionId);
          await watchTargetAppState(page, args, { expectedSessionId: args.expectedSessionId });
        };
        await withBrowserLaneLease(args, randomId('watch-state-op'), action);
      } else {
        await watchTargetAppState(page, args);
      }
      return;
    }

    if (args.dismissBlocker) {
      const result = await withBrowserLaneLease(args, randomId('dismiss-op'), () => dismissBlockingModal(page));
      printBlockingDismissal(result, args.stateJsonl);
      return;
    }

    if (args.searchQuery) {
      const searchOpts = searchOptionsFromArgs(args);
      const action = async () => {
        const result = await searchTargetApp(page, args.searchQuery, searchOpts);
        if (result.opened) {
          refreshSessionTranscript(page, args);
          await indexCurrentConversation(page, args, 'conversation_search_opened', {
            searchQuery: args.searchQuery,
            openedTitle: result.opened.title || '',
          }).catch(() => {});
        }
        return result;
      };
      const result = await withBrowserLaneLease(args, randomId('search-op'), action);
      printSearchResults(result, args.stateJsonl);
      return;
    }

    if (args.compactConversation) {
      const result = await compactTargetConversation(page, args, 'compact-op');
      console.log(`Compacted session ${result.compaction.sessionId} (${result.compaction.turnCount} turns):`);
      console.log(`JSON: ${result.jsonPath}`);
      console.log(`Markdown: ${result.mdPath}`);
      console.log(`Turn 1 Prompt: ${result.promptPath}`);
      return;
    }

    if (args.handoffNewSession) {
      await executeCompactionHandoff(page, args);
      return;
    }

    if (args.recoverInterrupted) {
      const recovery = await withBrowserLaneLease(args, randomId('recover-op'), () => recoverInterruptedConnection(page, args));
      console.log(recovery.recovered ? `Recovery successful on ${recovery.url}. Composer is ready.` : `Recovery failed: ${recovery.error || 'Composer not ready'}`);
      return;
    }

    if (args.models) {
      const options = await withBrowserLaneLease(args, randomId('models-op'), () => listModelOptions(page));
      console.log(options.length ? options.join('\n') : 'No visible model options found.');
      return;
    }

    if (args.stop) {
      const stopped = await withBrowserLaneLease(args, randomId('stop-op'), () => stopGeneration(page));
      console.log(stopped ? `Clicked generation control: ${stopped}` : 'No visible generation control found.');
      return;
    }

    if (args.downloadArtifacts && typeof args.message !== 'string') {
      const saved = await withBrowserLaneLease(args, randomId('download-op'), async () => {
        refreshSessionTranscript(page, args);
        return await downloadLatestArtifacts(page, args);
      });
      console.log(saved.map(formatSavedArtifact).join('\n'));
      if (args.showArtifacts) printSavedArtifacts(saved);
      return;
    }

    if (typeof args.message === 'string') {
      const message = args.message.trim();
      if (!message) throw new Error('No message provided');
      await prepareConversationForPrompt(page, args);
      const response = await ask(page, message, args);
      recordPromptConversation(args, page, response, args.expectedSessionId);
      if (!args.stream) console.log(response);
      console.error(`Saved transcript: ${args.transcript}`);
      return;
    }

    await interactive(page, args);
  } finally {
    if (args._laneLease) {
      releaseBrowserLaneLease(args._laneLease);
      args._laneLease = null;
    }
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
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
  validateStage3Mode,
  validateRecoverBranchMode,
  resolveBranchableTurn,
  openBranchMenu,
  validateAutoRecoverMode,
  loadRecoveryIncidentsState,
  saveRecoveryIncidentsState,
  registerRecoveryIncident,
  updateRecoveryIncident,
  acquireRecoveryIncidentLease,
  releaseRecoveryIncidentLease,
  captureUserTurnVersionBaseline,
  attestEditedUserTurnVersion,
  resolveNumericVersionIndex,
  reconcileStage1EditTurn,
  stage1CommitIsAttested,
  loadRoundState,
  saveRoundState,
  autoRecoverConversationTurn,
  branchConversationTurn,
  recoverCandidateBranchLineage,
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
  canonicalRawPrompt,
  findTargetAppPage,
  compactActiveConversation,
  compactTargetConversation,
  syncTranscriptFromPage,
  prepareConversationForRead,
  roundAllowsTranscriptRecovery,
  assertThreadIdentity,
  isCanonicalTargetRoot,
  prepareConversationForPrompt,
  ask,
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
  takeBrowserLaneLease,
  releaseBrowserLaneLease,
  withBrowserLaneLease,
  bootstrapLeaseKey,
  bootstrapLeasePath,
  acquireBootstrapLease,
  releaseBootstrapLease,
  assertNewChatBootstrapRoute,
  attestUserTurn,
  waitForAcceptedTurnAttestation,
  waitForSessionIdInUrl,
  terminalErrorForAwaitedTurn,
  messageHash,
  acquireConversationLease,
  releaseConversationLease,
  reconcilePendingRoundsFromTranscript,
  STABLE_SESSION_ID_RE,
  ROUTE_SESSION_ID_RE,
  routeSessionIdFromUrl,
  sessionIdFromUrl,
  extractConversationId,
  isEphemeralRouteId,
  assertThreadIdentity,
  turnRef,
  turnMatchesRef,
  responseAfterAcceptedTurn,
  responseAfterRound,
  isErrorOnlyResponseText,
  isProgressOnlyText,
  queueHoldStatusForError,
  findRoundForJob,
  getConversationTurns,
  resolveBranchableTurn,
  openBranchMenu,
  isPositivelyBoundBranch,
  isPositivelyCompletedRound,
  extractRoundResponseFromTranscript,
  waitForSendReady,
  getSendButtonState,
  findComposerRootLocator,
  composerDraftMatchesMessage,
  formatCarryForwardPrompt,
  extractLastTurnFromTranscript,
  branchWithContextCarryForward,
  canonicalCarryForwardPayloadHash,
  getOrCreateCarryForwardIncident,
  updateRecoveryIncident,
  formatTranscriptEntry,
  parseTranscriptEntries,
  cbError,
};
