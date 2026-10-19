'use strict';

// Read-only discovery does not attach Playwright to every unrelated open tab.
async function inspectBrowser(cdp, timeoutMs = 5000) {
  const endpoint = new URL(cdp);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Browser discovery requires an HTTP(S) CDP endpoint');
  const response = await fetch(new URL('/json/version', endpoint), { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`CDP discovery failed: HTTP ${response.status}`);
  const version = await response.json();
  if (!version.webSocketDebuggerUrl) throw new Error('CDP did not advertise its browser instance');
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP discovery connection timed out')), timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP discovery connection failed')); }, { once: true });
  });
  socket.addEventListener('message', event => {
    const result = JSON.parse(event.data);
    const request = pending.get(result.id);
    if (!request) return;
    pending.delete(result.id);
    clearTimeout(request.timer);
    if (result.error) request.reject(new Error(result.error.message));
    else request.resolve(result.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP discovery timed out: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await opened;
    const { targetInfos } = await call('Target.getTargets');
    const pages = await Promise.all(targetInfos.filter(target => target.type === 'page').map(async target => {
      const window = await call('Browser.getWindowForTarget', { targetId: target.targetId }).catch(() => null);
      return { targetId: target.targetId, browserContextId: target.browserContextId || '',
        windowId: window?.windowId ?? null, title: target.title, url: target.url };
    }));
    return { cdp: endpoint.origin, browserInstanceId: version.webSocketDebuggerUrl,
      browser: version.Browser, pages };
  } finally {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP discovery closed')); }
    pending.clear();
    socket.close();
  }
}
module.exports = { inspectBrowser };
