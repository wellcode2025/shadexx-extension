// SPDX-FileCopyrightText: BitFashioned (https://bitfashioned.com) — original work
// SPDX-FileCopyrightText: 2026 ShadeXX contributors — modifications
// SPDX-License-Identifier: Apache-2.0
//
// ShadeXX — Proxxy client
//
// This file is a derivative work of bitfashioned/xrpl-proxxy-demo
// (https://github.com/bitfashioned/xrpl-proxxy-demo), specifically a port and
// compression of:
//   - src/cmix/hooks/useCmix.ts             (cMix init flow)
//   - src/cmix/contexts/proxxy-context.tsx  (Proxxy request envelope + send)
//
// The original work is licensed under the Apache License, Version 2.0.
// Copies and the full license text are available at:
//   https://www.apache.org/licenses/LICENSE-2.0
// This file is redistributed under the same Apache License 2.0; the rest of
// the ShadeXX project is MIT-licensed.
//
// Modifications from the original (non-exhaustive):
//   - Ported from React/TypeScript to vanilla ES JavaScript class
//   - Restructured for use inside a Chrome MV3 sandbox iframe (no React,
//     no chrome.* APIs, postMessage-only with parent offscreen document)
//   - Status callback pattern instead of React state setters
//   - Auto-prepend leading slash on network URIs to match relay registration
//   - Idempotent NewCmix-then-LoadCmix flow tolerant of in-memory localStorage
//     shim (cmixPreviouslyInitialized flag does not persist across iframe reload,
//     but IndexedDB state does)
//   - Cached single-init pattern (initXxdkOnce / initPromise)
//
// Lives inside the sandbox iframe alongside xxdk-wasm. Holds the cMixx
// client + E2E identity once init() has resolved. Each subsequent
// .request(network, jsonRpcBody) is a fresh single-use cMixx transmission
// to the configured relay.
//
// Spike-grade. Notable shortcuts vs. production:
//   - Hardcoded password (just encrypts local cMix state; per-install
//     random + chrome.storage is the v1.0 plan).
//   - `localStorage` is shimmed in-memory in our sandbox, so the
//     `cmixPreviouslyInitialized` flag the demo uses won't survive iframe
//     reload — but NewCmix's IndexedDB writes DO persist. We just call
//     NewCmix every time and swallow the "storage exists" error.
//   - No retry, no fallback, no timeout customization.

const STATE_PATH = 'shadexx-extension';
const RECEPTION_IDENTITY_KEY = 'shadexxProxxyReceptionIdentity';
const FOLLOWER_TIMEOUT_PERIOD_MS = 50_000;
const WAIT_FOR_NETWORK_MS = 10 * 60 * 1000; // 10 min upper bound

// Security limits (see docs/SECURITY_AUDIT.md S-5 and S-6).
//
// XXC_CONTACT_PATTERN: a serialized xxDK Contact in the on-wire format
// `<xxc(2)…base64…xxc>`. We validate the wrapper + a reasonable length
// bound before passing untrusted strings into RequestRestLike. The real
// contact we ship is ~600 bytes; cap generously at 4096 to allow for
// alternate-format contacts without being abuse-friendly.
const XXC_CONTACT_PATTERN = /^<xxc\(2\)[A-Za-z0-9+/=]+xxc>$/;
const XXC_CONTACT_MAX_LEN = 4096;

// MAX_REQUEST_BODY_BYTES: outbound JSON-RPC bodies are capped before they
// hit cMix. cMix single-use has internal per-message limits well below
// 16KB; we reject earlier with a clearer error and prevent any future
// caller (e.g. M2 content script seeing an attacker-controlled large
// param) from exhausting cMix buffers or triggering multi-part chunking
// we haven't tested.
const MAX_REQUEST_BODY_BYTES = 16 * 1024;

