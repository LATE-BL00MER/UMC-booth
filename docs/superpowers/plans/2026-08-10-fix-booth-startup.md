# Booth Startup Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run booth` start without caller-supplied configuration and avoid poisoning macOS DNS before a new Quick Tunnel hostname is ready.

**Architecture:** Keep configuration ownership in `loadConfig` by assigning the temporary HTTPS join destination there. Keep tunnel lifecycle ownership in `TunnelSupervisor`, but schedule the first public health probe after a bounded DNS propagation grace period; later failed probes retain the existing short retry cadence.

**Tech Stack:** TypeScript, Node.js 22, Vitest, Vite, cloudflared Quick Tunnels

## Global Constraints

- Default unfinished join navigation to `https://example.com`.
- A browser navigation to that temporary destination counts as success; the remote page contents are out of scope.
- Preserve the 1-second retry interval after an actual health-probe failure.
- Do not commit or publish changes without a separate user request.

---

### Task 1: Temporary join URL default

**Files:**
- Modify: `tests/shared/config.test.ts`
- Modify: `src/shared/config.ts`

**Interfaces:**
- Consumes: `loadConfig(env: NodeJS.ProcessEnv): AppConfig`
- Produces: `AppConfig.joinSiteUrl === "https://example.com"` when `JOIN_SITE_URL` is absent

- [ ] **Step 1: Write the failing test**

Add a test that removes `JOIN_SITE_URL`, calls `loadConfig`, and expects the literal temporary HTTPS URL.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/shared/config.test.ts`

Expected: FAIL because the current schema rejects an undefined `JOIN_SITE_URL`.

- [ ] **Step 3: Write minimal implementation**

Give the `JOIN_SITE_URL` Zod field a default of `https://example.com`; retain the existing HTTPS validation for explicit overrides.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/shared/config.test.ts`

Expected: all config tests PASS.

### Task 2: Quick Tunnel DNS propagation grace period

**Files:**
- Modify: `tests/server/tunnel-supervisor.test.ts`
- Modify: `src/server/tunnel-supervisor.ts`

**Interfaces:**
- Consumes: a bare `https://<label>.trycloudflare.com` line from cloudflared output
- Produces: no public fetch before a 10-second first-probe grace period; 1-second retries after a failed probe

- [ ] **Step 1: Write the failing tests**

Change the startup health test to assert that parsing a new URL schedules a 10,000 ms timer without fetching. Add or retain a separate assertion that a failed first probe schedules the existing 1,000 ms retry.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/server/tunnel-supervisor.test.ts`

Expected: FAIL because the current supervisor fetches immediately.

- [ ] **Step 3: Write minimal implementation**

Add a 10,000 ms initial health delay and route `beginHealthCheck` through the scheduler. Keep retry scheduling at 1,000 ms.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/server/tunnel-supervisor.test.ts`

Expected: all tunnel supervisor tests PASS.

### Task 3: Full verification and live startup

**Files:**
- Verify only: project test, build, and runtime behavior

**Interfaces:**
- Consumes: `npm run booth`
- Produces: successful build followed by `Operator: http://127.0.0.1:4173` and healthy tunnel status

- [ ] **Step 1: Run the complete automated suite**

Run: `npm test`

Expected: all tests PASS with zero failures.

- [ ] **Step 2: Run the production build**

Run: `npm run build`

Expected: build and typecheck exit 0.

- [ ] **Step 3: Run the exact user command**

Run: `npm run booth`

Expected: the process remains running and prints the operator URL plus `tunnel=healthy`; send SIGINT afterward and confirm no booth/cloudflared listener remains.
