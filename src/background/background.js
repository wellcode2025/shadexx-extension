// ShadeXX background service worker
//
// Thin message broker + offscreen lifecycle manager. All real work happens
// downstream (offscreen → sandbox iframe → xxdk-wasm + Proxxy).

console.log('[shadexx:bg] service worker loaded at', new Date().toISOString());

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[shadexx:bg] onInstalled:', details.reason);
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[shadexx:bg] onStartup');
});

// ----------------------------------------------------------------------------
// Offscreen lifecycle
// ----------------------------------------------------------------------------

const OFFSCREEN_URL = 'offscreen.html';
const OFFSCREEN_REASONS = ['LOCAL_STORAGE', 'WORKERS'];
const OFFSCREEN_JUSTIFICATION =
  'Hosts the sandbox iframe running xxdk-wasm cMixx client. Needs DOM + localStorage + long-lived connections.';

let creatingOffscreen = null;

async function ensureOffscreen() {
  if (chrome.offscreen?.hasDocument) {
    const exists = await chrome.offscreen.hasDocument();
    if (exists) return;
  }

  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: OFFSCREEN_REASONS,
      justification: OFFSCREEN_JUSTIFICATION,
    })
    .then(() => {
      console.log('[shadexx:bg] offscreen document created');
    })
    .catch((err) => {
      if (String(err?.message || err).includes('single offscreen document')) {
        console.log('[shadexx:bg] offscreen document already existed');
        return;
      }
      console.error('[shadexx:bg] offscreen create failed:', err);
      throw err;
    })
    .finally(() => {
      creatingOffscreen = null;
    });

  return creatingOffscreen;
}

// ----------------------------------------------------------------------------
// Message routing
// ----------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.target === 'offscreen') return false;

  console.log(
    '[shadexx:bg] onMessage from',
    sender?.tab?.url || sender?.url || 'extension',
    msg?.type
  );

  if (!msg) {
    sendResponse({ type: 'ERROR', error: 'empty message' });
    return;
  }

  if (msg.type === 'PING') {
    sendResponse({ type: 'PONG', context: 'background', receivedAt: Date.now() });
    return;
  }

  if (msg.type === 'TEST_OFFSCREEN') {
    (async () => {
      try {
        const t0 = Date.now();
        await ensureOffscreen();
        const ensuredAt = Date.now();
        const pong = await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'PING',
        });
        sendResponse({
          type: 'TEST_OFFSCREEN_RESULT',
          ok: true,
          timings: { ensureMs: ensuredAt - t0, totalMs: Date.now() - t0 },
          offscreenPong: pong,
        });
      } catch (err) {
        sendResponse({
          type: 'TEST_OFFSCREEN_RESULT',
          ok: false,
          error: String(err?.message || err),
        });
      }
    })();
    return true;
  }

  // Generic forward-to-offscreen for everything that needs the sandbox.
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
        const t0 = Date.now();
        await ensureOffscreen();
        const result = await chrome.runtime.sendMessage({
          ...msg,
          target: 'offscreen',
        });
        sendResponse({ ...result, brokerMs: Date.now() - t0 });
      } catch (err) {
        console.error('[shadexx:bg] forward ' + msg.type + ' failed:', err);
        sendResponse({
          type: msg.type + '_RESULT',
          ok: false,
          error: String(err?.message || err),
        });
      }
    })();
    return true;
  }

  if (msg.type === 'RPC_REQUEST') {
    sendResponse({ type: 'NOT_IMPLEMENTED', method: msg.method });
    return;
  }

  sendResponse({ type: 'ACK', context: 'background', echo: msg });
});
