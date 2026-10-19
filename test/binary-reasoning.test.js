const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate test environment
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-binary-reasoning-tests-'));
process.env.CHATBOT_TRANSCRIPT_DIR = testDir;
process.env.CHATBOT_STATE_DIR = path.join(testDir, 'scheduler');

test.after(() => {
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

const cb = require('../CB.js');

function createMockPage(initialPressed = 'false') {
  let pressed = String(initialPressed);
  const rect = () => ({ x: 300, y: 500, width: 80, height: 36 });
  const rects = () => [{ x: 300, y: 500, width: 80, height: 36 }];

  const thinkButton = {
    tagName: 'BUTTON',
    offsetWidth: 80,
    offsetHeight: 36,
    innerText: 'Think',
    textContent: 'Think',
    hasAttribute: (attr) => attr === 'aria-pressed',
    matches: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: (attr) => (attr === 'aria-pressed' ? pressed : null),
    click: () => {
      pressed = pressed === 'true' ? 'false' : 'true';
    },
    closest: (selector) => {
      if (selector.includes('form')) return formElement;
      return null;
    },
    getBoundingClientRect: rect,
    getClientRects: rects,
  };

  const composerInput = {
    tagName: 'DIV',
    offsetWidth: 500,
    offsetHeight: 100,
    innerText: '',
    textContent: '',
    hasAttribute: () => false,
    getAttribute: () => null,
    matches: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ x: 200, y: 400, width: 500, height: 100 }),
    getClientRects: () => [{ x: 200, y: 400, width: 500, height: 100 }],
    closest: (sel) => (sel.includes('form') ? formElement : null),
  };

  const formElement = {
    tagName: 'FORM',
    offsetWidth: 600,
    offsetHeight: 150,
    innerText: 'Think',
    textContent: 'Think',
    hasAttribute: () => false,
    getAttribute: () => null,
    matches: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ x: 200, y: 400, width: 600, height: 150 }),
    getClientRects: () => [{ x: 200, y: 400, width: 600, height: 150 }],
    querySelectorAll: (selector) => {
      if (selector.includes('button')) return [thinkButton];
      if (selector.includes('prompt-textarea') || selector.includes('contenteditable')) return [composerInput];
      return [];
    },
    querySelector: (selector) => {
      if (selector.includes('prompt-textarea') || selector.includes('contenteditable')) return composerInput;
      if (selector.includes('button')) return thinkButton;
      return null;
    },
    contains: (el) => el === thinkButton || el === composerInput,
  };

  return {
    url: () => 'https://example.invalid/c/11111111-2222-3333-4444-555555555555',
    title: async () => 'Test Conversation',
    locator: (selector) => ({
      first: () => ({
        count: async () => 1,
        click: async () => {
          pressed = pressed === 'true' ? 'false' : 'true';
        },
        getAttribute: async (attr) => (attr === 'aria-pressed' ? pressed : null),
      }),
    }),
    waitForTimeout: async () => {},
    evaluate: async (fn, ...evalArgs) => {
      const originalDoc = global.document;
      const originalLocation = global.location;
      const originalWindow = global.window;
      global.window = {
        location: { href: 'https://example.invalid/c/11111111-2222-3333-4444-555555555555' },
        innerWidth: 1920,
        innerHeight: 1080,
      };
      global.location = { href: 'https://example.invalid/c/11111111-2222-3333-4444-555555555555' };
      global.document = {
        title: 'Test Conversation',
        elementFromPoint: () => null,
        querySelectorAll: (sel) => {
          if (sel.includes('form')) return [formElement];
          if (sel.includes('button')) return [thinkButton];
          if (sel.includes('prompt-textarea')) return [composerInput];
          return [];
        },
        querySelector: (sel) => {
          if (sel.includes('form')) return formElement;
          if (sel.includes('button')) return thinkButton;
          if (sel.includes('prompt-textarea')) return composerInput;
          return null;
        },
      };
      try {
        if (typeof fn === 'function') {
          return await fn(...evalArgs);
        }
        return null;
      } finally {
        global.document = originalDoc;
        global.location = originalLocation;
        global.window = originalWindow;
      }
    },
    _getPressed: () => pressed,
    _setPressed: (p) => { pressed = String(p); },
  };
}

