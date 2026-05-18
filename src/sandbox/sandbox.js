// ShadeXX sandbox page
//
// Runs in MV3 sandbox context (null origin, permissive CSP). Hosts
// xxdk-wasm + the Proxxy client. All communication with the outside world
// goes through window.parent.postMessage.

import * as xxdk from 'xxdk-wasm';
import { ProxxyClient, XRPL_DEMO_RELAY_CONTACT } from './proxxy-client.js';

const CONTEXT = 'sandbox';
const createdAt = Date.now();

console.log('[shadexx:sandbox] document loaded at', new Date(createdAt).toISOString());
console.log('[shadexx:sandbox] xxdk exports:', Object.keys(xxdk).slice(0, 20));

// ----------------------------------------------------------------------------
// xxdk-wasm init (the bare-bones probe from Phase 2) — needed before
// Proxxy can do anything.
// ----------------------------------------------------------------------------

let xxdkUtilsPromise = null;
async function getXxdkUtils() {
  if (xxdkUtilsPromise) return xxdkUtilsPromise;
  xxdkUtilsPromise = (async () => {
    if (typeof xxdk.setXXDKBasePath === 'function') {
      xxdk.setXXDKBasePath(window.xxdkBasePath);
    }
    const utils = await xxdk.InitXXDK();
    const initXxdkKeys = Object.keys(utils || {});
    console.log('[shadexx:sandbox] InitXXDK return keys (' + initXxdkKeys.length + '):', initXxdkKeys);

    // xxdk-wasm v0.3.22's InitXXDK() returns a Speakeasy/Haven-focused
    // subset of utilities. The lower-level cMix primitives we need for
    // Proxxy (StoreReceptionIdentity, LoadReceptionIdentity, Login,
    // RequestRestLike, encoding helpers, etc.) are installed by the WASM
    // as window globals but not mirrored on the return value. The xrpl
    // proxxy demo confirms this — it pulls all 15 methods directly from
    // window. We enrich the return value here so the ProxxyClient sees a
    // single uniform `utils` object.
    const enriched = Object.assign({}, utils);
    const fallbackKeys = [
      'NewCmix', 'LoadCmix', 'Login',
      'StoreReceptionIdentity', 'LoadReceptionIdentity',
      'RequestRestLike',
      'GetDefaultCMixParams', 'GetDefaultE2EParams', 'GetDefaultSingleUseParams',
      'Uint8ArrayToBase64', 'Base64ToUint8Array',
      'GetClientVersion', 'GetVersion', 'GetWasmSemanticVersion',
      'GetOrInitPassword',
    ];
    const pickedUp = [];
    const stillMissing = [];
    for (const key of fallbackKeys) {
      if (typeof enriched[key] !== 'function') {
        if (typeof window[key] === 'function') {
          enriched[key] = window[key];
          pickedUp.push(key);
        } else {
          stillMissing.push(key);
        }
      }
    }
    console.log('[shadexx:sandbox] picked up from window:', pickedUp);
    if (stillMissing.length) {
      console.warn('[shadexx:sandbox] STILL MISSING (neither in InitXXDK nor window):', stillMissing);
    }
    return enriched;
  })();
  return xxdkUtilsPromise;
}

// ----------------------------------------------------------------------------
// Phase 2 probe (still useful for diagnostics).
// ----------------------------------------------------------------------------

let xxdkProbePromise = null;
let xxdkProbeResult = null;

async function probeXxdk() {
  const steps = [];
  const record = (label, ok, detail) =>
    steps.push({ label, ok, detail, t: Math.round(performance.now()) });

  const t0 = performance.now();
  let utils;
  try {
    utils = await getXxdkUtils();
    const allKeys = Object.keys(utils || {});
    const singleUseKeys = allKeys.filter((k) =>
      /[Ss]ingle|[Tt]ransmit|[Ll]isten|RequestRest/.test(k)
    );
    record('InitXXDK', true, { totalKeys: allKeys.length, allKeys, singleUseKeys });
  } catch (err) {
    record('InitXXDK', false, String(err?.message || err));
    return finalize();
  }

  try {
    const version =
      (window.GetClientVersion?.()) ||
      (window.GetVersion?.()) ||
      null;
    record('window.Get*Version', !!version, version);
  } catch (err) {
    record('window.Get*Version', false, String(err?.message || err));
  }

  try {
    const ndf = xxdk.GetDefaultNDF();
    record('GetDefaultNDF', String(ndf || '').length > 0, {
      length: String(ndf || '').length,
    });
  } catch (err) {
    record('GetDefaultNDF', false, String(err?.message || err));
  }

  function finalize() {
    return { ok: steps.every((s) => s.ok), totalMs: Math.round(performance.now() - t0), steps };
  }
  return finalize();
}

async function initXxdkProbeOnce() {
  if (xxdkProbeResult) return xxdkProbeResult;
  if (xxdkProbePromise) return xxdkProbePromise;
  xxdkProbePromise = probeXxdk().then((r) => {
    xxdkProbeResult = r;
    return r;
  });
  return xxdkProbePromise;
}