// Spike-grade password. The cMix client encrypts its local storage with
// this; for v1.0 we'd generate a random per-install key and store it via
// chrome.storage. For the spike, sharing a password across installs is
// fine — Proxxy's per-request unlinkability doesn't depend on the cMix
// identity (each request uses its own ephemeral single-use identity).
const SPIKE_PASSWORD = new TextEncoder().encode(
  'shadexx-spike-password-do-not-use-in-production-32bytes-min!'
);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ProxxyClient {
  /**
   * @param {object} xxdk - the InitXXDK() return value (XXDKUtils)
   * @param {string} ndf  - mainnet NDF JSON (from xxdk.GetDefaultNDF())
   * @param {object} [opts]
   * @param {(status: string, detail?: any) => void} [opts.onStatus]
   */
  constructor(xxdk, ndf, opts = {}) {
    this.xxdk = xxdk;
    this.ndf = ndf;
    this.password = opts.password || SPIKE_PASSWORD;
    this.statePath = opts.statePath || STATE_PATH;
    this.onStatus = opts.onStatus || (() => {});

    this.cmix = null;
    this.e2e = null;
    this.e2eId = null;
    this.identity = null;
    this.status = 'uninitialized';
    this._initPromise = null;
  }

  _setStatus(s, detail) {
    this.status = s;
    try { this.onStatus(s, detail); } catch {}
    console.log('[proxxy] status →', s, detail || '');
  }

  /**
   * Idempotent: subsequent calls return the same promise as the first.
   * On success, the cMix network follower is running and e2eId is set.
   */
  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit().catch((err) => {
      this._setStatus('failed', String(err?.message || err));
      throw err;
    });
    return this._initPromise;
  }

  async _doInit() {
    const { xxdk, ndf, password, statePath } = this;

    // 1. Idempotent storage creation. NewCmix fails if storage exists for
    //    this statePath — we swallow that specific error, surface others.
    this._setStatus('creating-storage');
    try {
      await xxdk.NewCmix(ndf, statePath, password, '');
      console.log('[proxxy] NewCmix: created fresh storage');
    } catch (err) {
      const msg = String(err?.message || err);
      if (/exists|already|initialized/i.test(msg)) {
        console.log('[proxxy] NewCmix: storage already exists (expected on subsequent runs)');
      } else {
        // Unexpected error — re-throw. Probably worth knowing about.
        console.warn('[proxxy] NewCmix returned unexpected error:', msg);
        throw err;
      }
    }

    // 2. Build cMix params, enabling immediate sending (matches demo).
    const baseParams = JSON.parse(decoder.decode(xxdk.GetDefaultCMixParams()));
    baseParams.Network.EnableImmediateSending = true;
    const cmixParams = encoder.encode(JSON.stringify(baseParams));

    // 3. Load cMix.
    this._setStatus('loading-cmix');
    this.cmix = await xxdk.LoadCmix(statePath, password, cmixParams);
    const cmixId = this.cmix.GetID();
    console.log('[proxxy] cmix loaded, id =', cmixId);

    // 4. Get or create reception identity for proxxy.
    this._setStatus('reception-identity');
    try {
      this.identity = xxdk.LoadReceptionIdentity(RECEPTION_IDENTITY_KEY, cmixId);
      console.log('[proxxy] reception identity loaded from storage');
    } catch {
      console.log('[proxxy] creating new reception identity');
      this.identity = await this.cmix.MakeReceptionIdentity();
      xxdk.StoreReceptionIdentity(RECEPTION_IDENTITY_KEY, this.identity, cmixId);
    }

    // 5. Login to E2E.
    this._setStatus('e2e-login');
    const e2eParams = xxdk.GetDefaultE2EParams();
    this.e2e = xxdk.Login(
      cmixId,
      { Request: () => {}, Confirm: () => {}, Reset: () => {} },
      this.identity,
      e2eParams
    );
    this.e2eId = this.e2e.GetID();
    console.log('[proxxy] e2e id =', this.e2eId);

    // 6. Start network follower.
    this._setStatus('starting-follower');
    this.cmix.StartNetworkFollower(FOLLOWER_TIMEOUT_PERIOD_MS);

    // 7. Wait for network. THIS IS THE SLOW STEP (30–60s typical first time).
    this._setStatus('waiting-for-network');
    await this.cmix.WaitForNetwork(WAIT_FOR_NETWORK_MS);

    // 8. Register a health callback so we can react to network drops.
    this.cmix.AddHealthCallback({
      Callback: (isHealthy) => {
        this._setStatus(isHealthy ? 'connected' : 'disconnected');
      },
    });

    this._setStatus('connected');
  }

  /**
   * Send a Proxxy REST-style request through cMixx.
   * @param {object} opts
   * @param {Uint8Array|string} opts.recipient - relay contact (xxc string or raw bytes)
   * @param {string} opts.uri    - '/networks' for discovery, 'ethereum/mainnet' for RPC
   * @param {1|2} opts.method    - 1 = GET, 2 = POST
   * @param {Uint8Array} [opts.data] - body bytes (for POST)
   * @returns {Promise<any>} parsed JSON response content
   */
  async request({ recipient, uri, method, data }) {
    if (this.status !== 'connected') {
      throw new Error('Proxxy not connected (status=' + this.status + ')');
    }

    // Validate the recipient. If passed as a string, it must be a
    // properly-formed xxc contact within length bounds. Bytes are
    // accepted as-is (these come from prior validated processing).
    let recipientBytes;
    if (typeof recipient === 'string') {
      if (recipient.length > XXC_CONTACT_MAX_LEN) {
        throw new Error('relay contact too long (max ' + XXC_CONTACT_MAX_LEN + ' chars)');
      }
      if (!XXC_CONTACT_PATTERN.test(recipient)) {
        throw new Error('relay contact does not match xxc(2) format');
      }
      recipientBytes = encoder.encode(recipient);
    } else {
      recipientBytes = recipient;
    }

    // Cap outbound payload size. cMix has its own internal limits but
    // we'd rather fail fast with a clear error than rely on the WASM
    // layer's diagnostics.
    if (data && data.byteLength > MAX_REQUEST_BODY_BYTES) {
      throw new Error(
        'request body exceeds max (' + data.byteLength + ' > ' + MAX_REQUEST_BODY_BYTES + ' bytes)'
      );
    }

    const dataStr = data ? this.xxdk.Uint8ArrayToBase64(data) : '';
    const envelope = {
      Version: 1,
      Headers: '',
      Content: dataStr,
      Method: method,
      URI: uri,
      Error: '',
    };
    const reqBytes = encoder.encode(JSON.stringify(envelope));
    console.log('[proxxy] sending request', { uri, method, bodyBytes: data?.byteLength || 0 });

    const params = this.xxdk.GetDefaultSingleUseParams();
    const responseBytes = await this.xxdk.RequestRestLike(
      this.e2eId,
      recipientBytes,
      reqBytes,
      params
    );

    const respStr = decoder.decode(responseBytes);
    const resp = JSON.parse(respStr);
    console.log('[proxxy] got envelope', {
      hasContent: !!resp.content,
      contentLen: resp.content ? resp.content.length : 0,
      error: resp.error || resp.Error || null,
    });

    if (!resp.content) {
      // Some error envelopes may use Error field directly.
      const err = resp.error || resp.Error;
      if (err) throw new Error('Proxxy relay error: ' + err);
      return null;
    }
    const contentBytes = this.xxdk.Base64ToUint8Array(resp.content);
    const contentStr = decoder.decode(contentBytes);
    return JSON.parse(contentStr);
  }

  /**
   * GET /networks against the configured relay. Returns string[] of network
   * URIs the relay supports (e.g. ["ethereum/mainnet", "polygon/mainnet"]).
   */
  async discoverNetworks(relayContact) {
    return this.request({ recipient: relayContact, uri: '/networks', method: 1 });
  }

  /**
   * Send a JSON-RPC request to a specific network.
   * @param {Uint8Array|string} relayContact
   * @param {string} network - e.g. 'ethereum/mainnet' (slash auto-prepended)
   * @param {object} jsonRpcBody - e.g. { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }
   *
   * Note: the relay registers all endpoints with a leading slash
   * (`/ethereum/mainnet`, `/custom`, `/networks`). The xrpl-proxxy-demo passed
   * `xrpl/mainnet` without a slash but their demo was against an older relay
   * build. We normalize here so callers don't need to think about it.
   */
  async sendJsonRpc(relayContact, network, jsonRpcBody) {
    const data = encoder.encode(JSON.stringify(jsonRpcBody));
    const uri = network.startsWith('/') ? network : '/' + network;
    return this.request({ recipient: relayContact, uri, method: 2, data });
  }
}

