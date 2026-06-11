#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function loadPlaywright() {
  const override = process.env.CHATBOT_PLAYWRIGHT_CORE_PATH;
  if (override) return require(override);
  return require('playwright-core');
}

const { chromium } = loadPlaywright();
const APP_DIR = process.env.CHATBOT_CLI_HOME || __dirname;
const OUTPUT_DIR = process.env.CHATBOT_TRANSCRIPT_DIR || path.join(APP_DIR, 'outputs');
const DEFAULT_CDP = process.env.CHATBOT_CDP_URL || 'http://127.0.0.1:9222';
const SESSION_ID_RE = /^[a-f0-9-]{20,}$/i;
const PASTE_SETTLE_MS = 1000;
const RESPONSE_POLL_MS = 3000;
const RESPONSE_STABLE_FALLBACK_MS = 30000;
const BRACKETED_PASTE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_OFF = '\x1b[?2004l';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

function usage() {
  console.log(`Usage:
  CB
  CB --message "your prompt"
  echo "your prompt" | CB --message -

Options:
  --message, -m   Send one message, print the response, append transcript, then exit.
                 Use "-" to read the message from stdin.
  --timeout       Response timeout in ms. Default: 180000
  --cdp           Chromium DevTools URL. Default: ${DEFAULT_CDP}
  --transcript    Transcript path override. Default: outputs/<session-id>.txt
  --help, -h      Show this help.

Interactive commands:
  /exit           Quit.
  /quit           Quit.
  /transcript     Print the transcript path.
  /multi          Optional manual multiline mode; paste at CB> works by default.
`);
}

function parseArgs(argv) {
  const args = {
    message: null,
    timeout: 180000,
    cdp: DEFAULT_CDP,
    transcript: null,
    transcriptOverride: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };

    if (arg === '--message' || arg === '-m') args.message = next();
    else if (arg === '--timeout') args.timeout = Number(next());
    else if (arg === '--cdp') args.cdp = next();
    else if (arg === '--transcript') {
      args.transcript = next();
      args.transcriptOverride = true;
    }
    else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
    throw new Error('--timeout must be a positive number');
  }

  if (args.transcript) args.transcript = path.resolve(args.transcript);
  return args;
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

async function findTargetAppPage(browser) {
  for (const context of browser.contexts()) {
    const page = context.pages().find((candidate) => candidate.url().startsWith('https://configured-target.invalid/'));
    if (page) return page;
  }

  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://configured-target.invalid/', { waitUntil: 'domcontentloaded' });
  return page;
}

async function getConversationTurns(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('[data-testid^="conversation-turn-"]')]
      .map((turn, index) => {
        const roleEl = turn.matches('[data-message-author-role]')
          ? turn
          : turn.querySelector('[data-message-author-role]');
        return {
          index,
          testid: turn.getAttribute('data-testid') || '',
          role: roleEl ? roleEl.getAttribute('data-message-author-role') : '',
          text: roleEl ? roleEl.innerText.trim() : turn.innerText.trim(),
        };
      })
      .filter((turn) => turn.role && turn.text);
  });
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

async function sendMessage(page, message) {
  const composer = await findComposer(page);
  await composer.click({ timeout: 10000 });
  await page.keyboard.insertText(message);
  await page.keyboard.press('Enter');
}

function responseAfterMessage(turns, message, baselineLastTurnId) {
  let userIndex = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role === 'user' && turn.text.trim() === message.trim()) {
      userIndex = i;
      break;
    }
  }

  if (userIndex === -1 && baselineLastTurnId) {
    const baselineIndex = turns.findIndex((turn) => turn.testid === baselineLastTurnId);
    if (baselineIndex !== -1) userIndex = baselineIndex;
  }

  if (userIndex === -1) return '';

  const assistant = turns.slice(userIndex + 1).find((turn) => turn.role === 'assistant' && turn.text);
  return assistant ? assistant.text : '';
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
        && !/\bshare\b|\bcopy\b|\bclose\b/.test(text);
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

async function waitForAssistantResponse(page, message, baselineLastTurnId, timeout) {
  const start = Date.now();
  let lastText = '';
  let stableSince = 0;
  let sawResponse = false;

  while (Date.now() - start < timeout) {
    const turns = await getConversationTurns(page);
    const text = responseAfterMessage(turns, message, baselineLastTurnId);
    const lower = text.toLowerCase();
    const placeholder = !text || lower === 'targetapp' || lower === 'thinking';

    if (!placeholder) {
      sawResponse = true;
      if (text !== lastText) {
        lastText = text;
        stableSince = Date.now();
      }

      const state = await getGenerationState(page);
      if (!state.isGenerating) {
        await page.waitForTimeout(500);
        const finalText = responseAfterMessage(await getConversationTurns(page), message, baselineLastTurnId);
        return finalText || lastText;
      }

      if (Date.now() - stableSince >= RESPONSE_STABLE_FALLBACK_MS) {
        return text;
      }
    }

    await page.waitForTimeout(sawResponse ? RESPONSE_POLL_MS : 500);
  }

  if (lastText) return lastText;
  throw new Error(`Timed out after ${timeout}ms waiting for assistant response`);
}

async function ask(page, message, args) {
  refreshSessionTranscript(page, args);
  const turnsBefore = await getConversationTurns(page);
  const baselineLastTurnId = turnsBefore.length ? turnsBefore[turnsBefore.length - 1].testid : '';
  await sendMessage(page, message);
  await page.waitForFunction(() => /\/c\/[^/]+/.test(location.pathname), null, { timeout: 10000 }).catch(() => {});
  refreshSessionTranscript(page, args);
  appendTranscript(args.transcript, 'user', message);
  const response = await waitForAssistantResponse(page, message, baselineLastTurnId, args.timeout);
  refreshSessionTranscript(page, args);
  appendTranscript(args.transcript, 'assistant', response);
  return response;
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

      if (lines.length === 0 && ['/exit', '/quit', '/transcript', '/multi'].includes(trimmed)) {
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

          if (['/exit', '/quit', '/transcript', '/multi'].includes(trimmed)) {
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
  console.log('Type /exit to quit. You can paste multiline text directly at CB>.');

  while (true) {
    const input = await readPromptInput('CB> ');

    if (input.type === 'command' && (input.text === '/exit' || input.text === '/quit')) break;
    if (input.type === 'command' && input.text === '/transcript') {
      console.log(args.transcript);
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
    try {
      console.log('Waiting for response...');
      restoreInput = discardInputDuringWait();
      const response = await ask(page, message, args);
      console.log(`\n${response}\n`);
    } catch (error) {
      console.error(`Error: ${error.message || error}`);
    } finally {
      restoreInput();
      drainReadable(process.stdin);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.message === '-') {
    args.message = await readAllStdin();
  }

  const browser = await chromium.connectOverCDP(args.cdp);
  try {
    const page = await findTargetAppPage(browser);
    await page.bringToFront();
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    refreshSessionTranscript(page, args);

    if (typeof args.message === 'string') {
      const message = args.message.trim();
      if (!message) throw new Error('No message provided');
      const response = await ask(page, message, args);
      console.log(response);
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
