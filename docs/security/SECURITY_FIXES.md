# Security Fix Backlog

> Deferred remediation record from the security audit performed on 2026-08-13.
>
> Audited revision: branch `feat/relationship-sharing-foundation`, commit `25fdd3d`.
>
> This file records findings only. No item is considered fixed until its remediation and verification checkboxes are completed with supporting tests or operational evidence.

## Summary

The audit identified **25 numbered findings**:

- **Critical:** 3
- **High:** 11
- **Medium:** 10
- **Low:** 1

It also identified one additional CI hardening item. The original audit summary said “24 findings / 9 Medium,” but its detailed numbered list contains findings 1–25, including 10 Medium findings. This backlog follows the detailed list so no finding is lost.

## Remediation tracking

- [ ] Remediation implementation completed
- [ ] Security regression test or operational verification completed
- [ ] Relevant credentials/keys rotated where required
- [ ] Deployment and documentation updated where required
- [ ] Independent review completed

---

## Critical

### SEC-001 — MCP authorization observer is never installed

- **Classification:** CWE-862 — Missing Authorization
- **Locations:** `mcp-server/index.js:640-697, 757-836, 984-1011, 1882-1885`
- **Finding:** The MCP server defines and imports authorization observers but never invokes either one. Any peer with room credentials can inject arbitrary Yjs changes into the MCP document, including member promotion, ownership changes, record replacement, configuration changes, and invite manipulation.
- **Required fix:** Install the shared authorization observer before WebRTC starts. Test unauthorized remote updates. Replace the mutable replicated member map as the sole ACL root with an owner-signed authorization chain.
- [ ] Fixed
- [ ] Verified

### SEC-002 — Sandboxed scripts can access other locally opened dapps

- **Classification:** CWE-862 / CWE-668 — Missing Authorization / Exposure of Resource to Wrong Sphere
- **Locations:** `src/services/scriptSandbox.ts:57-76, 152-195, 201-225`
- **Finding:** The parent validates that a store request came from the shared sandbox iframe but trusts the iframe-supplied `dappId`. Malicious synchronized script code can request records from another dapp opened by the same user and potentially create, update, or delete its data.
- **Required fix:** Never accept `dappId` from sandbox messages. Bind every execution ID to a parent-controlled dapp and capability set. Prefer a separate iframe or capability channel per dapp.
- [ ] Fixed
- [ ] Verified

### SEC-003 — Historical private keys remain recoverable from Git history

- **Classification:** CWE-312 / CWE-540 — Cleartext Storage of Sensitive Information / Inclusion of Sensitive Information in Source Code
- **Location:** Historical `mcp-server/identity.json`, first confirmed in commit `f0ebe87af508aca755a3cc662878ac4b317d0e42`
- **Finding:** A complete historical Ed25519 signing key and RSA private key remain in repository history. The current key differs, but the old key remains exploitable if its public identity is still a member of any dapp or associated room credentials have not been rotated.
- **Required fix:** Treat the historical identity as compromised. Remove it from every dapp, rotate room credentials, rewrite Git history, coordinate force-updates, and enable full-history secret scanning.
- [ ] Compromised identity removed from all dapps
- [ ] Room credentials rotated
- [ ] Git history rewritten and coordinated
- [ ] Full-history secret scanning enabled and verified

---

## High

### SEC-004 — Most synchronized Yjs structures have no remote authorization

- **Classification:** CWE-862 / CWE-863 — Missing or Incorrect Authorization
- **Locations:** `src/services/store/auth.ts:115-188, 277-400, 476-652`; `src/services/store/docs.ts:72-108, 225-313`
- **Finding:** Remote authorization covers members and records, but not configuration, schemas, screens, themes, invites, `appData`, plugins, channel metadata, or the separate code-source document. UI-side `requireRole` checks do not protect against a custom Yjs client. Source-room credentials are deterministically derived from main-room credentials.
- **Required fix:** Authenticate every replicated security-relevant operation with domain-separated signed operations. Give the source room separate random credentials distributed only to authorized members.
- [ ] Fixed
- [ ] Verified

### SEC-005 — Legacy invite grants can be forged

