// ShadeXX popup — Phase 3a: status + Proxxy init + /networks discovery.

import './popup.css';

const els = {
  status: document.getElementById('status'),
  sw: document.getElementById('sw'),
  offscreen: document.getElementById('offscreen'),
  sandbox: document.getElementById('sandbox'),
  xxdk: document.getElementById('xxdk'),
  proxxy: document.getElementById('proxxy'),
  detail: document.getElementById('detail'),
  probeBtn: document.getElementById('probeBtn'),
  initBtn: document.getElementById('initBtn'),
  discoverBtn: document.getElementById('discoverBtn'),
  blockBtn: document.getElementById('blockBtn'),
};

els.status.textContent = 'SCAFFOLD';
['sw', 'offscreen', 'sandbox', 'xxdk', 'proxxy'].forEach((k) => {
  els[k].textContent = '…';
});

function set(el, text, kind) {
  el.textContent = text;
  el.className = 'value' + (kind ? ' ' + kind : '');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderSteps(steps, err) {
  const lines = (steps || []).map((s) => {
    const status = s.ok ? '✓' : '✗';
    let detail = '';
    if (s.detail === null || s.detail === undefined) {
      detail = '';
    } else if (typeof s.detail === 'string') {
      detail = ' — ' + s.detail.slice(0, 200);
    } else {
      detail = ' — ' + JSON.stringify(s.detail).slice(0, 400);
    }
    return status + ' ' + s.label + detail;
  });
  if (err) lines.push('✗ error: ' + err);
  els.detail.innerHTML = lines.map(escapeHtml).join('<br>');
}

// ---------------- Status checks (auto on popup open) ----------------

async function pingSw() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'PING' });
    if (r?.type === 'PONG') {
      set(els.sw, 'alive @ ' + new Date(r.receivedAt).toLocaleTimeString(), 'ok');
    } else {
      set(els.sw, 'unexpected', 'err');
    }
  } catch {
    set(els.sw, 'unreachable', 'err');
  }
}

async function testOffscreen() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'TEST_OFFSCREEN' });
    if (r?.ok) {
      const lifetime = r.offscreenPong?.offscreenLifetimeMs;
      set(els.offscreen, 'alive (rt ' + r.timings.totalMs + 'ms'
        + (typeof lifetime === 'number' ? ', up ' + Math.round(lifetime / 1000) + 's' : '')
        + ')', 'ok');
    } else {
      set(els.offscreen, 'failed', 'err');
    }
  } catch {
    set(els.offscreen, 'sendMessage threw', 'err');
  }
}

async function testSandbox() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'SANDBOX_PING' });
    if (r?.ok) {
      const lifetime = r.sandboxLifetimeMs || r.sandboxReply?.sandboxLifetimeMs;
      set(els.sandbox, 'alive'
        + (typeof lifetime === 'number' ? ' (up ' + Math.round(lifetime / 1000) + 's)' : ''), 'ok');
    } else {
      set(els.sandbox, 'failed', 'err');
    }
  } catch {
    set(els.sandbox, 'sendMessage threw', 'err');
  }
}

async function refreshProxxyStatus() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'PROXXY_STATUS' });
    if (r?.ok) {
      const s = r.status || 'uninitialized';
      const kind = s === 'connected' ? 'ok' : (s === 'failed' || s === 'disconnected' ? 'err' : '');
      set(els.proxxy, s + (r.e2eId !== undefined && r.e2eId !== null ? ' (e2eId=' + r.e2eId + ')' : ''), kind);
    } else {
      set(els.proxxy, 'unknown', '');
    }
  } catch {
    set(els.proxxy, 'unknown', '');
  }
}

// ---------------- Button handlers ----------------

async function runXxdkProbe() {
  els.probeBtn.disabled = true;
  set(els.xxdk, 'probing…');
  els.detail.textContent = 'Probing xxdk-wasm inside the sandbox iframe…';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'XXDK_PROBE' });
    if (r?.ok) {
      set(els.xxdk, 'OK (' + r.totalMs + 'ms)', 'ok');
    } else {
      set(els.xxdk, 'FAILED', 'err');
    }
    renderSteps(r?.steps, r?.error);
  } catch (err) {
    set(els.xxdk, 'threw', 'err');
    els.detail.textContent = String(err?.message || err);
  } finally {
    els.probeBtn.disabled = false;
  }
}

