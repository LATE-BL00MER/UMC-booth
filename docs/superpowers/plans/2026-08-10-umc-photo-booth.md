# UMC Photo Booth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a MacBook-hosted team photo booth that captures six photos, lets the team choose four and a frame, delivers a browser-encrypted result through a temporary HTTPS tunnel for ten minutes, and then links to the existing club application site.

**Architecture:** A single TypeScript repository produces an operator React application, an inline recipient browser application, and a local Node.js runtime. The runtime opens separate loopback-only private and public Fastify listeners; only the public listener is connected to a temporary `cloudflared` URL. Plaintext photos stay in browser memory, while the server stores only versioned AES-GCM ciphertext and minimal expiry metadata.

**Tech Stack:** Node.js 22+, npm, TypeScript, React, Vite, Fastify, Zod, Web Crypto, QRCode, esbuild, Vitest, Testing Library, and Playwright.

## Global Constraints

- Support 1–4 participants per team and at most 10 teams per hour.
- Run an exact five-second countdown before each of six captures.
- Require exactly four photos; selection order defines final slot order 1–4.
- Choose the frame only after selecting four photos.
- Show `처음으로` in the upper-right corner of every operator screen.
- The reset confirmation contains only `처음 화면으로 돌아갈까요?`, `취소`, and `확인`.
- Reset deletes only the current unissued session; previously issued QR sessions remain usable until expiry.
- Generate a distinct 256-bit AES-GCM key and 96-bit nonce per completed photo.
- Persist no plaintext photo, decryption key, name, phone number, email, account, IP address, or per-person analytics identifier.
- Start the ten-minute access window when the private activation API succeeds; deny access immediately at expiry and delete files within 30 seconds.
- Allow every member of a team to use the same QR during the access window.
- Show the existing application-site CTA only after the recipient initiates photo saving.
- Keep visual styling and production frame artwork outside implementation scope; consume the frame-pack contract defined in the approved design.
- Use a temporary HTTPS address without requiring a separately purchased domain.
- Do not add third-party analytics, remote error reporting, advertising, cloud object storage, user accounts, printing, or social-post automation.
- Follow the approved design in `docs/superpowers/specs/2026-08-10-umc-photo-booth-design.md`.

---

## File Structure

```text
.
├── assets/
│   ├── frame-packs/basic/          # Runnable neutral frame pack and manifest contract example
│   └── poses/poses.json            # Exactly six operator prompt strings
├── docs/
│   ├── operations.md               # Event setup, rehearsal, recovery, and shutdown runbook
│   └── superpowers/
│       ├── specs/2026-08-10-umc-photo-booth-design.md
│       └── plans/2026-08-10-umc-photo-booth.md
├── e2e/
│   ├── booth-flow.spec.ts          # Full capture-to-download browser flow
│   └── reset-and-expiry.spec.ts    # Reset isolation and expired-link behavior
├── scripts/
│   └── build-recipient.mjs         # Bundles recipient JS/CSS into one inline HTML document
├── src/
│   ├── operator/
│   │   ├── App.tsx                 # Phase routing and dependency composition
│   │   ├── main.tsx                # Operator browser entry
│   │   ├── booth-machine.ts        # Pure booth state and transition rules
│   │   ├── camera/
│   │   │   ├── camera-port.ts      # Browser camera boundary
│   │   │   └── capture-sequence.ts # Six-shot countdown orchestration
│   │   ├── components/
│   │   │   ├── CaptureScreen.tsx
│   │   │   ├── FrameScreen.tsx
│   │   │   ├── PreflightBar.tsx
│   │   │   ├── QrScreen.tsx
│   │   │   ├── ResetControl.tsx
│   │   │   ├── SelectionScreen.tsx
│   │   │   └── WelcomeScreen.tsx
│   │   ├── delivery/
│   │   │   ├── delivery-coordinator.ts
│   │   │   ├── issued-session-registry.ts
│   │   │   └── private-api-client.ts
│   │   └── frames/
│   │       ├── browser-compositor.ts
│   │       ├── frame-contract.ts
│   │       └── frame-repository.ts
│   ├── recipient/
│   │   ├── client.ts               # URL parsing, fetch, decrypt, render, save, CTA
│   │   ├── page.css                # Minimal functional layout for designer replacement
│   │   └── save-photo.ts           # Web Share and download fallback
│   ├── server/
│   │   ├── index.ts                # Event runtime entrypoint
│   │   ├── metrics.ts              # Aggregate-only counters
│   │   ├── private-server.ts       # Loopback operator/API listener
│   │   ├── public-server.ts        # Tunnel-facing read-only delivery listener
│   │   ├── runtime.ts              # Server, sweeper, tunnel, and shutdown lifecycle
│   │   ├── session-store.ts        # Atomic ciphertext and metadata lifecycle
│   │   ├── tunnel-supervisor.ts    # cloudflared process and URL health
│   │   └── types.ts                # Runtime dependency interfaces
│   └── shared/
│       ├── config.ts               # Validated runtime configuration
│       ├── contracts.ts            # Cross-module types and exact status values
│       ├── crypto-envelope.ts      # AES-GCM envelope and key fragment functions
│       └── public-token.ts         # Session ID and expiry URL token
├── tests/                           # Mirrors src paths with focused unit/integration tests
├── operator.html                    # Vite operator entry document
├── package.json
├── playwright.config.ts
├── tsconfig.json
├── vite.config.ts
└── vitest.setup.ts
```

## Shared Interfaces

These names are fixed for all tasks.

```ts
export type SessionStatus = "pending" | "active" | "expired";
export type BoothPhase =
  | "preflight"
  | "welcome"
  | "capturing"
  | "selecting"
  | "framing"
  | "delivering"
  | "qr"
  | "error";

export interface SessionRecord {
  id: string;
  createdAt: number;
  expiresAt: number | null;
  status: SessionStatus;
  encryptedFile: string;
}

export interface IssuedSession {
  id: string;
  publicToken: string;
  deliveryUrl: string;
  expiresAt: number;
}

export interface Clock {
  now(): number;
}
```

### Task 1: Establish the TypeScript workspace and validated configuration