- **Classification:** CWE-345 — Insufficient Verification of Data Authenticity
- **Locations:** `src/services/store/docs.ts:193-220`; `mcp-server/index.js:905-930`; `mcp-server/accept-invite.js:99-128`
- **Finding:** A lobby participant can encrypt attacker-selected room credentials to a victim and write them to `grantedAccess`. Encryption protects confidentiality but does not prove that the owner issued the grant.
- **Required fix:** Owner-sign every grant and bind it to the invite, lobby, recipient signing and encryption keys, room credentials, role, expiry, and nonce. Pin the expected owner key in the invite.
- [ ] Fixed
- [ ] Verified

### SEC-006 — Signing and encryption identities are not cryptographically bound

- **Classification:** CWE-345 — Insufficient Verification of Data Authenticity
- **Locations:** `src/services/store/docs.ts:176-190`; `src/pages/DappSettingsPage.tsx:88-110`; `mcp-server/index.js:1750-1800`
- **Finding:** Lobby awareness independently advertises an Ed25519 signing key and RSA encryption key. An attacker can advertise a victim’s signing key alongside the attacker’s encryption key. Approval then adds the victim as a member while sending credentials to the attacker.
- **Required fix:** Require the signing key to sign the RSA-key fingerprint, invite/lobby IDs, nonce, role, and timestamp. Include both keys in the safety number.
- [ ] Fixed
- [ ] Verified

### SEC-007 — Removing a member does not revoke room access

- **Classification:** CWE-613 / CWE-284 — Insufficient Session Expiration / Improper Access Control
- **Locations:** `src/services/store/members.ts:48-70`; `src/services/store/docs.ts:279-284`; `mcp-server/index.js:783-798`
- **Finding:** Removal changes the replicated ACL but does not rotate the shared room ID/password. Removed members can reconnect, read future updates, attack unprotected structures, and consume resources. The UI claim that removed members “will lose access to all data” is false under the current design.
- **Required fix:** Rotate room credentials and content-key epochs on revocation, redistribute them only to remaining members, and disconnect revoked peers. Correct the UI claim until revocation is real.
- [ ] Fixed
- [ ] Verified

### SEC-008 — Malformed WebSocket input remotely crashes the signaling server

- **Classification:** CWE-248 / CWE-20 — Uncaught Exception / Improper Input Validation
- **Location:** `node_modules/y-webrtc/bin/server.js:82-85, 126-137`
- **Finding:** `JSON.parse` is used without exception handling. The audit reproduced a process crash by sending a two-byte malformed message to a temporary unauthenticated server.
- **Required fix:** Do not deploy the bundled sample server. Catch parse errors per connection, validate message schemas, limit message size, and close only the offending socket.
- [ ] Fixed
- [ ] Crash regression test added and passed

### SEC-009 — Signaling server permits unauthenticated resource exhaustion

- **Classification:** CWE-400 / CWE-770 — Uncontrolled Resource Consumption / Allocation Without Limits
- **Location:** `node_modules/y-webrtc/bin/server.js:22-26, 47-67, 88-137`
- **Finding:** There are no effective limits on connections, topics, topic names, message size, publish rate, subscribers, or retained topics. Attackers can create memory growth and publish amplification.
- **Required fix:** Add global and per-IP connection limits, topic quotas, message-size limits, rate limits, bounded queues, backpressure, authentication, and slow-client eviction.
- [ ] Fixed
- [ ] Load/abuse tests passed

### SEC-010 — Active MCP keys and room credentials have excessive filesystem permissions

- **Classification:** CWE-312 / CWE-732 — Cleartext Storage / Incorrect Permission Assignment
- **Locations:** `mcp-server/identity.json`, `registry.json`, `dapps.json`; writers at `mcp-server/index.js:72-81, 707-724`
- **Finding:** These files contain plaintext private keys and room credentials and were observed with mode `0770`, allowing group read and write access.
- **Required fix:** Use a `0700` directory and atomic `0600` files, verify ownership and mode on startup, reject symlinks, and use an OS keyring or encrypted keystore where possible.
- [ ] Fixed
- [ ] Permissions and symlink protections verified

### SEC-011 — Active room credentials are hardcoded in operational scripts