// ----------------------------------------------------------------------------
// Proxxy client — initialized lazily on first PROXXY_INIT message.
// ----------------------------------------------------------------------------

let proxxyClient = null;
let proxxyInitPromise = null;
const proxxyStatusHistory = []; // ring buffer of recent status changes

async function getProxxyClient() {
  if (proxxyClient && proxxyClient.status === 'connected') return proxxyClient;
  if (proxxyInitPromise) return proxxyInitPromise;

  proxxyInitPromise = (async () => {
    const utils = await getXxdkUtils();
    const ndf = xxdk.GetDefaultNDF();
    if (!ndf || ndf.length < 100) {
      throw new Error('GetDefaultNDF returned empty or implausibly small NDF');
    }
    proxxyClient = new ProxxyClient(utils, ndf, {
      onStatus: (status, detail) => {
        const entry = { t: Date.now(), status, detail };
        proxxyStatusHistory.push(entry);
        // Keep last 50.
        if (proxxyStatusHistory.length > 50) proxxyStatusHistory.shift();
      },
    });
    await proxxyClient.init();
    return proxxyClient;
  })().catch((err) => {
    proxxyInitPromise = null; // allow retry
    throw err;
  });

  return proxxyInitPromise;
}

// ----------------------------------------------------------------------------
// postMessage protocol with parent (offscreen.html)
// ----------------------------------------------------------------------------

window.addEventListener('message', async (event) => {
  // Defense-in-depth: the sandbox iframe is only embeddable by extension
  // pages. In our architecture, only the offscreen document parent ever
  // sends us messages. Reject anything from another window.
  if (event.source !== window.parent) {
    console.warn('[shadexx:sandbox] rejected non-parent message source');
    return;
  }

  const msg = event.data;
  if (!msg || msg.target !== CONTEXT) return;

  console.log('[shadexx:sandbox] received', msg.type, 'id=' + msg.id);

  const reply = (body) => {
    event.source.postMessage({ id: msg.id, context: CONTEXT, ...body }, event.origin);
  };

  try {
    if (msg.type === 'PING') {
      return reply({
        type: 'PONG',
        receivedAt: Date.now(),
        sandboxLifetimeMs: Date.now() - createdAt,
      });
    }

    if (msg.type === 'XXDK_PROBE') {
      const result = await initXxdkProbeOnce();
      return reply({ type: 'XXDK_PROBE_RESULT', ...result });
    }

    if (msg.type === 'PROXXY_INIT') {
      const t0 = performance.now();
      await getProxxyClient();
      return reply({
        type: 'PROXXY_INIT_RESULT',
        ok: true,
        totalMs: Math.round(performance.now() - t0),
        status: proxxyClient?.status,
        statusHistory: proxxyStatusHistory.slice(),
        e2eId: proxxyClient?.e2eId,
      });
    }

    if (msg.type === 'PROXXY_STATUS') {
      return reply({
        type: 'PROXXY_STATUS_RESULT',
        status: proxxyClient?.status || 'uninitialized',
        statusHistory: proxxyStatusHistory.slice(),
        e2eId: proxxyClient?.e2eId,
      });
    }

    if (msg.type === 'PROXXY_DISCOVER') {
      // Use the relay contact provided in the message, or default to the
      // XRPL demo relay for Phase-3a smoke testing.
      const relayContact = msg.relayContact || XRPL_DEMO_RELAY_CONTACT;
      const client = await getProxxyClient();
      const t0 = performance.now();
      const networks = await client.discoverNetworks(relayContact);
      return reply({
        type: 'PROXXY_DISCOVER_RESULT',
        ok: true,
        totalMs: Math.round(performance.now() - t0),
        networks,
      });
    }

    if (msg.type === 'PROXXY_RPC') {
      const relayContact = msg.relayContact || XRPL_DEMO_RELAY_CONTACT;
      const network = msg.network;
      const rpc = msg.rpc;
      if (!network || !rpc) {
        return reply({ type: 'PROXXY_RPC_RESULT', ok: false, error: 'missing network or rpc' });
      }
      const client = await getProxxyClient();
      const t0 = performance.now();
      const result = await client.sendJsonRpc(relayContact, network, rpc);
      return reply({
        type: 'PROXXY_RPC_RESULT',
        ok: true,
        totalMs: Math.round(performance.now() - t0),
        result,
      });
    }

    return reply({ type: 'ACK', echo: msg });
  } catch (err) {
    console.error('[shadexx:sandbox] handler error for', msg.type, err);
    return reply({
      type: (msg.type || 'UNKNOWN') + '_RESULT',
      ok: false,
      error: String(err?.message || err),
      stack: err?.stack ? err.stack.split('\n').slice(0, 8).join('\n') : null,
    });
  }
});

window.parent.postMessage({ type: 'SANDBOX_READY', context: CONTEXT }, '*');
console.log('[shadexx:sandbox] posted SANDBOX_READY to parent');