test('Binary Reasoning: getTargetAppState detects Think button and extracts binaryReasoning state', async () => {
  const page = createMockPage('false');
  const state = await cb.getTargetAppState(page);
  assert.equal(state.binaryReasoning?.exists, true);
  assert.equal(state.binaryReasoning?.enabled, false);
  assert.equal(state.model, 'Instant');

  // When pressed is true
  page._setPressed('true');
  const statePressed = await cb.getTargetAppState(page);
  assert.equal(statePressed.binaryReasoning?.exists, true);
  assert.equal(statePressed.binaryReasoning?.enabled, true);
  assert.equal(statePressed.model, 'Think');
});

test('Binary Reasoning: buildStateEvent emits tierMode binary_reasoning and normalized modelSelection', async () => {
  const page = createMockPage('false');
  const rawState = await cb.getTargetAppState(page);
  const event = cb.buildStateEvent(rawState);
  assert.equal(event.tierMode, 'binary_reasoning');
  assert.equal(event.modelSelection.model, 'Default');
  assert.equal(event.modelSelection.mode, 'Instant');
  assert.equal(event.modelSelection.effort, 'Instant');
  assert.equal(event.modelSelection.button, 'Instant');

  // When enabled
  page._setPressed('true');
  const rawPressed = await cb.getTargetAppState(page);
  const eventPressed = cb.buildStateEvent(rawPressed);
  assert.equal(eventPressed.tierMode, 'binary_reasoning');
  assert.equal(eventPressed.modelSelection.mode, 'Thinking');
  assert.equal(eventPressed.modelSelection.effort, 'Think');
  assert.equal(eventPressed.modelSelection.button, 'Think');
});

test('Binary Reasoning: selectReasoning toggles Think button between Think and Instant', async () => {
  const page = createMockPage('false'); // Currently Instant / false

  // 1. Request Think -> toggles false to true
  const res1 = await cb.selectReasoning(page, 'Think');
  assert.equal(res1.selected, 'Think');
  assert.equal(res1.fallback, false);
  assert.equal(page._getPressed(), 'true');

  // 2. Request Think again -> idempotent, no toggle
  const res2 = await cb.selectReasoning(page, 'thinking');
  assert.equal(res2.selected, 'Think');
  assert.equal(page._getPressed(), 'true');

  // 3. Request Instant -> toggles true to false
  const res3 = await cb.selectReasoning(page, 'instant');
  assert.equal(res3.selected, 'Instant');
  assert.equal(page._getPressed(), 'false');

  // 4. Request off / fast -> idempotent Instant
  const res4 = await cb.selectReasoning(page, 'fast');
  assert.equal(res4.selected, 'Instant');
  assert.equal(page._getPressed(), 'false');
});

test('Binary Reasoning: selectModel gracefully handles free tier and routes reasoning aliases', async () => {
  const page = createMockPage('false');

  // 1. Explicit model request when in binary reasoning mode
  const res1 = await cb.selectModel(page, 'Latest');
  assert.equal(res1.selected, 'Default (Instant)');
  assert.equal(res1.fallback, true);

  // 2. Model request with reasoning alias (e.g. "Think")
  const res2 = await cb.selectModel(page, 'Think');
  assert.equal(res2.selected, 'Default (Think)');
  assert.equal(page._getPressed(), 'true');

  // 3. Model request with "Instant"
  const res3 = await cb.selectModel(page, 'Instant');
  assert.equal(res3.selected, 'Default (Instant)');
  assert.equal(page._getPressed(), 'false');
});

test('Binary Reasoning: inspectModelConfigurator and listModelOptions report Free tier status', async () => {
  const page = createMockPage('false');
  const options = await cb.listModelOptions(page);
  assert.ok(options.some((line) => line.includes('Tier: Free (Binary Reasoning)')));
  assert.ok(options.some((line) => line.includes('Model: Default')));
  assert.ok(options.some((line) => line.includes('Current Reasoning: Instant (Disabled)')));
  assert.ok(options.some((line) => line.includes('- Instant (No reasoning / fast) [selected]')));

  // When enabled
  page._setPressed('true');
  const optionsPressed = await cb.listModelOptions(page);
  assert.ok(optionsPressed.some((line) => line.includes('Current Reasoning: Think (Enabled)')));
  assert.ok(optionsPressed.some((line) => line.includes('- Think   (Reasoning enabled) [selected]')));
});