- **Classification:** CWE-798 / CWE-312 — Hard-coded Credentials / Cleartext Storage
- **Locations:** `add-member.js:13-15`; `promote-owner.js:10-14`; `mcp-server/shopping-watcher.js:37-39`
- **Finding:** Ignored local scripts contain reusable room IDs/passwords. Two scripts perform privileged membership or ownership changes. `.gitignore` does not provide confidentiality.
- **Required fix:** Rotate those credentials, delete obsolete scripts, and load secrets from an owner-only secret store.
- [ ] Credentials rotated
- [ ] Obsolete scripts removed or secured
- [ ] Secret-store loading verified

### SEC-012 — `expr-eval@2.0.2` is vulnerable and processes shared formulas

- **Classification:** CWE-1321 / CWE-94 — Prototype Pollution / Code Injection
- **Locations:** `package.json:43`; `src/services/formulaEvaluator.ts:72-75`
- **Finding:** Production dependency audit confirmed prototype-pollution and insufficient function-restriction advisories. No fixed `expr-eval` release is available. Collaborative or imported formulas reach `Parser.evaluate()`.
- **Required fix:** Replace it with a maintained restricted expression engine. Permit only an explicit AST/operator/function set and reject member access, assignment, constructors, prototypes, and callable record values.
- [ ] Dependency replaced
- [ ] Malicious-expression regression tests passed

### SEC-013 — Synchronized scripts can silently exfiltrate record data

- **Classification:** CWE-200 / CWE-749 — Exposure of Sensitive Information / Exposed Dangerous Function
- **Locations:** `src/services/scriptSandbox.ts:23-82, 296-368`; `src/pages/dapp/helpers.ts:48-62`
- **Finding:** The script iframe has no restrictive inner CSP. Owner-supplied scripts receive records, identity/context, relations, and store access while retaining `fetch`, WebSocket, image requests, and similar network primitives.
- **Required fix:** Use an inner CSP with `default-src 'none'` and deny network, image, media, frame, form, and worker destinations. If networking is needed, expose a parent-mediated, consent-based, origin-scoped API.
- [ ] Fixed
- [ ] Exfiltration regression tests passed

### SEC-014 — Disabling plugin “network access” does not disable networking

- **Classification:** CWE-284 / CWE-200 — Improper Access Control / Exposure of Sensitive Information
- **Locations:** `src/components/screen-designer/settings/PluginSettings.tsx:52-63`; `src/pages/dapp/PluginScreenView.tsx:133-160`; `src/services/pluginBridge.ts:43-54, 142-145`
- **Finding:** The flag only controls `allow-same-origin`. The remote plugin URL still loads and can make requests. After `plugin:ready`, the parent provides current records, schema, member metadata, identity metadata, and ongoing record updates.
- **Required fix:** When networking is disabled, do not load a remote URL. Install and execute reviewed plugin source in an opaque `srcdoc` iframe with `connect-src 'none'`. Require explicit permissions before transferring records.
- [ ] Fixed
- [ ] Network-disable and data-permission tests passed

---

## Medium

### SEC-015 — MCP LevelDB persistence is not connected to document updates

- **Classification:** CWE-922 — Insecure Storage / Integrity and Rollback Risk
- **Locations:** `mcp-server/index.js:699-703, 761-775, 1887-1901`
- **Finding:** The server reads persisted updates but never calls `storeUpdate()` or an equivalent binding. Changes exist only in memory and can disappear after restart, restoring stale ACL, invite, or data state.
- **Required fix:** Persist every update, await pending writes and compaction during shutdown, and add restart-recovery tests without online peers.
- [ ] Fixed
- [ ] Restart-recovery tests passed

### SEC-016 — MCP limited-use invites are not enforced

- **Classification:** CWE-613 / CWE-799 — Insufficient Expiration / Improper Control of Interaction Frequency
- **Locations:** `mcp-server/index.js:1639-1669, 1733-1806`
- **Finding:** `usesLeft` is created but never checked or decremented in MCP approval. A nominally one-use invite remains reusable. MCP also writes unsigned member entries that browser observers may reject after room credentials have already been disclosed.
- **Required fix:** Atomically validate and decrement invite usage and write a correctly signed member record in one transaction.
- [ ] Fixed
- [ ] Concurrency and replay tests passed

### SEC-017 — Relationship invite expiry is not enforced by the inviter

