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
const ARTIFACT_ROOT = path.join(OUTPUT_DIR, 'artifacts');
const BRACKETED_PASTE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_OFF = '\x1b[?2004l';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const COMMAND_PREFIXES = [
  '/attach ',
  '/model ',
  '/reasoning ',
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
  --attach        File path to attach before sending. Repeat for multiple files.
  --model         Select a model by visible label before sending.
  --reasoning     Select a reasoning mode by visible label before sending.
  --status        Print current target app page state and exit.
  --models        Print visible model picker options and exit.
  --stop          Click the visible stop/interrupt control, if target app is generating.
  --download-artifacts
                  Save artifacts from the latest assistant turn, or after the reply.
  --no-stream     Wait silently and print the final response at the end.
  --help, -h      Show this help.

Interactive commands:
  /exit           Quit.
  /quit           Quit.
  /transcript     Print the transcript path.
  /multi          Optional manual multiline mode; paste at CB> works by default.
  /status         Print model, composer, generation, and artifact state.
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
    timeout: 180000,
    cdp: DEFAULT_CDP,
    transcript: null,
    transcriptOverride: false,
    attachments: [],
    model: '',
    reasoning: '',
    status: false,
    models: false,
    stop: false,
    downloadArtifacts: false,
    stream: true,
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
    else if (arg === '--attach') args.attachments.push(next());
    else if (arg === '--model') args.model = next();
    else if (arg === '--reasoning') args.reasoning = next();
    else if (arg === '--status') args.status = true;
    else if (arg === '--models') args.models = true;
    else if (arg === '--stop') args.stop = true;
    else if (arg === '--download-artifacts') args.downloadArtifacts = true;
    else if (arg === '--no-stream') args.stream = false;
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
  args.attachments = args.attachments.map((filePath) => path.resolve(filePath));
  return args;
}

function isInteractiveCommand(text) {
  if (COMMANDS.has(text)) return true;
  return COMMAND_PREFIXES.some((prefix) => text.startsWith(prefix));
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

async function sendMessage(page, message) {
  const composer = await findComposer(page);
  await composer.click({ timeout: 10000 });
  await page.keyboard.insertText(message);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);

  const state = await getTargetAppState(page).catch(() => null);
  if (!state?.composer?.textChars) return;

  const sendButton = await getSendButtonState(page);
  if (!sendButton.exists) return;
  if (sendButton.disabled) {
    throw new Error('Prompt was not submitted because the send button is disabled. The attachment may still be uploading, or this browser profile may not have file-upload access.');
  }

  await page.locator('#composer-submit-button, [data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]')
    .first()
    .click({ timeout: 5000 });
  await page.waitForTimeout(700);
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

async function getTargetAppState(page) {
  return page.evaluate(() => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || el?.value || '').replace(/\s+/g, ' ').trim();
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
        && !/\b(share|copy|close|cancel dictation)\b/i.test(item.text));

    const turns = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')]
      .map((turn, index) => {
        const roleEl = turn.matches('[data-message-author-role]')
          ? turn
          : turn.querySelector('[data-message-author-role]');
        return {
          index,
          testid: turn.getAttribute('data-testid') || '',
          role: roleEl ? roleEl.getAttribute('data-message-author-role') : '',
          text: roleEl ? textOf(roleEl) : textOf(turn),
        };
      })
      .filter((turn) => turn.role || turn.text);

    const latestAssistantTurn = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')]
      .reverse()
      .find((turn) => {
        const roleEl = turn.matches('[data-message-author-role]')
          ? turn
          : turn.querySelector('[data-message-author-role]');
        return roleEl && roleEl.getAttribute('data-message-author-role') === 'assistant';
      });

    const scoped = latestAssistantTurn;
    const latestAssistantText = latestAssistantTurn ? textOf(latestAssistantTurn) : '';
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
          if (/\b(add files|start dictation|start voice|chat with targetapp)\b/i.test(joined)) return false;
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
      .filter((text) => /\b(thinking|thought|reasoning|searching|searched|browsing|reading|analyzing|working|creating|generating|running|tool|uploading|attached)\b/i.test(text))
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
      reasoningControls,
      isGenerating: generationControls.length > 0,
      generationControls,
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
  });
}