**Files:**
- Modify: `.gitignore`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.setup.ts`
- Create: `operator.html`
- Create: `src/shared/contracts.ts`
- Create: `src/shared/config.ts`
- Test: `tests/shared/config.test.ts`

**Interfaces:**
- Consumes: runtime environment variables and the global constraints above.
- Produces: `AppConfig`, `loadConfig(env)`, `SessionRecord`, `IssuedSession`, `Clock`, `BoothPhase`.

- [ ] **Step 1: Write the failing configuration tests**

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/shared/config";

const validEnv = {
  NODE_ENV: "test",
  JOIN_SITE_URL:
    "https://join.example.test/apply?utm_source=club_fair&utm_medium=photo_booth",
  PRIVATE_PORT: "4173",
  PUBLIC_PORT: "4174",
  SESSION_DIR: "/tmp/umc-booth-test-sessions",
  FRAME_PACK_DIR: "assets/frame-packs/basic",
  POSE_CONFIG_PATH: "assets/poses/poses.json",
};

describe("loadConfig", () => {
  it("loads the exact booth runtime settings", () => {
    expect(loadConfig(validEnv)).toMatchObject({
      privatePort: 4173,
      publicPort: 4174,
      countdownSeconds: 5,
      captureCount: 6,
      selectedCount: 4,
      tunnelMode: "quick",
      localPublicBaseUrl: null,
      activeTtlMs: 600_000,
      pendingTtlMs: 120_000,
      sweepIntervalMs: 30_000,
      countdownTickMs: 1_000,
    });
  });

  it("rejects a non-HTTPS join URL", () => {
    expect(() =>
      loadConfig({ ...validEnv, JOIN_SITE_URL: "http://join.example.test" }),
    ).toThrow("JOIN_SITE_URL must use https");
  });

  it("rejects identical private and public ports", () => {
    expect(() => loadConfig({ ...validEnv, PUBLIC_PORT: "4173" })).toThrow(
      "PRIVATE_PORT and PUBLIC_PORT must differ",
    );
  });

  it("rejects local tunnel mode outside tests", () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        NODE_ENV: "production",
        TUNNEL_MODE: "local",
        LOCAL_PUBLIC_BASE_URL: "http://127.0.0.1:4174",
      }),
    ).toThrow("Local tunnel mode is test-only");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails because the workspace does not exist**

Run: `npm test -- tests/shared/config.test.ts`

Expected: FAIL because `package.json` or `src/shared/config.ts` is missing.

- [ ] **Step 3: Install the workspace dependencies and create the scripts**

Run:

```bash
npm init -y
npm install @fastify/static react react-dom fastify qrcode zod
npm install -D @playwright/test @testing-library/jest-dom @testing-library/react @testing-library/user-event @types/node @types/qrcode @types/react @types/react-dom @vitejs/plugin-react concurrently esbuild jsdom tsx typescript vite vitest
```

Set `package.json` scripts to these exact commands:

```json
{
  "scripts": {
    "dev": "concurrently -k \"vite\" \"tsx watch src/server/index.ts\"",
    "build": "npm run build:operator && npm run build:recipient && npm run typecheck",
    "build:operator": "vite build",
    "build:recipient": "node scripts/build-recipient.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "booth": "npm run build && tsx src/server/index.ts"
  }
}
```

Also set `"private": true`, `"type": "module"`, and `"engines": { "node": ">=22" }`. Configure Vite with the React plugin, `operator.html` as its only input, and `dist/operator` as `build.outDir`. `operator.html` contains only the root element and `<script type="module" src="/src/operator/main.tsx"></script>`. Configure Vitest for `jsdom`, globals, and `vitest.setup.ts`.

Extend `.gitignore` with:

```text
node_modules/
dist/
runtime-data/
playwright-report/
test-results/
.env
```

- [ ] **Step 4: Implement the fixed contracts and configuration parser**

```ts
// src/shared/config.ts
import { z } from "zod";

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  joinSiteUrl: string;
  privatePort: number;
  publicPort: number;
  sessionDir: string;
  framePackDir: string;
  poseConfigPath: string;
  tunnelMode: "quick" | "local";
  localPublicBaseUrl: string | null;
  countdownSeconds: 5;
  captureCount: 6;
  selectedCount: 4;
  activeTtlMs: number;
  pendingTtlMs: number;
  sweepIntervalMs: number;
  countdownTickMs: number;
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  JOIN_SITE_URL: z.string().url(),
  PRIVATE_PORT: z.coerce.number().int().min(1024).max(65_535).default(4173),
  PUBLIC_PORT: z.coerce.number().int().min(1024).max(65_535).default(4174),
  SESSION_DIR: z.string().min(1).default("runtime-data/sessions"),
  FRAME_PACK_DIR: z.string().min(1).default("assets/frame-packs/basic"),
  POSE_CONFIG_PATH: z.string().min(1).default("assets/poses/poses.json"),
  COUNTDOWN_TICK_MS: z.coerce.number().int().min(1).optional(),
  ACTIVE_TTL_MS: z.coerce.number().int().min(1).optional(),
  PENDING_TTL_MS: z.coerce.number().int().min(1).optional(),
  SWEEP_INTERVAL_MS: z.coerce.number().int().min(1).optional(),
  TUNNEL_MODE: z.enum(["quick", "local"]).default("quick"),
  LOCAL_PUBLIC_BASE_URL: z.string().url().optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = schema.parse(env);
  if (new URL(parsed.JOIN_SITE_URL).protocol !== "https:") {
    throw new Error("JOIN_SITE_URL must use https");
  }
  if (parsed.PRIVATE_PORT === parsed.PUBLIC_PORT) {
    throw new Error("PRIVATE_PORT and PUBLIC_PORT must differ");
  }
  const testOnly = parsed.NODE_ENV === "test";
  if (parsed.TUNNEL_MODE === "local" && !testOnly) {
    throw new Error("Local tunnel mode is test-only");
  }
  if (parsed.TUNNEL_MODE === "local" && !parsed.LOCAL_PUBLIC_BASE_URL) {
    throw new Error("LOCAL_PUBLIC_BASE_URL is required in local tunnel mode");
  }
  return {
    nodeEnv: parsed.NODE_ENV,
    joinSiteUrl: parsed.JOIN_SITE_URL,
    privatePort: parsed.PRIVATE_PORT,
    publicPort: parsed.PUBLIC_PORT,
    sessionDir: parsed.SESSION_DIR,
    framePackDir: parsed.FRAME_PACK_DIR,
    poseConfigPath: parsed.POSE_CONFIG_PATH,
    tunnelMode: parsed.TUNNEL_MODE,
    localPublicBaseUrl: parsed.LOCAL_PUBLIC_BASE_URL ?? null,
    countdownSeconds: 5,
    captureCount: 6,
    selectedCount: 4,
    activeTtlMs: testOnly ? (parsed.ACTIVE_TTL_MS ?? 600_000) : 600_000,
    pendingTtlMs: testOnly ? (parsed.PENDING_TTL_MS ?? 120_000) : 120_000,
    sweepIntervalMs: testOnly ? (parsed.SWEEP_INTERVAL_MS ?? 30_000) : 30_000,
    countdownTickMs: testOnly ? (parsed.COUNTDOWN_TICK_MS ?? 1_000) : 1_000,
  };
}
```

Copy the fixed shared interfaces from the plan's “Shared Interfaces” section into `src/shared/contracts.ts`. Configure TypeScript with `strict`, `noUncheckedIndexedAccess`, DOM libraries, JSX `react-jsx`, and ES modules. Configure Vitest to use `jsdom` and load `vitest.setup.ts`.

- [ ] **Step 5: Run checks and commit**

Run: `npm test -- tests/shared/config.test.ts && npm run typecheck`

Expected: all configuration tests PASS and TypeScript reports no errors.

```bash
git add .gitignore package.json package-lock.json tsconfig.json vite.config.ts vitest.setup.ts operator.html src/shared tests/shared
git commit -m "chore: establish photo booth workspace"
```

### Task 2: Implement the browser-compatible authenticated photo envelope

**Files:**
- Create: `src/shared/crypto-envelope.ts`
- Test: `tests/shared/crypto-envelope.test.ts`

**Interfaces:**
- Consumes: browser or Node Web Crypto `crypto.subtle`.
- Produces: `generatePhotoKey()`, `encryptPhoto()`, `decryptPhoto()`, `exportKeyFragment()`, `importKeyFragment()`.

- [ ] **Step 1: Write round-trip, uniqueness, and tamper tests**

```ts
import { describe, expect, it } from "vitest";
import {
  decryptPhoto,
  encryptPhoto,
  exportKeyFragment,
  generatePhotoKey,
  importKeyFragment,
} from "../../src/shared/crypto-envelope";