// Proxxy relay contact (xxc-format Contact serialization).
//
// Currently set to Aaron's locally self-hosted relay, generated by
// `~/relay-bin init` against the cloned xx-labs/blockchain-cmix-relay repo.
// The relay daemon must be running in WSL (`~/relay-bin -p <password>`) for
// requests to succeed. networks.json configures `ethereum/mainnet` →
// https://eth.llamarpc.com.
//
// For grant/release: either xx Foundation's production relay (if/when we
// source one) or instructions for users to point at any compatible relay.
//
// History:
//   - Originally pointed at bitfashioned/xrpl-proxxy-demo's contact
//     (XRPL-only); confirmed offline 2026-05-17.
//   - The xx-labs/blockchain-cmix-relay repo committed the same contact
//     (i.e. xrpl-proxxy-demo just reused xx-labs's test relay); also
//     offline.
//   - Self-hosting was the unblock — every operator gets their own contact.
export const RELAY_CONTACT =
  '<xxc(2)Dd0l6MVKlxljAUY1qsVcbyTQJJGPWwLZnPhFT/0dQF8DkAZiB9kZo+Dl3YRVnfm3L749dXp2GbQK/TUo6Lgk7xch4ZSpGrsGJDivNCFHne6DfciA3I36OwUH5Sr7dqhVKvMjcUr+2fCctYs7ZdqvFWhODbd/Txn+8hF0UAmBfzxkIFJwGhBr3vm856f+fPVP4YMC274kDrWp6YgldAhLaNZBjR13/Qax4mVTh4k0Tfa+goFx5wj0Hy/b2ve5vSHNc1JgaGB9CV72BDeDc47aZN5aQdeAcyG5rIIkjVdd9Jh6twHguf3Ue9I1O7VDdvosn8QQYafKBKh4iKPxvY2b0JJIgm38TlxUJ6hyVlUDWEQeeAnHVAFMwJ4MvMlrK81Y/UhE2jGkAjc1ydrNascOBjNJNoEx46vPyXin94hXXhxirkkrSF2F1uz+5rZp07RFR2z+bYSnxGejj2WPgj9vHvEdiHJvZ/hGSPJhg1GFgBfoAsx8oMWrRLDSR6gGUCUccRMAQUWKDN4asV4lXCVrU5kRH633ciVW1OCXz+qh77jGO5CyfO6SyvhCJwAAAgA74xGR6/dsl84t3QEoJn5eMw==xxc>';

// Backwards-compat alias — other code still imports XRPL_DEMO_RELAY_CONTACT.
// Remove once all imports are updated.
export const XRPL_DEMO_RELAY_CONTACT = RELAY_CONTACT;