function summarizeState(state) {
  const lines = [];
  lines.push(`URL: ${state.url}`);
  lines.push(`Model: ${state.model || 'unknown'}`);
  lines.push(`Generating: ${state.isGenerating ? 'yes' : 'no'}`);
  if (state.generationControls.length) {
    lines.push(`Generation controls: ${state.generationControls.map((item) => item.text).join(' | ')}`);
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
        return roleEl && roleEl.getAttribute('data-message-author-role') === 'assistant';
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
    const images = [...root.querySelectorAll('img[src]')]
      .filter(isVisible)
      .filter((img) => (img.naturalWidth || img.width || 0) >= 64 || (img.naturalHeight || img.height || 0) >= 64)
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

    const codeTexts = [...root.querySelectorAll('pre')]
      .filter(isVisible)
      .map((el) => {
        const code = el.querySelector('code');
        return code ? (code.innerText || code.textContent || '') : (el.innerText || el.textContent || '');
      })
      .map((text) => text.trim())
      .filter(Boolean);
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

    dedupedCodeTexts
      .slice(0, 20)
      .forEach((text, index) => {
        files.push({
          type: 'code',
          index: index + 1,
          suggestedName: `code-block-${index + 1}.txt`,
          text: text.slice(0, 1000000),
          truncated: text.length > 1000000,
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
          && !/\b(share|copy|close|cancel dictation)\b/i.test(text);
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

async function openModelSwitcher(page) {
  const label = await markModelSwitcher(page);
  if (!label) return '';
  await page.locator('[data-cb-model-switcher="true"]').click({ timeout: 5000 });
  await page.waitForTimeout(700);
  return label;
}

async function listModelOptions(page) {
  if (!await openModelSwitcher(page)) return [];
  const options = await page.evaluate(() => {
    const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const menuRoots = [...document.querySelectorAll([
      '[role="menu"]',
      '[role="listbox"]',
      '[data-radix-popper-content-wrapper]',
      '[data-headlessui-portal]',
      '[data-testid*="model"]',
    ].join(','))]
      .filter(isVisible)
      .filter((el) => !el.matches('[data-testid="model-switcher-dropdown-button"]'));

    if (!menuRoots.length) return [];

    const rawOptionTexts = menuRoots.flatMap((root) => {
      const rootParts = textOf(root).split(/[\n•]/).map((text) => text.trim());
      const childParts = [...root.querySelectorAll('[role="menuitem"], [role="option"], button, a, [role="button"], div')]
      .filter(isVisible)
        .map((el) => textOf(el));
      return [...rootParts, ...childParts];
    });

    const optionTexts = [];
    for (const rawText of rawOptionTexts) {
      const expanded = rawText
        .replace(/\s+•\s+/g, '\n')
        .replace(/\b(Extended)\s+(Configure\.\.\.)$/i, '$1\n$2')
        .split('\n')
        .map((text) => text.trim())
        .filter(Boolean);
      optionTexts.push(...expanded);
    }

    return optionTexts
      .filter((text) => text && text.length <= 160)
      .filter((text) => !/^target app$/i.test(text))
      .filter((text) => !/\b(log in|sign up|pricing|plans)\b/i.test(text))
      .filter((text) => !/•/.test(text))
      .filter((text) => !/^(instant|thinking|pro)$/i.test(text))
      .filter((text) => !/^\d+(\.\d+)?$/.test(text))
      .filter((text, index, arr) => arr.indexOf(text) === index)
      .slice(0, 80);
  });
  await page.keyboard.press('Escape').catch(() => {});
  return options;
}

async function listReasoningOptions(page) {
  const state = await getTargetAppState(page);
  return state.reasoningControls
    .map((item) => item.text || item.aria || item.title || item.testid)
    .filter(Boolean);
}

async function clickOptionByText(page, text) {
  const option = page.getByText(text, { exact: false }).first();
  await option.click({ timeout: 5000 });
  await page.waitForTimeout(500);
}

async function selectModel(page, label) {
  if (!await openModelSwitcher(page)) throw new Error('No visible model picker found');
  await clickOptionByText(page, label);
}

async function selectReasoning(page, label) {
  const state = await getTargetAppState(page);
  const control = state.reasoningControls.find((item) => /reasoning|think|extended|fast|auto/i.test([item.text, item.aria, item.title, item.testid].join(' ')));
  if (!control) throw new Error('No visible reasoning control found');
  await page.getByText(control.text || control.aria || control.title || control.testid, { exact: false }).first().click({ timeout: 5000 });
  await page.waitForTimeout(500);
  await clickOptionByText(page, label);
}

async function attachFiles(page, filePaths) {
  const resolved = filePaths.map((filePath) => path.resolve(filePath));
  for (const filePath of resolved) {
    if (!fs.existsSync(filePath)) throw new Error(`Attachment does not exist: ${filePath}`);
  }

  const setFiles = async () => {
    const inputs = page.locator('input[type="file"]');
    const count = await inputs.count().catch(() => 0);
    if (!count) return false;
    await inputs.last().setInputFiles(resolved, { timeout: 10000 });
    return true;
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

function createStreamPrinter() {
  let lastText = '';
  let lastStateKey = '';

  return {
    update(event) {
      const state = event.state;
      if (state) {
        const activity = state.activityTexts.slice(-3).join(' | ');
        const control = state.generationControls.map((item) => item.text).join(' | ');
        const key = [
          state.isGenerating ? 'generating' : 'idle',
          control,
          activity,
          state.artifacts.links.length,
          state.artifacts.images.length,
          state.artifacts.downloadControls.length,
        ].join('::');
        if (key !== lastStateKey) {
          lastStateKey = key;
          const parts = [];
          parts.push(state.isGenerating ? 'generating' : 'idle');
          if (control) parts.push(control);
          if (activity) parts.push(activity);
          if (state.artifacts.links.length || state.artifacts.images.length || state.artifacts.downloadControls.length) {
            parts.push(`artifacts links=${state.artifacts.links.length} images=${state.artifacts.images.length} downloads=${state.artifacts.downloadControls.length}`);
          }
          info(`[state] ${parts.join(' | ')}`);
        }
      }

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
      if (lastText && !lastText.endsWith('\n')) process.stdout.write('\n');
    },
  };
}

async function waitForAssistantResponse(page, message, baselineLastTurnId, timeout, onUpdate = null) {
  const start = Date.now();
  let lastText = '';
  let stableSince = 0;
  let sawResponse = false;

  while (Date.now() - start < timeout) {
    const turns = await getConversationTurns(page);
    const text = responseAfterMessage(turns, message, baselineLastTurnId);
    const lower = text.toLowerCase();
    const placeholder = !text || lower === 'targetapp' || lower === 'thinking';
    const pageState = await getTargetAppState(page).catch(() => null);

    if (!placeholder) {
      sawResponse = true;
      if (text !== lastText) {
        lastText = text;
        stableSince = Date.now();
      }

      if (onUpdate) onUpdate({ text, state: pageState });

      const state = pageState
        ? { isGenerating: pageState.isGenerating }
        : await getGenerationState(page);
      if (!state.isGenerating) {
        await page.waitForTimeout(500);
        const finalText = responseAfterMessage(await getConversationTurns(page), message, baselineLastTurnId);
        if (onUpdate) {
          const finalState = await getTargetAppState(page).catch(() => null);
          onUpdate({ text: finalText || lastText, state: finalState });
        }
        return finalText || lastText;
      }

      if (Date.now() - stableSince >= RESPONSE_STABLE_FALLBACK_MS) {
        return text;
      }
    } else if (onUpdate && pageState) {
      onUpdate({ text: '', state: pageState });
    }

    await page.waitForTimeout(sawResponse ? RESPONSE_POLL_MS : 500);
  }

  if (lastText) return lastText;
  throw new Error(`Timed out after ${timeout}ms waiting for assistant response`);
}

async function ask(page, message, args) {
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
  const turnsBefore = await getConversationTurns(page);
  const baselineLastTurnId = turnsBefore.length ? turnsBefore[turnsBefore.length - 1].testid : '';
  await sendMessage(page, message);
  await page.waitForFunction(() => /\/c\/[^/]+/.test(location.pathname), null, { timeout: 10000 }).catch(() => {});
  refreshSessionTranscript(page, args);
  appendTranscript(args.transcript, 'user', message);
  const streamer = args.stream ? createStreamPrinter() : null;
  const response = await waitForAssistantResponse(
    page,
    message,
    baselineLastTurnId,
    args.timeout,
    streamer ? (event) => streamer.update(event) : null,
  );
  if (streamer) streamer.finish();
  refreshSessionTranscript(page, args);
  appendTranscript(args.transcript, 'assistant', response);
  if (args.downloadArtifacts) {
    const saved = await downloadLatestArtifacts(page, args);
    info(`[artifacts] saved ${saved.length} item(s): ${saved.map(formatSavedArtifact).join(', ')}`);
  }
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

  while (true) {
    const input = await readPromptInput('CB> ');

    if (input.type === 'command' && (input.text === '/exit' || input.text === '/quit')) break;
    if (input.type === 'command' && input.text === '/transcript') {
      console.log(args.transcript);
      continue;
    }
    if (input.type === 'command' && input.text === '/status') {
      const state = await getTargetAppState(page);
      console.log(summarizeState(state));
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
  }

  const browser = await chromium.connectOverCDP(args.cdp);
  try {
    const page = await findTargetAppPage(browser);
    await settlePage(page);
    refreshSessionTranscript(page, args);

    if (args.status) {
      const state = await getTargetAppState(page);
      console.log(summarizeState(state));
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
      return;
    }

    if (typeof args.message === 'string') {
      const message = args.message.trim();
      if (!message) throw new Error('No message provided');
      const response = await ask(page, message, args);
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
