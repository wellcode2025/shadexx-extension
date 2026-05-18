// ShadeXX offscreen document
//
// Bridges SW (chrome.runtime) ↔ sandbox iframe (postMessage). xxdk-wasm
// and Proxxy live in the sandbox. This file is plumbing only.

const CONTEXT = 'offscreen';
const createdAt = Date.now();

console.log('[shadexx:offscreen] document loaded at', new Date(createdAt).toISOString());

// ----------------------------------------------------------------------------
// Sandbox bridge
// ----------------------------------------------------------------------------

const sandboxFrame = document.getElementById('sandbox-frame');

let sandboxReadyResolve;
const sandboxReady = new Promise((resolve) => {
  sandboxReadyResolve = resolve;
});

let nextMessageId = 1;
const pendingSandboxReplies = new Map(); // id → { resolve, reject, timeoutHandle }

// Per-type timeout overrides. cMix init can run 30–60s the first time;
// allow up to 6 minutes. Discover/RPC may transitively re-init if the
// extension was just reloaded (sandbox state lost) — give them similar
// budget so they can absorb a cold start.
const SANDBOX_TIMEOUTS = {
  PING: 5_000,
  XXDK_PROBE: 120_000,
  PROXXY_INIT: 360_000,
  PROXXY_STATUS: 5_000,
  PROXXY_DISCOVER: 360_000, // was 60s — too tight when a cold init runs first
  PROXXY_RPC: 360_000,
};

window.addEventListener('message', (event) => {
  if (event.source !== sandboxFrame.contentWindow) return;

  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'SANDBOX_READY') {
    console.log('[shadexx:offscreen] sandbox is ready');
    sandboxReadyResolve();
    return;
  }

  if (msg.id && pendingSandboxReplies.has(msg.id)) {
    const pending = pendingSandboxReplies.get(msg.id);
    pendingSandboxReplies.delete(msg.id);
    clearTimeout(pending.timeoutHandle);
    pending.resolve(msg);
    return;
  }

  console.log('[shadexx:offscreen] unhandled sandbox message:', msg);
});

async function sendToSandbox(payload, options = {}) {
  await sandboxReady;
  const id = String(nextMessageId++);
  const timeoutMs = options.timeoutMs || SANDBOX_TIMEOUTS[payload.type] || 30_000;
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      pendingSandboxReplies.delete(id);
      reject(new Error(
        'sandbox reply timeout (' + Math.round(timeoutMs / 1000) + 's): ' + payload.type
      ));
    }, timeoutMs);
    pendingSandboxReplies.set(id, { resolve, reject, timeoutHandle });
    sandboxFrame.contentWindow.postMessage(
      { ...payload, target: 'sandbox', id },
      '*'
    );
  });
}

// ----------------------------------------------------------------------------
// chrome.runtime side
// ----------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== CONTEXT) return false;

  console.log('[shadexx:offscreen] received', msg.type);

  if (msg.type === 'PING') {
    sendResponse({
      type: 'PONG',
      context: CONTEXT,
      receivedAt: Date.now(),
      offscreenLifetimeMs: Date.now() - createdAt,
    });
    return;
  }

  // Generic forward-to-sandbox handler for all sandbox-side message types.
  // Match by suffix; reply with the same envelope shape.
  const forwardTypes = new Set([
    'SANDBOX_PING',
    'XXDK_PROBE',
    'PROXXY_INIT',
    'PROXXY_STATUS',
    'PROXXY_DISCOVER',
    'PROXXY_RPC',
  ]);

  if (forwardTypes.has(msg.type)) {
    (async () => {
      try {
        // Translate SANDBOX_PING → sandbox sees PING.
        const sandboxType = msg.type === 'SANDBOX_PING' ? 'PING' : msg.type;
        const payload = { ...msg, type: sandboxType };
        delete payload.target;
        const reply = await sendToSandbox(payload);
        sendResponse({ type: msg.type + '_RESULT', ok: true, sandboxReply: reply, ...reply });
      } catch (err) {
        sendResponse({
          type: msg.type + '_RESULT',
          ok: false,
          error: String(err?.message || err),
        });
      }
    })();
    return true;
  }

  sendResponse({ type: 'ACK', context: CONTEXT, echo: msg });
});

setInterval(() => {
  console.debug(
    '[shadexx:offscreen] heartbeat — alive for',
    Math.round((Date.now() - createdAt) / 1000),
    's'
  );
}, 30_000);
