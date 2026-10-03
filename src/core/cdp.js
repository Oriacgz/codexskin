// Built-in WebSocket supports masking, continuation frames and buffered reads.
import {assertDebugPortSafe} from './debug-security.js';
function error(message) { return new Error(`cdp: ${message} (is Codex running with --remote-debugging-port?)`); }
const hosts = new Map();
export async function listTargets(port, { timeoutMs = 4_000 } = {}) {
  await assertDebugPortSafe(port);
  const signal = AbortSignal.timeout(timeoutMs);
  let last;
  for (const host of ['127.0.0.1', '[::1]']) {
    try {
      const response = await fetch(`http://${host}:${port}/json/list`, { signal, redirect: 'error' });
      if (!response.ok) throw error(`/json/list returned ${response.status}`);
      const targets = await response.json();
      if (!Array.isArray(targets)) throw error('/json/list returned unexpected data');
      hosts.set(port, host);
      return targets;
    } catch (cause) {
      if (signal.aborted) throw error(`timed out querying port ${port}`);
      last = cause;
    }
  }
  throw error(last?.message ?? 'could not reach CDP endpoint');
}
export function isCodexTarget(target) {
  const url = target.url ?? '';
  if (/codexskin/i.test(target.title ?? '')) return false;
  return /codex|chatgpt/i.test(target.title ?? '')
    || /^https:\/\/(?:codex\.openai\.com|chatgpt\.com)(?:\/|$)/i.test(url)
    || /^(?:app:\/\/.*\/index\.html|file:\/\/.*\/[^/]*(?:codex|chatgpt)[^/]*\/.*index\.html)/i.test(url);
}
export function classifyPageTargets(targets) {
  const pages = targets.filter(target => target?.type === 'page');
  const isOverlay = target => /avatar-overlay/i.test(target.url ?? '');
  return { pages, skinTargets: pages.filter(target => !isOverlay(target)
    && (!target.url || isCodexTarget(target))), overlay: pages.filter(isOverlay) };
}
export async function connectCdp(port, { targetId, target, timeoutMs = 10_000 } = {}) {
  await assertDebugPortSafe(port,{fresh:true});
  const targets = target ? [target] : await listTargets(port);
  const page = target ?? (targetId ? targets.find(item => item.id === targetId)
    : classifyPageTargets(targets).skinTargets[0]);
  if (!page?.webSocketDebuggerUrl) throw error('no debuggable page target');
  const url = new URL(page.webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || url.username || url.password || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname.toLowerCase())) {
    throw error(`refusing non-loopback debugger URL (${url.hostname})`);
  }
  url.hostname = hosts.get(port) ?? (url.hostname==='localhost'?'127.0.0.1':url.hostname);
  url.port = String(port);
  const socket = new WebSocket(url);
  const pending = new Map();
  let closed = false, nextId = 0;
  function rejectPending(cause) {
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(cause); }
    pending.clear();
  }
  socket.addEventListener('close', () => rejectPending(error('connection closed by Codex')));
  socket.addEventListener('error', () => rejectPending(error('websocket connection error')));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(error('websocket handshake timeout')), timeoutMs);
    const open = () => finish();
    const fail = () => finish(error('websocket upgrade failed'));
    function finish(cause) {
      clearTimeout(timer);
      socket.removeEventListener('open', open);
      socket.removeEventListener('error', fail);
      socket.removeEventListener('close', fail);
      if (cause) { socket.close(); reject(cause); } else resolve();
    }
    socket.addEventListener('open', open);
    socket.addEventListener('error', fail);
    socket.addEventListener('close', fail);
  });
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(error(message.error.message ?? JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  function send(method, params = {}) {
    if (closed || socket.readyState !== WebSocket.OPEN) return Promise.reject(error('connection closed'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(error(`command timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch (cause) { clearTimeout(timer); pending.delete(id); reject(cause); }
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result?.exceptionDetails) throw error(`page exception: ${result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text ?? 'unknown error'}`);
    return result?.result?.value;
  }
  function close() { rejectPending(error('connection closed')); socket.close(); }
  return { send, evaluate, close, targetInfo: page };
}