describe("photo crypto envelope", () => {
  it("round-trips JPEG bytes through an exported key", async () => {
    const source = new TextEncoder().encode("jpeg-fixture");
    const key = await generatePhotoKey();
    const envelope = await encryptPhoto(source, key);
    const restoredKey = await importKeyFragment(await exportKeyFragment(key));
    expect(await decryptPhoto(envelope, restoredKey)).toEqual(source);
  });

  it("uses a new nonce for every encryption", async () => {
    const key = await generatePhotoKey();
    const source = new Uint8Array([1, 2, 3]);
    expect(await encryptPhoto(source, key)).not.toEqual(await encryptPhoto(source, key));
  });

  it("rejects a modified ciphertext", async () => {
    const key = await generatePhotoKey();
    const envelope = await encryptPhoto(new Uint8Array([7, 8, 9]), key);
    envelope[envelope.length - 1] ^= 1;
    await expect(decryptPhoto(envelope, key)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `npm test -- tests/shared/crypto-envelope.test.ts`

Expected: FAIL because `crypto-envelope.ts` does not exist.

- [ ] **Step 3: Implement the exact envelope format**

Use four ASCII magic bytes `UMC1`, followed by the 12-byte nonce, followed by the AES-GCM ciphertext and 128-bit authentication tag returned by Web Crypto.

```ts
const MAGIC = new TextEncoder().encode("UMC1");
const NONCE_BYTES = 12;

export async function generatePhotoKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptPhoto(
  plain: Uint8Array,
  key: CryptoKey,
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain),
  );
  const envelope = new Uint8Array(MAGIC.length + nonce.length + ciphertext.length);
  envelope.set(MAGIC, 0);
  envelope.set(nonce, MAGIC.length);
  envelope.set(ciphertext, MAGIC.length + nonce.length);
  return envelope;
}

export async function decryptPhoto(
  envelope: Uint8Array,
  key: CryptoKey,
): Promise<Uint8Array> {
  if (envelope.length <= MAGIC.length + NONCE_BYTES) throw new Error("Invalid envelope");
  if (!MAGIC.every((byte, index) => envelope[index] === byte)) {
    throw new Error("Unsupported envelope version");
  }
  const nonce = envelope.slice(MAGIC.length, MAGIC.length + NONCE_BYTES);
  const ciphertext = envelope.slice(MAGIC.length + NONCE_BYTES);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext),
  );
}
```

Encode raw exported key bytes with browser-safe base64url helpers built from `btoa` and `atob`. Reject fragments that do not decode to exactly 32 bytes before calling `crypto.subtle.importKey`.

- [ ] **Step 4: Run the crypto and full unit suites**

Run: `npm test -- tests/shared/crypto-envelope.test.ts && npm test`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/crypto-envelope.ts tests/shared/crypto-envelope.test.ts
git commit -m "feat: add authenticated photo envelope"
```

### Task 3: Build the atomic pending-active-expired session store

**Files:**
- Create: `src/shared/public-token.ts`
- Create: `src/server/session-store.ts`
- Test: `tests/shared/public-token.test.ts`
- Test: `tests/server/session-store.test.ts`

**Interfaces:**
- Consumes: `SessionRecord`, `Clock`, ciphertext bytes, active/pending TTLs.
- Produces: `FileSessionStore.createPending()`, `activate()`, `inspect()`, `readActive()`, `deletePending()`, `sweep()`, `purgeAll()`, `stats()`.

```ts
export type SessionLookup =
  | { kind: "active"; record: SessionRecord; bytes: Uint8Array }
  | { kind: "gone" }
  | { kind: "not-found" };

export interface SessionStats {
  pending: number;
  active: number;
  encryptedBytes: number;
  lastSweepAt: number | null;
}
```

- [ ] **Step 1: Write lifecycle tests using a dedicated temporary directory**

```ts
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSessionStore } from "../../src/server/session-store";

describe("FileSessionStore", () => {
  it("keeps pending sessions private, activates for ten minutes, then returns gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-store-"));
    let now = 1_000;
    const store = new FileSessionStore({
      root,
      clock: { now: () => now },
      activeTtlMs: 600_000,
      pendingTtlMs: 120_000,
    });
    await store.initialize();

    const pending = await store.createPending(new Uint8Array([1, 2, 3]));
    expect((await store.inspectById(pending.id)).status).toBe("pending");

    const active = await store.activate(pending.id);
    expect(active.expiresAt).toBe(601_000);
    expect((await store.readActive(active.publicToken)).kind).toBe("active");

    now = 601_000;
    expect((await store.readActive(active.publicToken)).kind).toBe("gone");
    await store.sweep();
    expect(await readdir(root)).toEqual([]);
  });

  it("removes unactivated sessions after two minutes", async () => {
    const root = await mkdtemp(join(tmpdir(), "umc-pending-"));
    let now = 10;
    const store = new FileSessionStore({
      root,
      clock: { now: () => now },
      activeTtlMs: 600_000,
      pendingTtlMs: 120_000,
    });
    await store.initialize();
    await store.createPending(new Uint8Array([4]));
    now = 120_010;
    await store.sweep();
    expect(await readdir(root)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the store tests and confirm they fail**

Run: `npm test -- tests/server/session-store.test.ts tests/shared/public-token.test.ts`

Expected: FAIL because the store and token modules are missing.

- [ ] **Step 3: Implement safe public tokens and atomic storage**

Use the public token format `<expiresAt-base36>.<128-bit-session-id-base64url>`. `parsePublicToken()` validates both parts and returns `{ id, expiresAt }`. The expiry hint permits a deleted link to return `gone` without retaining a tombstone; an active record must still match the token expiry exactly.

Store each session as `${id}.bin` and `${id}.json`. Write each file to an id-scoped `.tmp` path and `rename()` it into place so a crash cannot expose a partial record. Generate IDs with 16 random bytes. Never accept a caller-provided filesystem name.

```ts
export class FileSessionStore {
  async createPending(bytes: Uint8Array): Promise<{ id: string; createdAt: number }>;
  async activate(id: string): Promise<{
    id: string;
    publicToken: string;
    expiresAt: number;
  }>;
  async inspectById(id: string): Promise<SessionRecord>;
  async readActive(publicToken: string): Promise<SessionLookup>;
  async deletePending(id: string): Promise<boolean>;
  async sweep(): Promise<{ deletedPending: number; deletedExpired: number }>;
  async purgeAll(): Promise<number>;
  async stats(): Promise<SessionStats>;
}
```

`readActive()` follows this order: parse token; return `gone` when the token expiry is at or before `clock.now()`; read metadata; return `not-found` if absent; reject expiry mismatch; return `not-found` for pending; otherwise return ciphertext. `sweep()` deletes both files for expired active records and old pending records and updates `lastSweepAt`.

- [ ] **Step 4: Run lifecycle tests, then inspect the temp file contents**

Run: `npm test -- tests/server/session-store.test.ts tests/shared/public-token.test.ts`

Expected: PASS. The test must additionally read every `.bin` file before expiry and assert it equals only the supplied ciphertext bytes, never JPEG fixture plaintext.

- [ ] **Step 5: Commit**

```bash
git add src/shared/public-token.ts src/server/session-store.ts tests/shared/public-token.test.ts tests/server/session-store.test.ts
git commit -m "feat: add expiring ciphertext session store"
```

### Task 4: Expose separate private and public HTTP surfaces

**Files:**
- Create: `src/server/types.ts`
- Create: `src/server/metrics.ts`
- Create: `src/server/private-server.ts`
- Create: `src/server/public-server.ts`
- Test: `tests/server/private-server.test.ts`
- Test: `tests/server/public-server.test.ts`
- Test: `tests/server/private-static-assets.test.ts`

**Interfaces:**
- Consumes: `FileSessionStore`, `AppConfig`, prebuilt recipient HTML, `RuntimeStatusProvider`.
- Produces: `buildPrivateServer(deps)`, `buildPublicServer(deps)`, `AggregateMetrics`.

```ts
export interface RuntimeStatus {
  tunnel: "starting" | "healthy" | "down";
  publicUrl: string | null;
  publicLatencyMs: number | null;
  lastSweepAt: number | null;
  pendingSessions: number;
  activeSessions: number;
  encryptedBytes: number;
  acceptingCaptures: boolean;
}

export interface RuntimeStatusProvider {
  getStatus(): Promise<RuntimeStatus>;
  requestShutdown(): Promise<void>;
}
```

- [ ] **Step 1: Write Fastify injection tests for route isolation and headers**

```ts
it("never exposes private mutation routes on the public listener", async () => {
  const response = await publicApp.inject({
    method: "POST",
    url: "/api/sessions",
    payload: Buffer.from([1, 2]),
  });
  expect(response.statusCode).toBe(404);
});

it("stores ciphertext only through the private listener", async () => {
  const response = await privateApp.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from([9, 8, 7]),
  });
  expect(response.statusCode).toBe(201);
  expect(response.json()).toEqual({ id: expect.any(String), createdAt: expect.any(Number) });
});

it("returns no-store ciphertext and 410 at expiry", async () => {
  const activeResponse = await publicApp.inject({ method: "GET", url: `/f/${token}` });
  expect(activeResponse.headers["cache-control"]).toBe("no-store");
  expect(activeResponse.headers["content-type"]).toContain("application/octet-stream");
  clock.advanceTo(expiresAt);
  expect((await publicApp.inject({ method: "GET", url: `/f/${token}` })).statusCode).toBe(410);
});
```

- [ ] **Step 2: Run the HTTP tests and verify missing-module failures**

Run: `npm test -- tests/server/private-server.test.ts tests/server/public-server.test.ts`

Expected: FAIL because neither server factory exists.

- [ ] **Step 3: Implement the private surface**

Bind later at runtime to `127.0.0.1` only. Configure Fastify with logging disabled and a 12 MiB body limit. Implement:

```text
GET    /api/status
POST   /api/sessions
POST   /api/sessions/:id/activate
DELETE /api/sessions/:id
POST   /api/shutdown   body: { "confirm": "DELETE_ALL" }
```

Register an `application/octet-stream` content parser that returns a `Buffer`. Reject other session body types with `415` and reject payloads above 12 MiB. Reject active-session deletion with `409`; deleting a missing or already-removed pending ID is idempotent and returns `204`. Return `400` for any shutdown body other than the exact confirmation value. The shutdown handler sends `202` before scheduling `requestShutdown()` on the next event-loop turn.

- [ ] **Step 4: Implement the public surface and aggregate-only events**

Register `@fastify/static` only on the private server. Serve the operator build at `/`, the configured frame-pack directory beneath `/frame-pack/`, and the configured six-prompt JSON at `/poses.json`. Use separate static prefixes without sharing reply decorators, disable directory listings, dotfiles, and fallthrough, and test that `..` traversal and unrelated filesystem paths return 404.

Implement only these routes on the public surface:

```text
GET  /health
GET  /d/:token
GET  /f/:token
POST /events  body event ∈ decrypt_success | save_intent | join_click
```

Set these headers on `/d` and `/f`:

```ts
reply.headers({
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'self'",
});
```

`AggregateMetrics.record(event)` increments only one of the three fixed counters, stores no request fields, and drops events once more than 10 were accepted in the same wall-clock second. `/d` and `/f` increment page and download counters directly. Do not read `CF-Connecting-IP`, `X-Forwarded-For`, user agent, referrer, or cookie headers.

- [ ] **Step 5: Run all server tests and commit**

Run: `npm test -- tests/server`

Expected: PASS, including explicit assertions that unknown routes are 404, forbidden methods are 405 or 404, and response bodies never echo session URLs or request headers.

```bash
git add src/server/types.ts src/server/metrics.ts src/server/private-server.ts src/server/public-server.ts tests/server/private-server.test.ts tests/server/public-server.test.ts
git commit -m "feat: separate private and public server surfaces"
```

### Task 5: Define frame packs and build the browser compositor

**Files:**
- Create: `src/operator/frames/frame-contract.ts`
- Create: `src/operator/frames/frame-repository.ts`
- Create: `src/operator/frames/browser-compositor.ts`
- Create: `assets/frame-packs/basic/manifest.json`
- Create: `assets/frame-packs/basic/overlay.svg`
- Create: `assets/poses/poses.json`
- Create: `docs/frame-pack.md`
- Test: `tests/operator/frames/frame-contract.test.ts`
- Test: `tests/operator/frames/browser-compositor.test.ts`

**Interfaces:**
- Consumes: exactly four ordered JPEG `Blob` objects and a validated frame manifest.
- Produces: `FrameManifest`, `loadFramePack(baseUrl)`, `BrowserCompositor.compose()`.

```ts
export interface PhotoSlot {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  fit: "cover";
}

export interface FrameManifest {
  id: string;
  label: string;
  canvas: { width: number; height: number };
  jpegQuality: number;
  thumbnail: string;
  overlay: string;
  slots: [PhotoSlot, PhotoSlot, PhotoSlot, PhotoSlot];
}
```

- [ ] **Step 1: Write schema and ordered-draw tests**

```ts
it("rejects any frame that does not have exactly four slots", () => {
  expect(() => parseFrameManifest({ ...validFrame, slots: validFrame.slots.slice(0, 3) })).toThrow(
    "Frame requires exactly four slots",
  );
});

it("draws photos in selection order before the overlay", async () => {
  const port = new RecordingCanvasPort();
  const compositor = new BrowserCompositor(port);
  await compositor.compose({ photos: [p1, p2, p3, p4], frame: validFrame });
  expect(port.operations.map((operation) => operation.source)).toEqual([
    "photo-1",
    "photo-2",
    "photo-3",
    "photo-4",
    "overlay",
  ]);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- tests/operator/frames`

Expected: FAIL because the frame modules do not exist.

- [ ] **Step 3: Implement validation and a runnable neutral frame pack**

Use Zod to enforce positive canvas and slot dimensions, `jpegQuality` from 0.5 through 1, and exactly four slots. The checked-in `basic` pack uses a 1200×1800 canvas, a 2×2 grid with four 540×720 photo slots, quality 0.92, and a neutral SVG overlay labeled `UMC PHOTO BOOTH`. It is an operational fixture, not the production visual design.

Create `assets/poses/poses.json` as an array of these six functional prompts:

```json
[
  "팀의 첫 아이디어",
  "코드가 한 번에 실행됐을 때",
  "버그를 발견했을 때",
  "함께 해결책을 찾을 때",
  "배포가 완료됐을 때",
  "우리 팀의 엔딩 포즈"
]
```

Document in `docs/frame-pack.md` how a designer duplicates the basic pack, chooses a unique ID, supplies thumbnail and overlay files, measures four slot rectangles in final-canvas pixels, validates the pack with the test command, and previews it locally. State that the overlay must not include a participant-specific QR or personal data; stable club identity and application-site branding are allowed.

- [ ] **Step 4: Implement compositing behind a testable canvas port**

`BrowserCompositor.compose({ photos, frame })` rejects arrays whose length is not four, creates a canvas at the manifest size, draws each image with cover-cropping into its corresponding slot, applies slot rotation around the slot center, draws the overlay last, and resolves a JPEG `Blob` using `frame.jpegQuality`. Revoke every temporary image object URL in `finally`.

- [ ] **Step 5: Run tests, validate assets, and commit**

Run: `npm test -- tests/operator/frames && npm run typecheck`

Expected: all frame tests PASS and the repository loader accepts the `basic` manifest.

```bash
git add src/operator/frames assets/frame-packs/basic assets/poses docs/frame-pack.md tests/operator/frames
git commit -m "feat: add configurable four-photo frame compositor"
```

### Task 6: Implement the pure booth state machine and stale-result protection

**Files:**
- Create: `src/operator/booth-machine.ts`
- Test: `tests/operator/booth-machine.test.ts`

**Interfaces:**
- Consumes: capture IDs, frame IDs, issued session values, and generation-tagged async results.
- Produces: `BoothState`, `BoothEvent`, `initialBoothState()`, `boothReducer()`.

```ts
export interface CapturedPhoto {
  id: string;
  blob: Blob;
  previewUrl: string;
}

export interface BoothState {
  phase: BoothPhase;
  generation: number;
  photos: CapturedPhoto[];
  selectedIds: string[];
  selectedFrameId: string | null;
  pendingSessionId: string | null;
  issuedSession: IssuedSession | null;
  errorMessage: string | null;
}
```

- [ ] **Step 1: Write transition tests for six captures, ordered selection, and reset**

```ts
it("moves to selection only after six photos", () => {
  let state = capturingState();
  for (let index = 0; index < 5; index += 1) {
    state = boothReducer(state, photoCaptured(index, state.generation));
    expect(state.phase).toBe("capturing");
  }
  state = boothReducer(state, photoCaptured(5, state.generation));
  expect(state.phase).toBe("selecting");
});

it("uses click order and renumbers after deselection", () => {
  let state = selectingStateWithSixPhotos();
  state = boothReducer(state, { type: "PHOTO_TOGGLED", id: "p4" });
  state = boothReducer(state, { type: "PHOTO_TOGGLED", id: "p1" });
  state = boothReducer(state, { type: "PHOTO_TOGGLED", id: "p6" });
  state = boothReducer(state, { type: "PHOTO_TOGGLED", id: "p1" });
  expect(state.selectedIds).toEqual(["p4", "p6"]);
});

it("ignores an async result from before reset", () => {
  const reset = boothReducer(deliveringState(4), { type: "RESET_CONFIRMED" });
  const stale = boothReducer(reset, { type: "DELIVERY_SUCCEEDED", generation: 4, issued: issuedSession });
  expect(stale.phase).toBe("preflight");
  expect(stale.issuedSession).toBeNull();
});
```

- [ ] **Step 2: Run the reducer tests and confirm failure**

Run: `npm test -- tests/operator/booth-machine.test.ts`

Expected: FAIL because `booth-machine.ts` is missing.

- [ ] **Step 3: Implement the reducer with explicit guards**

Use discriminated events. Reject a seventh capture, a fifth selected ID, frame confirmation before four selections, and delivery results whose `generation` does not equal state generation. `DELIVERY_SUCCEEDED` moves to `qr` while clearing `photos`, `selectedIds`, `selectedFrameId`, and `pendingSessionId` from reducer state. `RESET_CONFIRMED` increments generation, returns to `preflight`, and clears all current-session fields. Keep issued-session retention outside the reducer in `IssuedSessionRegistry` so resetting the current screen cannot delete older ciphertext.

- [ ] **Step 4: Run reducer tests and typecheck**

Run: `npm test -- tests/operator/booth-machine.test.ts && npm run typecheck`

Expected: PASS with exhaustive event handling enforced by a `never` assertion.

- [ ] **Step 5: Commit**

```bash
git add src/operator/booth-machine.ts tests/operator/booth-machine.test.ts
git commit -m "feat: define safe booth state transitions"
```

### Task 7: Implement the six-shot camera and five-second countdown

**Files:**
- Create: `src/operator/camera/camera-port.ts`
- Create: `src/operator/camera/capture-sequence.ts`
- Create: `src/operator/components/CaptureScreen.tsx`
- Test: `tests/operator/camera/capture-sequence.test.ts`
- Test: `tests/operator/components/CaptureScreen.test.tsx`

**Interfaces:**
- Consumes: a `CameraPort`, abort signal, six pose prompts, and `generation`.
- Produces: six `CapturedPhoto` values and countdown/progress callbacks.

```ts
export interface CameraPort {
  probe(): Promise<boolean>;
  start(video: HTMLVideoElement): Promise<void>;
  capture(): Promise<Blob>;
  stop(): void;
}

export interface CaptureSequenceOptions {
  camera: CameraPort;
  prompts: [string, string, string, string, string, string];
  signal: AbortSignal;
  tickMs: number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  onCountdown(value: 5 | 4 | 3 | 2 | 1, shotIndex: number): void;
  onCaptured(photo: Blob, shotIndex: number): void;
  onRetry(shotIndex: number): void;
}
```

- [ ] **Step 1: Write fake-clock sequence tests**

```ts
it("counts five to one before each of six successful captures", async () => {
  const countdowns: Array<[number, number]> = [];
  const captures: number[] = [];
  await runCaptureSequence({
    camera: successfulCamera,
    prompts,
    signal: new AbortController().signal,
    sleep: async () => undefined,
    onCountdown: (value, shot) => countdowns.push([shot, value]),
    onCaptured: (_blob, shot) => captures.push(shot),
    onRetry: () => undefined,
  });
  expect(countdowns).toHaveLength(30);
  expect(countdowns.slice(0, 5)).toEqual([[0, 5], [0, 4], [0, 3], [0, 2], [0, 1]]);
  expect(captures).toEqual([0, 1, 2, 3, 4, 5]);
});

it("repeats only the failed shot", async () => {
  const camera = cameraFailingOnceAtShot(2);
  const retried: number[] = [];
  await runCaptureSequence({ ...baseOptions(camera), onRetry: (shot) => retried.push(shot) });
  expect(retried).toEqual([2]);
  expect(camera.successfulShotIndexes).toEqual([0, 1, 2, 3, 4, 5]);
});
```

- [ ] **Step 2: Run the camera tests and verify missing-module failure**

Run: `npm test -- tests/operator/camera tests/operator/components/CaptureScreen.test.tsx`

Expected: FAIL because camera modules and component are missing.

- [ ] **Step 3: Implement the browser camera boundary**

`BrowserCameraPort.probe()` obtains the same media stream, confirms a live video track, and immediately stops it. `start()` calls `navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })`, assigns the stream to the video element, and waits for `loadedmetadata`. `capture()` draws the current frame to a canvas using the same horizontal orientation shown in the preview and exports JPEG quality 0.92. `stop()` stops every media track and clears the video source.

- [ ] **Step 4: Implement the abortable capture loop and screen**

For each shot index 0–5, display its prompt, emit 5–1 at `tickMs` intervals, then capture. Production passes 1,000 ms; test mode may pass 10 ms. If capture rejects, emit `onRetry(index)` and restart the same shot at five. Every wait and capture completion checks `signal.aborted`. `CaptureScreen` shows the prompt, `current / 6`, live preview, and the current countdown; it exposes no delete or navigation control other than the global reset.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- tests/operator/camera tests/operator/components/CaptureScreen.test.tsx`

Expected: PASS, including abort during countdown and abort after capture resolution.

```bash
git add src/operator/camera src/operator/components/CaptureScreen.tsx tests/operator/camera tests/operator/components/CaptureScreen.test.tsx
git commit -m "feat: add six-shot countdown capture"
```

### Task 8: Build photo selection, frame choice, and the minimal reset modal

**Files:**
- Create: `src/operator/components/SelectionScreen.tsx`
- Create: `src/operator/components/FrameScreen.tsx`
- Create: `src/operator/components/ResetControl.tsx`
- Test: `tests/operator/components/SelectionScreen.test.tsx`
- Test: `tests/operator/components/FrameScreen.test.tsx`
- Test: `tests/operator/components/ResetControl.test.tsx`

**Interfaces:**
- Consumes: `BoothState`, validated `FrameManifest[]`, dispatcher callbacks.
- Produces: ordered selection events, frame confirmation, reset confirmation.

- [ ] **Step 1: Write interaction tests with the exact Korean copy**

```tsx
it("enables continuation only after four ordered selections", async () => {
  render(<SelectionScreen photos={sixPhotos} selectedIds={[]} onToggle={onToggle} onContinue={onContinue} />);
  expect(screen.getByRole("button", { name: "프레임 선택하기" })).toBeDisabled();
  await user.click(screen.getByAltText("촬영 사진 4"));
  await user.click(screen.getByAltText("촬영 사진 1"));
  await user.click(screen.getByAltText("촬영 사진 6"));
  await user.click(screen.getByAltText("촬영 사진 3"));
  expect(onToggle.mock.calls.map(([id]) => id)).toEqual(["p4", "p1", "p6", "p3"]);
});

it("renders only the approved reset question and buttons", async () => {
  render(<ResetControl onConfirm={onConfirm} />);
  await user.click(screen.getByRole("button", { name: "처음으로" }));
  expect(screen.getByText("처음 화면으로 돌아갈까요?")).toBeVisible();
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
    "처음으로",
    "취소",
    "확인",
  ]);
  expect(screen.queryByText(/삭제|되돌릴 수/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run component tests and confirm failure**

Run: `npm test -- tests/operator/components/SelectionScreen.test.tsx tests/operator/components/FrameScreen.test.tsx tests/operator/components/ResetControl.test.tsx`

Expected: FAIL because the components are missing.

- [ ] **Step 3: Implement selection and frame screens**

`SelectionScreen` renders six thumbnails, overlays 1–4 badges from `selectedIds`, prevents a fifth selection, exposes `선택 초기화`, and enables `프레임 선택하기` only at four. `FrameScreen` preserves the same ordered IDs, renders every validated frame with a preview, and emits confirmation only after one frame is selected.

- [ ] **Step 4: Implement the global reset control**

Keep `ResetControl` position styling in a single component so every phase uses the same upper-right placement. First click opens the exact minimal modal. `취소` only closes the modal. `확인` closes it and calls `onConfirm()` once. Focus moves into the dialog, Escape behaves as cancel, and focus returns to `처음으로` after cancellation.

- [ ] **Step 5: Run accessibility-focused tests and commit**

Run: `npm test -- tests/operator/components`

Expected: PASS, including keyboard selection, modal focus, and exact-copy assertions.

```bash
git add src/operator/components/SelectionScreen.tsx src/operator/components/FrameScreen.tsx src/operator/components/ResetControl.tsx tests/operator/components
git commit -m "feat: add selection frame and reset interactions"
```

### Task 9: Coordinate encryption, activation, QR creation, and reissue

**Files:**
- Create: `src/operator/delivery/private-api-client.ts`
- Create: `src/operator/delivery/issued-session-registry.ts`
- Create: `src/operator/delivery/delivery-coordinator.ts`
- Create: `src/operator/components/QrScreen.tsx`
- Test: `tests/operator/delivery/delivery-coordinator.test.ts`
- Test: `tests/operator/delivery/issued-session-registry.test.ts`
- Test: `tests/operator/components/QrScreen.test.tsx`

**Interfaces:**
- Consumes: final JPEG blob, private session API, current public base URL, `generation`, abort signal.
- Produces: `IssuedSession`, QR data URL, in-memory key registry for active reissue.

```ts
export interface PrivateApiClient {
  createPending(ciphertext: Uint8Array, signal: AbortSignal): Promise<{ id: string }>;
  activate(id: string, signal: AbortSignal): Promise<{ publicToken: string; expiresAt: number }>;
  deletePending(id: string): Promise<void>;
}

export interface DeliveryCoordinator {
  issue(input: {
    jpeg: Blob;
    publicBaseUrl: string;
    generation: number;
    signal: AbortSignal;
  }): Promise<IssuedSession>;
}

export interface IssuedSessionRegistry {
  add(issued: IssuedSession, keyFragment: string): void;
  reissueAll(newPublicBaseUrl: string): IssuedSession[];
  prune(now: number): number;
  activeCount(): number;
}
```

- [ ] **Step 1: Write tests for key isolation, retry, abort, and URL reissue**

```ts
it("keeps the key in the URL fragment and never sends it to the private API", async () => {
  const issued = await coordinator.issue(validIssueInput);
  expect(issued.deliveryUrl).toMatch(/^https:\/\/[^/]+\/d\//);
  expect(issued.deliveryUrl).toContain("#key=");
  expect(JSON.stringify(api.calls)).not.toContain(issued.deliveryUrl.split("#key=")[1]);
});

it("tries three times with one and two second backoff", async () => {
  api.failCreateCount = 2;
  await coordinator.issue(validIssueInput);
  expect(api.createAttempts).toBe(3);
  expect(fakeSleeper.delays).toEqual([1_000, 2_000]);
});

it("deletes pending ciphertext when reset aborts before activation", async () => {
  api.pauseOnActivate = true;
  const promise = coordinator.issue(validIssueInput);
  abortController.abort();
  await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  expect(api.deletedPendingIds).toEqual([api.createdId]);
});
```

- [ ] **Step 2: Run delivery tests and confirm failure**

Run: `npm test -- tests/operator/delivery tests/operator/components/QrScreen.test.tsx`

Expected: FAIL because delivery modules are missing.

- [ ] **Step 3: Implement the two-phase delivery coordinator**

Read the JPEG into bytes, generate a photo key, encrypt, create a pending server session, prepare the public token returned by activation, and construct:

```ts
const deliveryUrl = `${publicBaseUrl}/d/${publicToken}#key=${keyFragment}`;
```

Only return success after activation. Perform at most three attempts for encryption/create/activate using 0, 1,000, and 2,000 ms starts. If any attempt fails after pending creation but before activation, delete that pending ID before starting the next attempt. If an abort or terminal failure happens after pending creation, call `deletePending(id)`. After activation, call `registry.add(issuedSession, keyFragment)` before returning `IssuedSession`. Never send `keyFragment` to an API or logger.

- [ ] **Step 4: Implement active key retention and QR reissue**

`IssuedSessionRegistry` stores `{ issued, keyFragment }` in a JavaScript `Map` until `expiresAt`, never in Web Storage. `reissueAll(newPublicBaseUrl)` rebuilds URLs with the same token and key after a tunnel URL change. A 30-second prune timer removes expired entries. `QrScreen` uses `qrcode.toDataURL(deliveryUrl, { errorCorrectionLevel: "M" })`, displays remaining `mm:ss`, and shows `팀원 모두 각자 스캔할 수 있습니다`.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- tests/operator/delivery tests/operator/components/QrScreen.test.tsx`

Expected: PASS, including the guarantee that reset after activation leaves the issued registry entry intact.

```bash
git add src/operator/delivery src/operator/components/QrScreen.tsx tests/operator/delivery tests/operator/components/QrScreen.test.tsx
git commit -m "feat: issue encrypted multi-device QR sessions"
```

### Task 10: Build the inline mobile decrypt, save, and application CTA page

**Files:**
- Create: `src/recipient/client.ts`
- Create: `src/recipient/page.css`
- Create: `src/recipient/save-photo.ts`
- Create: `scripts/build-recipient.mjs`
- Modify: `src/server/public-server.ts`
- Test: `tests/recipient/client.test.ts`
- Test: `tests/recipient/save-photo.test.ts`
- Test: `tests/server/recipient-page.test.ts`

**Interfaces:**
- Consumes: token in pathname, key in URL fragment, `/f/:token`, `/events`, configured join URL embedded in page.
- Produces: one self-contained `dist/recipient/index.html`, decrypted JPEG preview, save action, delayed CTA.

- [ ] **Step 1: Write client tests for decryption and CTA gating**

```ts
it("fetches ciphertext without sending the key and reveals CTA after save intent", async () => {
  locationHarness.set("https://booth.test/d/token-value#key=secret-fragment");
  fetchMock.mockResolvedValueOnce(ciphertextResponse).mockResolvedValue(eventResponse);
  await bootstrapRecipientPage(document, recipientDeps);
  expect(fetchMock.mock.calls[0][0]).toBe("/f/token-value");
  expect(fetchMock.mock.calls[0][0]).not.toContain("secret-fragment");
  expect(screen.getByAltText("완성된 네컷 사진")).toBeVisible();
  expect(screen.queryByRole("link", { name: "지원 페이지 보기" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "사진 저장하기" }));
  expect(screen.getByRole("link", { name: "지원 페이지 보기" })).toBeVisible();
});

it("shows deletion-complete state for 410", async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 410 }));
  await bootstrapRecipientPage(document, recipientDeps);
  expect(screen.getByText("사진이 자동 삭제되었습니다")).toBeVisible();
});
```

- [ ] **Step 2: Run recipient tests and verify failure**

Run: `npm test -- tests/recipient tests/server/recipient-page.test.ts`

Expected: FAIL because the recipient client and inline build do not exist.

- [ ] **Step 3: Implement decrypt and save behavior**

Parse exactly one `#key=` value, import it through `importKeyFragment()`, fetch `/f/:token` with `cache: "no-store"`, decrypt, create a JPEG blob URL, and render a preview. Send only one of the fixed aggregate event names with a JSON body that contains no token.

`savePhoto(blob, filename)` uses `navigator.canShare({ files: [file] })` and `navigator.share()` when available. Otherwise it creates a temporary anchor with `download="umc-photo-booth.jpg"`, clicks it, and revokes the object URL after the event loop. Treat invoking either route as `save_intent`; do not claim that the operating system completed the save.

- [ ] **Step 4: Bundle all recipient assets inline**

Use esbuild with `bundle: true`, `format: "iife"`, `platform: "browser"`, and `write: false`. Read `page.css`, escape `</script` in bundled JavaScript, and write one `dist/recipient/index.html` containing inline CSS and JS. Place an exact `__JOIN_CONFIG_SCRIPT__` marker immediately before the client script. The document contains no remote fonts, scripts, images, or styles.

Modify `buildPublicServer()` to load this HTML at startup and inject the join URL with this exact escaping:

```ts
const serializedJoinUrl = JSON.stringify(config.joinSiteUrl).replaceAll("<", "\\u003c");
const joinConfigScript = `<script>window.__UMC_JOIN_SITE_URL__=${serializedJoinUrl}</script>`;
const recipientHtml = template.replace("__JOIN_CONFIG_SCRIPT__", joinConfigScript);
```

`client.ts` reads this fixed global and rejects it unless it is HTTPS. Serve the resulting page only after `store.readActive(token)` confirms the session is active. The key remains unavailable to the server.

- [ ] **Step 5: Build, test, and commit**

Run: `npm run build:recipient && npm test -- tests/recipient tests/server/recipient-page.test.ts`

Expected: PASS. `dist/recipient/index.html` contains no `src=` or `href=` reference to a remote origin and contains no literal test key.

```bash
git add src/recipient scripts/build-recipient.mjs src/server/public-server.ts tests/recipient tests/server/recipient-page.test.ts
git commit -m "feat: add private mobile photo delivery page"
```

### Task 11: Supervise cloudflared and expose health-driven preflight

**Files:**
- Create: `src/server/tunnel-supervisor.ts`
- Create: `src/operator/components/PreflightBar.tsx`
- Test: `tests/server/tunnel-supervisor.test.ts`
- Test: `tests/operator/components/PreflightBar.test.tsx`

**Interfaces:**
- Consumes: public loopback URL, child-process adapter, fetch adapter, clock/timer adapter.
- Produces: `TunnelSupervisor.start()`, `stop()`, `status()`, `onUrlChange()`.

```ts
export interface TunnelStatus {
  state: "starting" | "healthy" | "down";
  publicUrl: string | null;
  latencyMs: number | null;
  error: "missing-binary" | "process-exit" | "health-failed" | null;
}
```

- [ ] **Step 1: Write parser, health, restart, and stop tests**

```ts
it("extracts only an HTTPS trycloudflare URL", () => {
  expect(parseQuickTunnelUrl("Visit https://calm-river.trycloudflare.com now")).toBe(
    "https://calm-river.trycloudflare.com",
  );
  expect(parseQuickTunnelUrl("http://unsafe.example.test")).toBeNull();
});

it("publishes a URL only after public health succeeds", async () => {
  const supervisor = createHarness();
  const start = supervisor.start("http://127.0.0.1:4174");
  supervisor.child.emitLine("https://calm-river.trycloudflare.com");
  expect(supervisor.status().publicUrl).toBeNull();
  supervisor.fetch.resolve(new Response("ok"));
  await start;
  expect(supervisor.status()).toMatchObject({ state: "healthy", publicUrl: "https://calm-river.trycloudflare.com" });
});
```

- [ ] **Step 2: Run tunnel tests and verify failure**

Run: `npm test -- tests/server/tunnel-supervisor.test.ts tests/operator/components/PreflightBar.test.tsx`

Expected: FAIL because the supervisor and status bar are missing.

- [ ] **Step 3: Implement the cloudflared process boundary**

Spawn exactly:

```ts
spawn("cloudflared", [
  "tunnel",
  "--no-autoupdate",
  "--url",
  `http://127.0.0.1:${publicPort}`,
]);
```

Parse stdout and stderr line-by-line, accept only `https://*.trycloudflare.com`, and probe `<url>/health` with a five-second timeout. On process exit or health failure, publish `down`, disable capture, and restart after 1, 2, then 5 seconds; subsequent attempts remain capped at five seconds until stopped. If spawning returns `ENOENT`, publish `missing-binary` and do not busy-loop.

- [ ] **Step 4: Implement the operator preflight presentation**

`PreflightBar` shows camera, tunnel, cleanup, active ciphertext count, and public latency without any thumbnails. It exposes a boolean `ready` only when camera is ready, tunnel is healthy, a sweep succeeded within 60 seconds, the frame pack is valid, six poses loaded, and the join URL passed configuration. `WelcomeScreen` disables `체험 시작` until `ready` is true.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- tests/server/tunnel-supervisor.test.ts tests/operator/components/PreflightBar.test.tsx`

Expected: PASS, including a URL-change callback used by `IssuedSessionRegistry.reissueAll()`.

```bash
git add src/server/tunnel-supervisor.ts src/operator/components/PreflightBar.tsx tests/server/tunnel-supervisor.test.ts tests/operator/components/PreflightBar.test.tsx
git commit -m "feat: supervise temporary HTTPS tunnel"
```

### Task 12: Integrate the complete operator application and reset cleanup

**Files:**
- Create: `src/operator/main.tsx`
- Create: `src/operator/App.tsx`
- Create: `src/operator/components/WelcomeScreen.tsx`
- Modify: `src/operator/components/CaptureScreen.tsx`
- Modify: `src/operator/components/SelectionScreen.tsx`
- Modify: `src/operator/components/FrameScreen.tsx`
- Modify: `src/operator/components/QrScreen.tsx`
- Test: `tests/operator/App.test.tsx`

**Interfaces:**
- Consumes: all operator modules from Tasks 5–11 through an injected `AppServices` object.
- Produces: the complete operator workflow and safe current-session teardown.

```ts
export interface AppServices {
  camera: CameraPort;
  compositor: BrowserCompositor;
  delivery: DeliveryCoordinator;
  registry: IssuedSessionRegistry;
  api: PrivateApiClient;
  frames: FrameManifest[];
  prompts: [string, string, string, string, string, string];
  countdownTickMs: number;
  getPublicUrl(): string | null;
}
```

- [ ] **Step 1: Write an integration test for the approved phase order**

```tsx
it("runs welcome, six captures, four selections, frame, QR, and reset", async () => {
  render(<App services={fakeServices} />);
  await user.click(screen.getByRole("button", { name: "체험 시작" }));
  await fakeServices.camera.finishSixShots();
  for (const number of [4, 1, 6, 3]) {
    await user.click(screen.getByAltText(`촬영 사진 ${number}`));
  }
  await user.click(screen.getByRole("button", { name: "프레임 선택하기" }));
  await user.click(screen.getByRole("radio", { name: "기본 프레임" }));
  await user.click(screen.getByRole("button", { name: "이 프레임으로 사진 만들기" }));
  expect(await screen.findByText("팀원 모두 각자 스캔할 수 있습니다")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "처음으로" }));
  await user.click(screen.getByRole("button", { name: "확인" }));
  expect(screen.getByRole("button", { name: "체험 시작" })).toBeVisible();
  expect(fakeServices.registry.activeCount()).toBe(1);
});
```

- [ ] **Step 2: Run the application test and verify failure**

Run: `npm test -- tests/operator/App.test.tsx`

Expected: FAIL because `App.tsx` and the entrypoint are missing.

- [ ] **Step 3: Compose screens from the reducer without duplicating state**

`App` owns one reducer, one current `AbortController`, and one generation value. Render exactly one phase screen plus `ResetControl` at the application shell level so the button remains visible in preflight, welcome, capture, selection, frame, delivery, QR, and error phases. `WelcomeScreen` shows `사진은 암호화되어 QR 발급 10분 후 삭제됩니다` and requires `모든 팀원이 촬영에 동의했습니다` before enabling start. Load six prompts and frame packs, call `camera.probe()`, and confirm the complete preflight before setting ready. Pass `services.countdownTickMs` into every capture sequence.

- [ ] **Step 4: Implement reset teardown in this order**

```ts
async function resetCurrentSession(): Promise<void> {
  currentAbortController.abort();
  services.camera.stop();
  for (const photo of state.photos) URL.revokeObjectURL(photo.previewUrl);
  if (state.pendingSessionId) await services.api.deletePending(state.pendingSessionId);
  dispatch({ type: "RESET_CONFIRMED" });
  currentAbortController = new AbortController();
  await rerunPreflight();
}
```

Do not call `registry.remove()` for issued sessions. Every async completion dispatches its generation so the reducer discards stale results. Errors expose only `다시 시도` and the global `처음으로`.

After delivery activation succeeds, revoke all six preview URLs and remove every raw photo and the final plaintext JPEG from application state before rendering the QR phase. The QR phase receives only `IssuedSession`; the key remains solely in `IssuedSessionRegistry`.

- [ ] **Step 5: Run operator tests and commit**

Run: `npm test -- tests/operator && npm run typecheck`

Expected: PASS, including an assertion that `처음으로` is visible in every phase and reset completes within three seconds under fake timers.

```bash
git add src/operator tests/operator/App.test.tsx
git commit -m "feat: integrate complete operator photo flow"
```

### Task 13: Assemble the event runtime, sweeper, metrics persistence, and safe shutdown

**Files:**
- Create: `src/server/runtime.ts`
- Create: `src/server/index.ts`
- Modify: `src/server/metrics.ts`
- Modify: `src/server/private-server.ts`
- Test: `tests/server/runtime.test.ts`
- Test: `tests/server/metrics.test.ts`

**Interfaces:**
- Consumes: `AppConfig`, server factories, store, tunnel supervisor, clock.
- Produces: `createRuntime(deps)`, `start()`, `getStatus()`, `stop({ purge })`.

- [ ] **Step 1: Write lifecycle tests for startup, sweeps, aggregate metrics, and shutdown**

```ts
it("binds both listeners to loopback and tunnels only the public port", async () => {
  const runtime = createRuntime(harnessDeps);
  await runtime.start();
  expect(harnessDeps.listenCalls).toEqual([
    { host: "127.0.0.1", port: 4174, surface: "public" },
    { host: "127.0.0.1", port: 4173, surface: "private" },
  ]);
  expect(harnessDeps.tunnel.startedWith).toBe("http://127.0.0.1:4174");
});

it("purges sessions before stopping the tunnel", async () => {
  const runtime = createRuntime(harnessDeps);
  await runtime.start();
  await runtime.stop({ purge: true });
  expect(harnessDeps.order).toEqual([
    "accepting-captures:false",
    "store:purge-all",
    "tunnel:stop",
    "private:close",
    "public:close",
  ]);
});
```

- [ ] **Step 2: Run runtime tests and confirm failure**

Run: `npm test -- tests/server/runtime.test.ts tests/server/metrics.test.ts`

Expected: FAIL because runtime assembly is missing.

- [ ] **Step 3: Implement deterministic startup and sweep scheduling**

Initialize and sweep the store first, build/listen on public, then build/listen on private so the operator can see startup failures. Start and health-check the tunnel after both local listeners are reachable. In test-only `local` mode, purge the test session directory at startup, use a static supervisor that returns `localPublicBaseUrl`, and never spawn a process; reject that mode in development or production. Production and development startup never purge an unexpired active session. Set `acceptingCaptures` only after the full preflight passes. Schedule `store.sweep()` every 30 seconds; a failed sweep marks capture unavailable until a later sweep succeeds. Tunnel URL changes update runtime status and notify the operator through `/api/status` polling every two seconds.

- [ ] **Step 4: Persist only aggregate counters and implement shutdown**

Write aggregate counters atomically to `runtime-data/metrics.json` after each accepted event. The JSON contains only counter names, numbers, and `updatedAt`; no session, request, device, or network fields. `requestShutdown()` marks capture closed, responds to the operator, purges all sessions, stops the tunnel, closes listeners, and exits with code 0. `SIGINT` and `SIGTERM` call the same purge path.

`src/server/index.ts` loads config, reads the prebuilt recipient page and frame/pose assets, creates runtime dependencies, and prints only the private operator URL plus non-sensitive component health. It must never print a complete delivery URL or session token.

- [ ] **Step 5: Run server tests and commit**

Run: `npm test -- tests/server && npm run typecheck`

Expected: PASS, with fake timers proving access denial exactly at 600,000 ms and file deletion no later than the next 30-second sweep.

```bash
git add src/server tests/server/runtime.test.ts tests/server/metrics.test.ts
git commit -m "feat: assemble privacy-safe event runtime"
```

### Task 14: Verify the full browser flow and write the event runbook

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/booth-flow.spec.ts`
- Create: `e2e/reset-and-expiry.spec.ts`
- Create: `docs/operations.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: production build, real private/public listeners, local no-tunnel test adapter, Chromium fake camera.
- Produces: executable end-to-end acceptance tests and a complete operator runbook.

- [ ] **Step 1: Configure Playwright with a deterministic fake camera**

Use Chromium launch arguments:

```ts
use: {
  baseURL: "http://127.0.0.1:4173",
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  },
}
```

Set `workers: 1` and `fullyParallel: false` because the scenarios intentionally share one Mac-style camera and one local session store. In test-only local tunnel mode, `runtime.start()` calls `store.purgeAll()` before accepting requests so repeated E2E runs begin empty; production and development startup never purge an unexpired active session.

Configure the Playwright `webServer` with this command and readiness URL:

```ts
webServer: {
  command:
    "npm run build && env NODE_ENV=test JOIN_SITE_URL=https://join.example.test/apply?utm_source=club_fair SESSION_DIR=runtime-data/e2e-sessions TUNNEL_MODE=local LOCAL_PUBLIC_BASE_URL=http://127.0.0.1:4174 COUNTDOWN_TICK_MS=10 ACTIVE_TTL_MS=5000 SWEEP_INTERVAL_MS=50 tsx src/server/index.ts",
  url: "http://127.0.0.1:4173/api/status",
  reuseExistingServer: false,
}
```

The E2E runtime sets `NODE_ENV=test`, uses local public URL `http://127.0.0.1:4174` instead of spawning `cloudflared`, sets `COUNTDOWN_TICK_MS=10`, `ACTIVE_TTL_MS=5000`, and `SWEEP_INTERVAL_MS=50`, and writes sessions only beneath `runtime-data/e2e-sessions`. `loadConfig()` ignores these override variables outside test mode, preserving production values of 1,000 ms, 600,000 ms, and 30,000 ms.

- [ ] **Step 2: Write the full happy-path browser test**

```ts
test("six captures become a four-photo encrypted download and CTA", async ({ browser, page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "체험 시작" }).click();
  await expect(page.getByText("6 / 6")).toBeVisible();
  for (const number of [4, 1, 6, 3]) {
    await page.getByAltText(`촬영 사진 ${number}`).click();
  }
  await page.getByRole("button", { name: "프레임 선택하기" }).click();
  await page.getByRole("radio", { name: "기본 프레임" }).click();
  await page.getByRole("button", { name: "이 프레임으로 사진 만들기" }).click();
  const deliveryUrl = await page.getByTestId("delivery-url").getAttribute("data-url");
  expect(deliveryUrl).toContain("#key=");

  const recipient = await browser.newPage();
  await recipient.goto(deliveryUrl!);
  await expect(recipient.getByAltText("완성된 네컷 사진")).toBeVisible();
  await expect(recipient.getByRole("link", { name: "지원 페이지 보기" })).toHaveCount(0);
  await recipient.getByRole("button", { name: "사진 저장하기" }).click();
  await expect(recipient.getByRole("link", { name: "지원 페이지 보기" })).toBeVisible();
});
```

The delivery URL may be exposed only as a `data-*` test attribute when `NODE_ENV=test`; production builds omit it and show only the QR image.

- [ ] **Step 3: Write reset isolation, multi-device, and expiry tests**

Cover these exact cases:

```text
reset from welcome, capture, selection, frame, delivery, QR, and error
late capture/encryption completion ignored after reset
issued QR remains downloadable after operator reset
two recipient contexts decrypt the same session before expiry
wrong key and modified ciphertext show failure without plaintext fallback
access at expiresAt returns deletion-complete state
server session directory contains no JPEG magic bytes FF D8 FF
shutdown leaves the session directory empty
```

- [ ] **Step 4: Write the event operations runbook**

`docs/operations.md` must contain these executable sections:

1. Install Node.js 22+, npm dependencies, and `cloudflared` with `brew install cloudflared`.
2. Prompt the operator for the real HTTPS join URL instead of committing it:

```bash
read "JOIN_SITE_URL?가입 사이트 HTTPS URL: "
export JOIN_SITE_URL
npm run booth
```

3. Confirm Mac power, sleep disabled, Do Not Disturb, camera composition, lighting, six prompts, frame pack, and available storage.
4. Test from an iPhone Safari and Android Chrome using cellular data, not the Mac Wi-Fi.
5. Run 10 consecutive team rehearsals and record duration, download success, memory behavior, and previous-photo leakage.
6. Explain tunnel-down recovery: stop new captures, wait for automatic URL replacement, reissue the current QR, and verify `/health` from cellular data.
7. Explain shutdown: block new teams, wait for the last ten-minute timer, use `운영 종료 및 전체 삭제`, verify the session directory is empty, then stop power/network equipment.
8. Include the approved front-sign copy `친구와 무료 네컷 촬영 · 휴대폰으로 바로 저장` and subcopy `앱 설치 없음 · 사진은 10분 후 삭제`.
9. Include a staff script that invites 1–4-person teams, tells every member to scan the same QR, and never displays a participant's live or completed photo outside the operator screen.
10. Include an after-event section that records team starts, completed QRs, successful decryptions, save intents, join clicks, and UTM visits against the 90%, 95%, and 30% success targets without exporting photos or session identifiers.

- [ ] **Step 5: Run the complete verification gate**

Run:

```bash
npm run build
npm test
npm run test:e2e
npm audit --omit=dev --audit-level=high
```

Expected:

```text
TypeScript: no errors
Vitest: all tests pass
Playwright: all scenarios pass
npm audit production dependencies: 0 high or critical vulnerabilities
```

Run `npx playwright install chromium` once before the first E2E execution on the event MacBook.

Then perform the runbook's real-device rehearsal on the actual event MacBook. Record a rehearsal as failed if capture-to-QR exceeds four minutes, recipient preview exceeds five seconds on a working cellular connection, any plaintext file appears on disk, reset exceeds three seconds, or any previous team's photo appears in the next session.

- [ ] **Step 6: Commit the acceptance suite and runbook**

```bash
git add playwright.config.ts e2e docs/operations.md package.json package-lock.json
git commit -m "test: verify event-ready booth workflow"
```

## Final Acceptance Gate

Before declaring implementation complete, verify all of the following on the event MacBook:

- [ ] Six real camera captures each use a visible five-second countdown.
- [ ] Four selected photos appear in click order in every frame.
- [ ] The upper-right reset control works from every phase with only the approved copy.
- [ ] Reset never invalidates an already-issued QR.
- [ ] Two iPhones/Android phones can independently decrypt one team QR.
- [ ] The recipient sees the CTA only after initiating save.
- [ ] The server session directory contains ciphertext and metadata only.
- [ ] Access stops exactly at ten minutes and files disappear by the next 30-second sweep.
- [ ] Tunnel loss blocks new teams and a new URL regenerates the current QR.
- [ ] Ten consecutive rehearsal teams complete without stale images or progressive memory growth.
- [ ] `운영 종료 및 전체 삭제` leaves no session files behind.
- [ ] The production dependency audit has no high or critical finding.