- **Classification:** CWE-613 — Insufficient Session Expiration
- **Locations:** `src/services/relationshipProtocol.ts:132-160`; `src/services/relationshipPairingRuntime.ts:68-98`
- **Finding:** The accepting side checks expiry, but inviter-side request verification and approval do not. Expired invitations or old requests may remain approvable.
- **Required fix:** Enforce invite expiry and request timestamps during inviter verification and approval. Destroy expired or consumed lobbies.
- [ ] Fixed
- [ ] Expiry and stale-request tests passed

### SEC-018 — Lobby replay state is attacker-writable

- **Classification:** CWE-345 / CWE-400 — Insufficient Authenticity Verification / Resource Consumption
- **Location:** `src/services/relationshipPairingRuntime.ts:47-70`
- **Finding:** `consumedInvites` is an ordinary writable Yjs map. Any invite holder can mark an invite consumed and deny it to the intended recipient. Unlimited malformed pairing requests can also cause verification and memory pressure.
- **Required fix:** Require inviter-signed consumption state, bound request count and object size, deduplicate requests, and rate-limit verification.
- [ ] Fixed
- [ ] Forgery, replay, and resource-bound tests passed

### SEC-019 — Browser identity private keys are plaintext and exportable from `localStorage`

- **Classification:** CWE-922 — Insecure Storage of Sensitive Information
- **Location:** `src/services/identity.ts:10-23, 47-82, 174-176`
- **Finding:** Long-term signing and RSA decryption keys are extractable and serialized into `localStorage`. Any same-origin script compromise can steal them and use them outside the browser.
- **Required fix:** Store non-extractable `CryptoKey` objects in IndexedDB. Encrypt explicitly exported backups with a passphrase-derived authenticated key.
- [ ] Fixed
- [ ] Migration, backup, restore, and non-extractability tests passed

### SEC-020 — Installed React Router version has active advisories

- **Packages:** `react-router@7.15.1`, `react-router-dom`
- **Finding:** The root production audit found package advisories affecting `expr-eval`, `react-router`, and `react-router-dom`. SSR/RSC advisories are likely unreachable in this Vite SPA, but client-side redirect and pathological route-matching behavior may apply.
- **Required fix:** Upgrade React Router and React Router DOM to versions satisfying all audit fixes (the audit recommended at least the `7.18.2` range) and validate internal navigation destinations.
- [ ] Dependencies upgraded
- [ ] Production audit and navigation tests passed

### SEC-021 — MCP runtime tree contains five vulnerable packages

- **Packages:** `hono`, `@hono/node-server`, `fast-uri`, `ip-address`, `body-parser`
- **Finding:** `npm audit --omit=dev` reported three High, one Moderate, and one Low package advisories. Current MCP operation uses stdio, so most HTTP-specific paths were not demonstrated as reachable, but the vulnerable packages remain installed runtime components.
- **Required fix:** Upgrade `@modelcontextprotocol/sdk`, regenerate the lockfile, and use reviewed overrides if necessary.
- [ ] Dependencies upgraded
- [ ] MCP production audit and tests passed

### SEC-022 — Development signaling endpoint is plaintext, unauthenticated, and broadly bound

- **Classification:** CWE-319 / CWE-306 — Cleartext Transmission / Missing Authentication
- **Locations:** `package.json:7`; `vite.config.ts:12-19`; `node_modules/y-webrtc/bin/server.js`
- **Finding:** The signaling server uses HTTP/WebSocket without authentication and binds all interfaces. Vite also binds all interfaces. Direct port access bypasses the HTTPS Vite proxy.
- **Required fix:** Bind signaling to `127.0.0.1` or a Unix socket, firewall the direct port, and expose it only through an authenticated TLS reverse proxy.
- [ ] Fixed
- [ ] Bind address, firewall, TLS, and authentication verified

### SEC-023 — Builder CSP substantially weakens XSS containment

- **Classification:** CWE-693 / CWE-319 — Protection Mechanism Failure / Cleartext Transmission
- **Location:** `index.html:8`
- **Finding:** The policy includes `script-src 'self' 'unsafe-inline' 'unsafe-eval'` and broad `connect-src 'self' ws: wss: https:`. It lacks a header-delivered `frame-ancestors` policy. No repository configuration was found for HSTS, `nosniff`, Referrer Policy, or Permissions Policy.
- **Required fix:** Remove top-level `unsafe-inline` and `unsafe-eval`, restrict connection origins, deliver CSP as an HTTP header, and add `frame-ancestors`, HSTS, `X-Content-Type-Options`, Referrer Policy, and Permissions Policy.
- [ ] Fixed
- [ ] Browser security-header and CSP regression tests passed