async function runProxxyInit() {
  els.initBtn.disabled = true;
  set(els.proxxy, 'initializing…');
  els.detail.innerHTML =
    'Initializing cMixx client inside sandbox.<br>' +
    '• Creating/loading storage (~1s)<br>' +
    '• Building cMix client (~5s)<br>' +
    '• Starting network follower<br>' +
    '• Waiting for network — <strong>this is the slow step, can take 30–60s the first time</strong>';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'PROXXY_INIT' });
    if (r?.ok) {
      set(els.proxxy, 'connected (' + Math.round(r.totalMs / 1000) + 's, e2eId=' + r.e2eId + ')', 'ok');
      const history = (r.statusHistory || [])
        .map(h => '· ' + h.status + (h.detail ? ' (' + (typeof h.detail === 'string' ? h.detail : JSON.stringify(h.detail).slice(0, 60)) + ')' : ''))
        .join('<br>');
      els.detail.innerHTML = '<strong>cMixx connected ✓</strong><br>' + history;
    } else {
      set(els.proxxy, 'FAILED', 'err');
      els.detail.textContent = r?.error || 'unknown init error';
    }
  } catch (err) {
    set(els.proxxy, 'threw', 'err');
    els.detail.textContent = String(err?.message || err);
  } finally {
    els.initBtn.disabled = false;
  }
}

async function runDiscover() {
  els.discoverBtn.disabled = true;
  els.detail.textContent = 'Sending GET /networks through cMixx to the XRPL demo relay (proves end-to-end Proxxy pipe; relay is XRPL-only — expect xrpl networks back, not Ethereum)…';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'PROXXY_DISCOVER' });
    if (r?.ok) {
      els.detail.innerHTML =
        '<strong>Discovery succeeded in ' + r.totalMs + 'ms ✓</strong><br>' +
        'Supported networks: <code>' + escapeHtml(JSON.stringify(r.networks)) + '</code>';
    } else {
      els.detail.innerHTML = '<strong>Discovery failed:</strong><br>' + escapeHtml(r?.error || 'unknown');
    }
  } catch (err) {
    els.detail.textContent = 'threw: ' + (err?.message || err);
  } finally {
    els.discoverBtn.disabled = false;
  }
}

async function runEthBlockNumber() {
  els.blockBtn.disabled = true;
  els.detail.innerHTML =
    'Sending <code>eth_blockNumber</code> through cMixx to <code>ethereum/mainnet</code> on the self-hosted relay…<br>' +
    'cMixx round-trip is typically 3-8 seconds + relay-to-RPC + 3-8 seconds back.';
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'PROXXY_RPC',
      network: 'ethereum/mainnet',
      rpc: { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 },
    });
    if (r?.ok) {
      const blockHex = r.result?.result;
      const blockNum = blockHex ? parseInt(blockHex, 16) : null;
      els.detail.innerHTML =
        '<strong>eth_blockNumber succeeded in ' + r.totalMs + 'ms ✓</strong><br>' +
        'Raw response: <code>' + escapeHtml(JSON.stringify(r.result)) + '</code><br>' +
        (blockNum
          ? '<strong>Current Ethereum mainnet block: ' + blockNum.toLocaleString() + '</strong>'
          : '(no result field in response)');
    } else {
      els.detail.innerHTML = '<strong>eth_blockNumber failed:</strong><br>' + escapeHtml(r?.error || 'unknown');
    }
  } catch (err) {
    els.detail.textContent = 'threw: ' + (err?.message || err);
  } finally {
    els.blockBtn.disabled = false;
  }
}

els.probeBtn.addEventListener('click', runXxdkProbe);
els.initBtn.addEventListener('click', runProxxyInit);
els.discoverBtn.addEventListener('click', runDiscover);
els.blockBtn.addEventListener('click', runEthBlockNumber);

pingSw();
testOffscreen();
testSandbox();
refreshProxxyStatus();
