# Self-Hosting a Proxxy Relay for ShadeXX Development

> This document captures what we learned setting up a working Proxxy relay against which ShadeXX can be tested. Required reading if you want to actually exercise the cMix round-trip during development.

## Why you need this

ShadeXX is a Proxxy client. It needs a reachable Proxxy relay to forward decrypted JSON-RPC requests to a real blockchain RPC endpoint. As of May 2026, there is no actively-running public relay we have been able to source:

- The `relay.xxc` committed to [`xx-labs/blockchain-cmix-relay`](https://github.com/xx-labs/blockchain-cmix-relay) belongs to a test relay that is currently offline.
- The same contact is reused by [`bitfashioned/xrpl-proxxy-demo`](https://github.com/bitfashioned/xrpl-proxxy-demo) — also offline.
- `proxxy.xx.network` is xx Foundation's marketing/download site and does not expose a contact endpoint.

Until a public relay is available, **self-hosting is the only way to test end-to-end**. This document walks through the setup we used to get a real `eth_blockNumber` round-trip working.

> **License note on the relay code:** `xx-labs/blockchain-cmix-relay` does not currently ship a top-level LICENSE file. The repo is publicly hosted by xx-labs and clearly intended for open-source use, but in the strict legal default that means "all rights reserved." ShadeXX does not redistribute the relay binary or source — these instructions tell you to clone the official repo and build it yourself, so no redistribution obligations accrue here. If you ship a fork or modified relay you should ask xx-labs to add an explicit license first.

---

## Prerequisites

- Ubuntu 24.04 WSL2 (or any Linux with Go 1.19+; we used Go 1.22.2)
- Network egress to xx network mainnet gateways (HTTPS + WebSockets to varied ports including 22840-22861)
- Network egress to at least one Ethereum (or other EVM) RPC endpoint that answers `eth_blockNumber`

---

## 1. Build the relay binary

The README in `xx-labs/blockchain-cmix-relay` is out of date (says `cd relay && go build`; the actual path is `blockchain/relay`).

```bash
cd ~/projects
git clone https://github.com/xx-labs/blockchain-cmix-relay.git
cd blockchain-cmix-relay/blockchain/relay
go build -o ~/relay-bin
```

The build pulls a long list of Go modules (gitlab.com/elixxir/* and friends) and produces a ~27MB binary. First build takes 1-3 minutes including module downloads.

---

## 2. Initialize relay state and identity

Make a dedicated working directory. The relay generates a fresh cMix reception identity on init and writes its contact to `relay.xxc` in cwd; storing in a separate directory keeps the cloned repo unchanged.

```bash
mkdir -p ~/projects/shadexx-relay
cd ~/projects/shadexx-relay
cp ~/projects/blockchain-cmix-relay/mainnet.crt .

# Init: registers with xx mainnet permissioning, generates state/ + relay.xxc.
# Takes ~30s.
~/relay-bin init -p shadexx-relay-password -c mainnet.crt
```

You should see `state/` populated with ~18 files and `relay.xxc` (a 600-byte text file starting with `<xxc(2)`).

> **The password encrypts the relay's local cMix state.** Use a strong one in any deployed scenario. For local development the password just needs to match between init and run.

---

## 3. Configure supported networks

The relay reads `networks.json` from cwd by default (override with `-n /path/to/file`). The relay **validates each endpoint at startup** by sending a probe request — and **silently drops the entire network if no endpoint answers**. Then it creates a `/custom` fallback as the only registered endpoint. If you see your client get `["/custom"]` from `/networks` discovery, this is what happened.

### Endpoint reality as of May 2026

We tested the common free public Ethereum RPCs from WSL:

| Endpoint | Result | Notes |
|---|---|---|
| `https://ethereum-rpc.publicnode.com` | ✅ Works | No auth, returns valid JSON-RPC |
| `https://cloudflare-eth.com` | ❌ Returns `-32046 "Cannot fulfill request"` | App-level error despite HTTP 200; free tier restricted |
| `https://rpc.ankr.com/eth` | ❌ "Unauthorized" | Now requires API key registration |
| `https://eth.llamarpc.com` | ❌ HTTP 525 | Cloudflare SSL handshake failure (intermittent) |

Verify any candidate from your own environment first:

```bash
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  https://ethereum-rpc.publicnode.com
```

You want a response of the form `{"jsonrpc":"2.0","result":"0x...","id":1}`. Anything with an `error` field or non-200 status will be rejected by the relay.

### Recommended starting config

```bash
cat > ~/projects/shadexx-relay/networks.json << 'EOF'
{
  "ethereum": [
    {
      "name": "mainnet",
      "endpoints": [
        "https://ethereum-rpc.publicnode.com"
      ]
    }
  ]
}
EOF
```

You can list multiple endpoints in the array — the relay tries them in order and keeps the first that validates. For production-style configs see `~/projects/blockchain-cmix-relay/relay/networks-example.json` (note: example URLs are placeholders, not real endpoints).

---

## 4. Run the relay

```bash
cd ~/projects/shadexx-relay
~/relay-bin -p shadexx-relay-password
```

**The relay logs to `relay.log` by default, NOT to stdout.** Your terminal will sit there silent while the relay happily runs. Don't assume "no output means it crashed" — open another terminal and `tail -f relay.log` to see what's happening.

To background it instead:

```bash
nohup ~/relay-bin -p shadexx-relay-password > /dev/null 2>&1 &
echo "Started PID $!"
tail -f relay.log
```

### What "success" looks like in the logs

```
INFO ... LoadCmix()
INFO ... [RELAY] Initialized single use REST Server
INFO ... [RELAY] Endpoint https://ethereum-rpc.publicnode.com returned code 200
INFO ... [RELAY] Creating network: /ethereum/mainnet        ← key line — endpoint validated
INFO ... [RELAY] Creating network: /custom                  ← always created as fallback
INFO ... [RELAY] Creating endpoint: /networks
INFO ... StartNetworkFollower()
INFO ... Successfully connected to <gateway-host>:<port>    ← multiple of these
INFO ... [RELAY] Started REST Server
INFO ... ----Host-Pool Information----                       ← active gateways
INFO ... [Follow] Polled the network N times in the last 1m0s
```

If you see `Creating network: /ethereum/mainnet`, your config loaded. If you only see `Creating network: /custom`, your endpoint(s) didn't validate — go back to step 3.

### Noise that's normal

The log will be dominated by `ERROR Failed to register node: ... unable to connect to target host ...` and `WARN received GRPC status code 2: unable to find target host ...`. These are individual gateway registration retries that didn't reach a quorum or aren't currently reachable. The relay continues working as long as the host pool reaches steady-state (15-ish active nodes).

---

## 5. Wire the contact into ShadeXX

Cat the relay contact:

```bash
cat ~/projects/shadexx-relay/relay.xxc
```

It's a string like `<xxc(2)Dd0l6MVKlxljAUY1qsVcbyTQJJGPWwL...xxc>`. Paste this verbatim as the value of `RELAY_CONTACT` in `src/sandbox/proxxy-client.js`. Rebuild ShadeXX (`npm run build:dev`), reload extension in `chrome://extensions`.

---

## Common gotchas

### "Discovery returned `[\"/custom\"]` only"

`networks.json` did not validate. Possible causes:
- The file isn't in the relay's cwd (use `-n /full/path/to/networks.json` to be explicit).
- Every endpoint returned an error or unreachable response on the relay's validation probe.
- The JSON is malformed.

Check `relay.log` for `Endpoint ... returned code N` and `Network ... has no valid endpoints, not supporting this network!` lines.

### "Got response `unable to locate endpoint: ethereum/mainnet`"

The relay registers endpoints with leading slashes (`/ethereum/mainnet`, `/custom`, `/networks`). Requests must include the leading slash. ShadeXX's `ProxxyClient.sendJsonRpc()` auto-prepends, so callers can use either form. If you're calling `request()` directly with a custom URI, include the slash.

### "Discovery times out after ~25 seconds"

That timeout is from xxDK's `GetDefaultSingleUseParams()` (internal, not our bridge timeout) — it means cMix sent the request into the mixnet but never heard back. Most likely the relay process isn't actually running. Check:

```bash
pgrep -af relay-bin
```

The first single-use after a long idle period also drops more often than not; retry once.

### "Cannot fulfill request" / -32046 from an RPC endpoint

Cloudflare-fronted free RPCs have gotten increasingly restrictive. Use PublicNode or run your own node.

### Relay's identity changes when you re-init

`~/relay-bin init ...` always generates fresh keys. If you re-init, you must re-export `relay.xxc` and re-paste into ShadeXX. The committed `relay.xxc` in the xx-labs repo is stale for exactly this reason.

---

## What happens to traffic at the relay

The relay sees:

- The decrypted JSON-RPC body (it has to forward it to the upstream RPC).
- An ephemeral cMix reception identity for the requesting client (used only for this one request; cMix cannot link it to the client's permanent identity).
- The upstream RPC URL it's forwarding to.

The relay does NOT see:

- The user's IP address (the cMix mixnet does, but only as one of ~1000 messages in the anonymity batch; the gateway only sees encrypted batched ciphertext).
- Any persistent identifier of the user.

**Trust model summary:** if you self-host, you trust yourself. If someone else hosts, you trust them not to log/correlate ephemeral identities against the request content. The relay is the most sensitive single component in the trust graph.

---

## Roadmap notes

We have not yet sourced an actively-running public Proxxy relay. v1.0 production candidates:

1. xx Foundation hosts a relay we can default to.
2. ShadeXX team operates a community relay we default to.
3. ShadeXX ships with a "Bring Your Own Relay" first-run flow.

Likely a combination: a default we operate + the ability to point at any compatible relay. This document will be updated as that situation evolves.