### SEC-024 — MCP server is excluded from source control and security automation

- **Classification:** CWE-1104 — Use of Unmaintained Third-Party Components / Security Process Weakness
- **Locations:** `.gitignore:28-29`; `.github/workflows/ci.yml`; `.github/dependabot.yml`
- **Finding:** The entire `mcp-server/` directory, including source, package manifest, and lockfile, is ignored. Root CI and Dependabot therefore do not test or update it. Five audited runtime advisories remained outside normal automation.
- **Required fix:** Track MCP source and lockfiles. Ignore only generated databases, identity files, credentials, and logs. Add dedicated tests, audit, and Dependabot configuration.
- [ ] MCP source and lockfile tracked safely
- [ ] CI, audit, and Dependabot coverage verified

---

## Low

### SEC-025 — Public STUN/TURN providers disclose connection metadata

- **Classification:** CWE-200 — Exposure of Sensitive Information
- **Location:** `mcp-server/index.js:788-795`
- **Finding:** The MCP provider unconditionally uses Google STUN and public OpenRelay TURN credentials. Those parties can observe IP addresses and connection timing; TURN may relay encrypted traffic.
- **Required fix:** Make ICE configuration configurable and use controlled TURN infrastructure with short-lived credentials.
- [ ] Fixed
- [ ] Controlled ICE configuration verified

---

## Additional hardening

### HARDEN-001 — GitHub Actions use mutable action tags and broad/default permissions

- **Location:** `.github/workflows/ci.yml:12-13`
- **Finding:** Actions use mutable major tags such as `actions/checkout@v4` and `actions/setup-node@v4` rather than immutable commit SHAs. Explicit least-privilege workflow permissions were not configured.
- **Required fix:** Pin third-party actions to full commit SHAs and set explicit workflow permissions such as `contents: read`.
- [ ] Fixed
- [ ] Workflow permissions and pinned SHAs verified

---

## Audit verification evidence

The original audit performed the following checks:

- Reproduced the signaling-server crash using malformed unauthenticated WebSocket input.
- Re-ran production dependency audits:
  - Root: **3 vulnerable package entries**.
  - MCP: **5 vulnerable package entries**.
- Ran focused sandbox/runtime tests: **3 test files passed, 12 tests passed**.
- Confirmed no MCP persistence update binding.
- Confirmed no MCP authorization-observer invocation.
- Confirmed the repository remained unchanged during the audit.

## Checks that did not reveal a concrete issue

These are retained to prevent unnecessary duplicate investigation; they are not guarantees of safety:

- No production `dangerouslySetInnerHTML`, direct application `innerHTML`, `document.write`, or `insertAdjacentHTML` sink was found.
- The Code App iframe uses `sandbox="allow-scripts"` without `allow-same-origin`.
- The Code App runtime strips authored CSP/base/refresh, remote scripts, event handlers, forms, frames, and unsupported URLs; its bridge validates iframe source and random runtime ID.
- The plugin bridge validates `event.source`.
- No confirmed `javascript:` navigation sink was found.
- No service worker was found.
- No confirmed filesystem path traversal or shell-command injection was found in application handlers.
- Relationship encryption primitives use Ed25519, RSA-OAEP, AES-256-GCM with AAD, and signed/hash-linked control messages correctly; identified defects concern lifecycle and authorization.
- Lockfiles include integrity hashes, and inspected packages resolved from npm’s HTTPS registry.

## Recommended remediation order

1. Disable or replace the exposed signaling server.
2. Install MCP remote-update authorization.
3. Fix the script-sandbox cross-dapp capability bypass.
4. Authenticate every replicated Yjs structure.
5. Revoke historical keys and rotate affected room credentials.
6. Sign legacy invite grants and bind signing/encryption identities.
7. Implement real member revocation through room/key rotation.
8. Remove ambient networking from scripts and plugins.
9. Secure active key and credential storage.
10. Repair persistence and invite lifecycle enforcement.
11. Replace `expr-eval` and update vulnerable dependencies.
12. Add MCP source control, CI, Dependabot, and secret scanning.
