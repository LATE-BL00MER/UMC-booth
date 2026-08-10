# UMC Booth UI Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved dark technical UMC design system from `design.md` to the operator and recipient interfaces without changing booth state transitions, capture behavior, delivery behavior, security behavior, or public/private APIs.

**Architecture:** Use a CSS-first presentation layer. Add a small presentational `OperatorShell` around the existing phase screen, add semantic class names and non-interactive copy inside existing UI components, and leave every existing callback, effect, reducer event, API call, and cryptographic operation intact. Keep operator styles split into foundation, reusable components, and screen layouts; keep the recipient bundle dependency-free by continuing to embed its CSS at build time.

**Tech Stack:** React 19, TypeScript 7, plain CSS, Vite 8, Vitest 4, Testing Library, Playwright 1.62

## Global Constraints

- `design.md` is the visual source of truth; the implementation direction is **operational dark tech**.
- Do not modify `src/operator/booth-machine.ts`, `src/operator/camera/**`, `src/operator/delivery/**`, `src/operator/frames/browser-compositor.ts`, `src/server/**`, or `src/shared/**`.
- In `src/operator/App.tsx`, change only imports and rendered presentation markup. Do not change hooks, refs, effects, callbacks, dispatch events, polling, reset sequencing, delivery sequencing, or metrics.
- In `src/recipient/client.ts`, change only DOM construction, classes, and visible copy. Preserve URL fragment scrubbing, fetch order, decrypt order, save behavior, event order, object URL lifecycle, and HTTPS validation.
- Preserve these interactive accessible names because unit and E2E flows depend on them: `체험 시작`, `프레임 선택하기`, `이 프레임으로 사진 만들기`, `처음으로`, `확인`, `다시 시도`, `사진 저장하기`, `지원 페이지 보기`.
- Preserve all existing `aria-label`, `aria-pressed`, `aria-live`, `role`, `disabled`, radio, checkbox, and dialog semantics unless this plan explicitly strengthens them.
- Add no runtime UI dependency and no remote font request. Use the local/system Pretendard fallback stack from `design.md`.
- Do not generate a fake official UMC logo. Render the temporary brand mark as styled text `UMC`; replace it only if an official SVG is supplied.
- No image-generation task is required for the first implementation. Background glow, grain-free depth, and glass surfaces are CSS. If visual review later proves a decorative raster asset necessary, pause and request approval before invoking `imagegen`; generated assets may be ambient decoration only, never a logo or functional icon.
- Never apply tint, blend modes, backdrop filters, or color overlays to camera video, captured photos, composed previews, or QR pixels.
- Operator targets: `1024 × 700`, `1440 × 900`, and `1728 × 1117`. Recipient targets: `360 × 800`, `390 × 844`, and `430 × 932`.
- Minimum interactive size: operator `48 × 48px`, recipient `44 × 44px`.
- Support `prefers-reduced-motion: reduce`; never use `transition: all`.
- Preserve unrelated dirty worktree files. Each commit stages only files named in its task.
- The current protected dirty files must retain these exact SHA-256 values throughout implementation: `src/server/tunnel-supervisor.ts` = `72bc60c4530906199e2649f2943d4c0e490099fe0ac0b4300a288d170bb1e39c`, `src/shared/config.ts` = `780e0b1375a6a868b2163c2b4b470c1bad17e7627713f4153523641b2158ab16`, `tests/server/tunnel-supervisor.test.ts` = `8c63f506dbeee54066de4157bf5c0dabafd6116341815e5f50acb75a1bf59088`, `tests/shared/config.test.ts` = `f09baf4db2ffee99bc18f9479573cb64fc44588c9f37a5fb1d4df8c7f5cb9be8`, and `docs/operations.md` = `284beb12e706d21c4f5a5ca14950a1aee4225584cd9cd2cbb516d1f94c35c3fd`.

## File Structure

### Create

- `src/operator/styles/tokens.css` — primitive and semantic tokens, typography values, spacing, radius, motion, focus values.
- `src/operator/styles/base.css` — box sizing, document canvas, typography defaults, focus, reduced motion, base form control behavior.
- `src/operator/styles/components.css` — brand mark, shell, header, buttons, status chips, glass panel, dialog, loading indicator.
- `src/operator/styles/screens.css` — preflight, welcome, capture, selection, frame, delivery, QR, and error layouts.
- `src/operator/styles/index.css` — ordered imports for the operator bundle.
- `src/operator/components/BrandMark.tsx` — accessible text fallback for the unavailable official logo asset.
- `src/operator/components/OperatorShell.tsx` — presentational header, progress indicator, phase class, status summary, and reset placement.
- `tests/operator/styles/design-contract.test.ts` — static verification of critical token and safety rules.
- `tests/operator/components/OperatorShell.test.tsx` — visual phase mapping and accessibility contract.
- `e2e/ui-layout.spec.ts` — responsive layout, overflow, card-grid, and recipient mobile assertions.

### Modify

- `src/operator/main.tsx` — import the operator stylesheet entry.
- `src/operator/App.tsx` — wrap the existing phase screen in `OperatorShell`; add classes to preflight, delivery, and error presentation markup.
- `src/operator/components/BootstrapShell.tsx` — apply boot shell markup and brand presentation.
- `src/operator/components/WelcomeScreen.tsx` — add approved hierarchy, classes, and supporting copy while preserving handlers.
- `src/operator/components/CaptureScreen.tsx` — add overlay containers and classes; move mirror styling from inline style to CSS.
- `src/operator/components/SelectionScreen.tsx` — add heading, selection progress, grid classes, and fixed action bar markup.
- `src/operator/components/FrameScreen.tsx` — add split-layout classes and presentation groups without altering composition effects.
- `src/operator/components/QrScreen.tsx` — add QR card hierarchy and a presentation-only timer tone.
- `src/operator/components/PreflightBar.tsx` — add status classes and text-preserving status items.
- `src/operator/components/ResetControl.tsx` — replace inline position styling with classes and strengthen dialog copy while retaining accessible button names.
- `src/recipient/client.ts` — add recipient brand, headings, helper copy, classes, and saved-state presentation.
- `src/recipient/page.css` — replace the beige minimal page with the approved mobile dark technical system.
- `scripts/build-recipient.mjs` — update only the initial loading document markup and `color-scheme` metadata.
- Existing tests under `tests/operator/components/**`, `tests/operator/App.test.tsx`, and `tests/recipient/client.test.ts` — assert new presentation contracts while retaining all behavior assertions.

---

### Task 0: Establish the behavior and worktree baseline

**Files:**
- Verify: all existing source and test files.
- Modify: none.

**Interfaces:**
- Consumes: current committed project plus the protected dirty files listed in Global Constraints.
- Produces: fresh test/build evidence and a known-safe starting point before any UI edit.

- [ ] **Step 1: Confirm the protected dirty files still match the recorded fingerprints**

Run:

```bash
shasum -a 256 \
  src/server/tunnel-supervisor.ts \
  src/shared/config.ts \
  tests/server/tunnel-supervisor.test.ts \
  tests/shared/config.test.ts \
  docs/operations.md
```

Expected: every digest exactly matches the value in Global Constraints. If any digest differs before UI work starts, stop and update the baseline with the user's current content rather than overwriting it.

- [ ] **Step 2: Run the full existing unit suite**

Run: `npm test`

Expected: all current Vitest suites pass before any UI edit.

- [ ] **Step 3: Run the full existing build**

Run: `npm run build`

Expected: operator, recipient, and TypeScript builds complete successfully.

- [ ] **Step 4: Run the full existing E2E suite**

Run: `npm run test:e2e`

Expected: all current booth flow and reset/expiry tests pass before UI edits.

No commit is created because this task changes no files.

---

### Task 1: Add the operator visual foundation

**Files:**
- Create: `src/operator/styles/tokens.css`
- Create: `src/operator/styles/base.css`
- Create: `src/operator/styles/index.css`
- Create: `tests/operator/styles/design-contract.test.ts`
- Modify: `src/operator/main.tsx`

**Interfaces:**
- Consumes: exact visual values from `design.md` sections 5–8 and 11–12.
- Produces: global CSS custom properties and normalized base styles consumed by every later operator task.

- [ ] **Step 1: Write the failing token contract test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(
  new URL("../../../src/operator/styles/tokens.css", import.meta.url),
  "utf8",
);
const base = readFileSync(
  new URL("../../../src/operator/styles/base.css", import.meta.url),
  "utf8",
);

describe("operator design contract", () => {
  it("defines the approved semantic color and motion tokens", () => {
    for (const declaration of [
      "--color-bg-app: #050807",
      "--color-bg-photo: #0b0f0e",
      "--color-accent-primary: #9fdcd4",
      "--color-text-primary: #ffffff",
      "--color-status-danger: #e45b5b",
      "--motion-fast: 150ms",
      "--motion-default: 240ms",
    ]) expect(tokens).toContain(declaration);
  });

  it("does not permit broad transitions and honors reduced motion", () => {
    expect(`${tokens}\n${base}`).not.toMatch(/transition\s*:\s*all/);
    expect(base).toContain("@media (prefers-reduced-motion: reduce)");
    expect(base).toContain(":focus-visible");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails because the style files do not exist**

Run: `npm test -- tests/operator/styles/design-contract.test.ts`

Expected: FAIL with an `ENOENT` error for `src/operator/styles/tokens.css`.

- [ ] **Step 3: Create the exact semantic token foundation**

Create `src/operator/styles/tokens.css` with the approved values and named scales:

```css
:root {
  color-scheme: dark;
  --color-bg-canvas: #000000;
  --color-bg-app: #050807;
  --color-bg-photo: #0b0f0e;
  --color-surface-default: #111716;
  --color-surface-raised: #17201e;
  --color-surface-glass: rgba(12, 42, 37, 0.72);
  --color-surface-glass-subtle: rgba(12, 42, 37, 0.42);
  --color-surface-scrim: rgba(0, 0, 0, 0.72);
  --color-text-primary: #ffffff;
  --color-text-secondary: #d3d8d8;
  --color-text-muted: #899291;
  --color-text-on-accent: #031412;
  --color-accent-primary: #9fdcd4;
  --color-accent-default: #63c4b8;
  --color-accent-strong: #0b6b64;
  --color-accent-surface: #062b29;
  --color-border-default: rgba(211, 216, 216, 0.16);
  --color-border-strong: rgba(159, 220, 212, 0.4);
  --color-border-selected: #9fdcd4;
  --color-focus: #63c4b8;
  --color-status-success: #56d69b;
  --color-status-warning: #f5b942;
  --color-status-danger: #e45b5b;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;
  --space-16: 64px;
  --space-24: 96px;
  --radius-sm: 8px;
  --radius-control: 12px;
  --radius-panel: 20px;
  --radius-feature: 28px;
  --radius-pill: 999px;
  --motion-instant: 80ms;
  --motion-fast: 150ms;
  --motion-default: 240ms;
  --motion-emphasis: 360ms;
  --ease-standard: cubic-bezier(.4, 0, .2, 1);
  --ease-emphasis: cubic-bezier(.2, .9, .2, 1);
  --font-sans: "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --shadow-raised: 0 16px 48px rgba(0, 0, 0, 0.36);
  --glow-accent: 0 0 32px rgba(99, 196, 184, 0.24);
}
```

Create `src/operator/styles/base.css` with box sizing, a full-height canvas, default typography, form inheritance, visible focus, image/video block behavior, and reduced motion:

```css
*, *::before, *::after { box-sizing: border-box; }
html, body, #root { min-height: 100%; }
body {
  margin: 0;
  overflow-x: hidden;
  background: var(--color-bg-canvas);
  color: var(--color-text-primary);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}
button, input, select { font: inherit; }
button, select, label { -webkit-tap-highlight-color: transparent; }
button { min-height: 48px; }
img, video { display: block; max-width: 100%; }
:focus-visible { outline: 3px solid var(--color-focus); outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 80ms !important;
  }
}
```

Create `src/operator/styles/index.css`:

```css
@import "./tokens.css";
@import "./base.css";
@import "./components.css";
@import "./screens.css";
```

Create empty `components.css` and `screens.css` in the same step so the import graph resolves; later tasks fill them.

- [ ] **Step 4: Import the stylesheet once at the operator entry**

Add this as the first local import in `src/operator/main.tsx`:

```ts
import "./styles/index.css";
```

- [ ] **Step 5: Run focused tests and build**

Run: `npm test -- tests/operator/styles/design-contract.test.ts && npm run build:operator`

Expected: the design contract passes and Vite emits `dist/operator` without CSS resolution errors.

- [ ] **Step 6: Commit only the foundation files**

```bash
git add src/operator/main.tsx src/operator/styles tests/operator/styles/design-contract.test.ts
git commit -m "feat: add booth UI design tokens"
```

---

### Task 2: Add the presentational operator shell and persistent controls

**Files:**
- Create: `src/operator/components/BrandMark.tsx`
- Create: `src/operator/components/OperatorShell.tsx`
- Create: `tests/operator/components/OperatorShell.test.tsx`
- Modify: `src/operator/App.tsx`
- Modify: `src/operator/components/ResetControl.tsx`
- Modify: `tests/operator/components/ResetControl.test.tsx`
- Modify: `src/operator/styles/components.css`

**Interfaces:**
- Consumes: `BoothState["phase"]`, `PreflightStatus | null`, and the existing reset callback.
- Produces: `OperatorShell({ phase, status, onReset, children })`, a purely presentational wrapper used once by `App`.

- [ ] **Step 1: Write failing tests for phase mapping and reset preservation**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OperatorShell } from "../../../src/operator/components/OperatorShell.js";

describe("OperatorShell", () => {
  it("maps selecting to the photo-selection progress step", () => {
    render(<OperatorShell phase="selecting" status={null} onReset={vi.fn()}><p>content</p></OperatorShell>);
    expect(screen.getByRole("navigation", { name: "체험 진행 단계" })).toBeVisible();
    expect(screen.getByText("사진 선택")).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("button", { name: "처음으로" })).toBeVisible();
  });

  it("marks delivery and QR as the same visual completion step", () => {
    const { rerender } = render(<OperatorShell phase="delivering" status={null} onReset={vi.fn()}><p /></OperatorShell>);
    expect(screen.getByText("QR")).toHaveAttribute("aria-current", "step");
    rerender(<OperatorShell phase="qr" status={null} onReset={vi.fn()}><p /></OperatorShell>);
    expect(screen.getByText("QR")).toHaveAttribute("aria-current", "step");
  });
});
```

Update the reset test to assert a class instead of inline viewport styles and to preserve the accessible confirmation name:

```tsx
const resetButton = screen.getByRole("button", { name: "처음으로" });
expect(resetButton.parentElement).toHaveClass("reset-control");
await user.click(resetButton);
expect(screen.getByRole("button", { name: "확인" })).toHaveTextContent("사진 삭제하고 돌아가기");
```

- [ ] **Step 2: Run the focused tests and verify the new shell test fails**

Run: `npm test -- tests/operator/components/OperatorShell.test.tsx tests/operator/components/ResetControl.test.tsx`

Expected: FAIL because `OperatorShell.tsx` does not exist and reset presentation still uses inline styles.

- [ ] **Step 3: Implement a text brand mark and phase-only shell**

`BrandMark.tsx` must not pretend to be an official logo image:

```tsx
export function BrandMark({ compact = false }: { compact?: boolean }) {
  return <span className="brand-mark" aria-label="UMC">UMC{compact ? null : <span> PHOTO BOOTH</span>}</span>;
}
```

`OperatorShell.tsx` must contain no state, effects, or service access. Map phases only for presentation:

```tsx
import type { ReactNode } from "react";
import type { BoothState } from "../booth-machine.js";
import type { PreflightStatus } from "./PreflightBar.js";
import { BrandMark } from "./BrandMark.js";
import { ResetControl } from "./ResetControl.js";

interface OperatorShellProps {
  phase: BoothState["phase"];
  status: PreflightStatus | null;
  onReset(): void;
  children: ReactNode;
}

const steps = [
  ["capturing", "촬영"],
  ["selecting", "사진 선택"],
  ["framing", "프레임"],
  ["qr", "QR"],
] as const;

function visualStep(phase: BoothState["phase"]): string | null {
  if (phase === "delivering") return "qr";
  return steps.some(([step]) => step === phase) ? phase : null;
}

export function OperatorShell({ phase, status, onReset, children }: OperatorShellProps) {
  const current = visualStep(phase);
  const ready = status === null ? null : status.cameraReady && status.tunnel.state === "healthy";
  return (
    <div className="operator-shell" data-phase={phase}>
      <header className="operator-header">
        <BrandMark compact />
        <nav className="operator-steps" aria-label="체험 진행 단계">
          {steps.map(([step, label]) => <span key={step} aria-current={current === step ? "step" : undefined}>{label}</span>)}
        </nav>
        <div className="operator-tools">
          <span className="status-chip" data-tone={ready === false ? "danger" : ready === true ? "success" : "neutral"}>
            {ready === false ? "확인 필요" : ready === true ? "운영 정상" : "상태 확인 중"}
          </span>
          <ResetControl onConfirm={onReset} />
        </div>
      </header>
      <main className="operator-main">{children}</main>
    </div>
  );
}
```

- [ ] **Step 4: Wrap the existing phase screen without touching App behavior**

In `src/operator/App.tsx`, replace only the returned fragment:

```tsx
return (
  <OperatorShell
    phase={state.phase}
    status={preflightStatus}
    onReset={() => void resetCurrentSession()}
  >
    {phaseScreen}
  </OperatorShell>
);
```

Do not edit code above `phaseScreen` creation or inside any existing callback.

- [ ] **Step 5: Convert ResetControl to class-based presentation while keeping callbacks and focus behavior**

Use `.reset-control`, `.reset-control__trigger`, `.dialog-backdrop`, `.dialog-panel`, and `.dialog-actions`. Keep `aria-label="확인"` on the final button while showing the approved visible copy:

```tsx
<button className="button button--danger" aria-label="확인" type="button" onClick={confirm}>
  사진 삭제하고 돌아가기
</button>
```

Keep the existing state, Escape listener, focus restoration, and `onConfirm()` call unchanged.

- [ ] **Step 6: Add shell, progress, button, chip, and dialog CSS**

Implement the following exact behavior in `components.css`:

```css
.operator-shell { min-height: 100vh; background: var(--color-bg-app); }
.operator-header {
  position: relative; z-index: 20; height: 72px; padding: 0 32px;
  display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
  border-bottom: 1px solid var(--color-border-default);
  background: rgba(5, 8, 7, .86); backdrop-filter: blur(16px);
}
.operator-tools { justify-self: end; display: flex; align-items: center; gap: var(--space-3); }
.operator-steps { display: flex; align-items: center; gap: var(--space-2); }
.operator-steps span { color: var(--color-text-muted); padding: 8px 14px; border-radius: var(--radius-pill); }
.operator-steps [aria-current="step"] { color: var(--color-text-on-accent); background: var(--color-accent-primary); }
.button { min-height: 56px; padding: 0 24px; border: 0; border-radius: var(--radius-control); font-weight: 700; cursor: pointer; }
.button--primary { color: var(--color-text-on-accent); background: var(--color-accent-primary); }
.button--secondary { color: var(--color-text-primary); border: 1px solid var(--color-border-strong); background: var(--color-surface-glass); }
.button--ghost { color: var(--color-text-secondary); background: transparent; }
.button--danger { color: white; background: var(--color-status-danger); }
.button:disabled { color: var(--color-text-muted); background: #303a38; cursor: not-allowed; box-shadow: none; }
.dialog-backdrop { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 24px; background: var(--color-surface-scrim); }
.dialog-panel { width: min(100%, 480px); padding: 32px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-feature); background: var(--color-surface-raised); box-shadow: var(--shadow-raised); }
```

- [ ] **Step 7: Run shell, reset, App, and build verification**

Run: `npm test -- tests/operator/components/OperatorShell.test.tsx tests/operator/components/ResetControl.test.tsx tests/operator/App.test.tsx && npm run build:operator`

Expected: all tests pass; existing App flow tests still find `처음으로` and `확인`.

- [ ] **Step 8: Commit only shell-related files**

```bash
git add src/operator/App.tsx src/operator/components/BrandMark.tsx src/operator/components/OperatorShell.tsx src/operator/components/ResetControl.tsx src/operator/styles/components.css tests/operator/components/OperatorShell.test.tsx tests/operator/components/ResetControl.test.tsx
git commit -m "feat: add operator booth shell"
```

---

### Task 3: Style boot, preflight, welcome, and generic error states

**Files:**
- Modify: `src/operator/components/BootstrapShell.tsx`
- Modify: `src/operator/components/PreflightBar.tsx`
- Modify: `src/operator/components/WelcomeScreen.tsx`
- Modify: `src/operator/App.tsx`
- Modify: `src/operator/styles/components.css`
- Modify: `src/operator/styles/screens.css`
- Modify: `tests/operator/components/BootstrapShell.test.tsx`
- Modify: `tests/operator/components/PreflightBar.test.tsx`
- Modify: `tests/operator/App.test.tsx`

**Interfaces:**
- Consumes: existing `load`, `onReady`, `onStart`, `onRedisplay`, `onRetry`, and preflight props.
- Produces: visually complete entry states with unchanged interaction signatures.

- [ ] **Step 1: Add failing presentation assertions**

Add assertions for:

```tsx
expect(screen.getByLabelText("시작 안내")).toHaveClass("welcome-screen");
expect(screen.getByRole("heading", { name: "우리의 순간을 네컷으로" })).toBeVisible();
expect(screen.getByText("6장을 찍고 마음에 드는 4장을 골라요")).toBeVisible();
expect(screen.getByLabelText("운영 준비 상태")).toHaveClass("preflight-panel");
expect(screen.getByLabelText("운영 화면 준비")).toHaveClass("boot-screen");
```

Keep every existing assertion about load retry, consent, readiness, issued QR redisplay, and error buttons.

- [ ] **Step 2: Run focused tests and verify class/heading assertions fail**

Run: `npm test -- tests/operator/components/BootstrapShell.test.tsx tests/operator/components/PreflightBar.test.tsx tests/operator/App.test.tsx`

Expected: FAIL because the new classes and headings are absent.

- [ ] **Step 3: Add semantic entry-state markup without changing handlers**

In `WelcomeScreen`, add a `welcome-screen` section containing a `.welcome-hero` and `.welcome-consent glass-panel`. Keep the existing privacy text unchanged so current behavior tests remain valid. Use this hierarchy:

```tsx
<section className="welcome-screen" aria-label="시작 안내">
  <div className="welcome-hero">
    <p className="eyebrow">UNIVERSITY MAKEUS CHALLENGE</p>
    <h1>우리의 순간을 네컷으로</h1>
    <p className="welcome-lead">6장을 찍고 마음에 드는 4장을 골라요</p>
  </div>
  <div className="welcome-consent glass-panel">
    <p className="privacy-note">사진은 암호화되어 QR 발급 10분 후 삭제됩니다</p>
    {/* keep the existing checkbox and callbacks exactly */}
  </div>
</section>
```

Assign `button button--primary` to `체험 시작`, `button button--secondary` to `이전 QR 다시 표시`, and `select-control` to the existing select.

In `BootstrapShell`, add `boot-screen`, a `BrandMark`, an `h1`, loader dots, and classed error actions. Do not alter `retry`, effects, or mount guards.

In `PreflightBar`, preserve all five current text nodes and add `.preflight-panel`, `.preflight-item`, and `data-tone` values based on existing booleans.

In `App.tsx`, change only the `preflight`, `delivering`, and `ErrorScreen` JSX to include `h1`, explanatory text, and classes. Keep `onRetry` and `aria-live` unchanged.

- [ ] **Step 4: Implement entry-state CSS**

`screens.css` must implement:

```css
.welcome-screen { min-height: calc(100vh - 72px); display: grid; grid-template-columns: 1.1fr .9fr; align-items: center; gap: 64px; width: min(1280px, calc(100% - 64px)); margin: 0 auto; }
.welcome-screen::before { content: ""; position: fixed; inset: 72px 0 0; pointer-events: none; background: linear-gradient(98deg, rgba(46,209,190,.12), transparent 42%), linear-gradient(96deg, transparent 66%, rgba(46,209,190,.16)); }
.welcome-hero, .welcome-consent { position: relative; z-index: 1; }
.welcome-hero h1 { max-width: 760px; margin: 12px 0 20px; font-size: clamp(48px, 5vw, 72px); line-height: 1.08; letter-spacing: -.03em; }
.glass-panel { border: 1px solid var(--color-border-strong); border-radius: var(--radius-feature); background: var(--color-surface-glass); backdrop-filter: blur(16px); }
.welcome-consent { display: grid; gap: 24px; padding: 32px; }
.preflight-panel { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 1023px) { .welcome-screen { grid-template-columns: 1fr; gap: 32px; padding: 48px 0; } }
```

Add loading dots using opacity animation; disable it under the existing reduced-motion rule.

- [ ] **Step 5: Run entry-state tests and operator build**

Run: `npm test -- tests/operator/components/BootstrapShell.test.tsx tests/operator/components/PreflightBar.test.tsx tests/operator/App.test.tsx && npm run build:operator`

Expected: PASS with consent gating, retry behavior, readiness, and redisplay behavior unchanged.

- [ ] **Step 6: Commit the entry states**

```bash
git add src/operator/App.tsx src/operator/components/BootstrapShell.tsx src/operator/components/PreflightBar.tsx src/operator/components/WelcomeScreen.tsx src/operator/styles/components.css src/operator/styles/screens.css tests/operator/components/BootstrapShell.test.tsx tests/operator/components/PreflightBar.test.tsx tests/operator/App.test.tsx
git commit -m "feat: style booth entry states"
```

---

### Task 4: Style the capture experience around an untouched camera sequence

**Files:**
- Modify: `src/operator/components/CaptureScreen.tsx`
- Modify: `src/operator/styles/screens.css`
- Modify: `tests/operator/components/CaptureScreen.test.tsx`

**Interfaces:**
- Consumes: existing `CameraPort`, six prompts, countdown callbacks, capture callbacks, retry callback, and error callback.
- Produces: camera-first layout with prompt, progress, countdown, and safe overlay contrast.

- [ ] **Step 1: Add failing capture presentation assertions**

```tsx
const capture = screen.getByLabelText("사진 촬영");
expect(capture).toHaveClass("capture-screen");
expect(screen.getByText("1 / 6")).toHaveClass("capture-progress");
expect(screen.getByText("5")).toHaveClass("capture-countdown");
expect(screen.getByLabelText("카메라 미리보기")).toHaveClass("capture-video");
expect(screen.queryByRole("button")).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the capture test and verify presentation assertions fail**

Run: `npm test -- tests/operator/components/CaptureScreen.test.tsx`

Expected: FAIL on missing capture classes while all sequence assertions still execute.

- [ ] **Step 3: Add presentation-only capture wrappers**

Use this final hierarchy while leaving the entire `useEffect` untouched:

```tsx
<section className="capture-screen" aria-label="사진 촬영">
  <video className="capture-video" ref={videoRef} aria-label="카메라 미리보기" autoPlay muted playsInline />
  <div className="capture-overlay" aria-hidden="true" />
  <p className="capture-prompt">{prompts[shotIndex]}</p>
  <p className="capture-progress" aria-live="polite">{shotIndex + 1} / 6</p>
  <output className="capture-countdown" aria-live="assertive">{countdown ?? ""}</output>
  <p className="capture-guidance">카메라를 바라봐 주세요</p>
</section>
```

Remove only the inline `transform: scaleX(-1)` and move it to `.capture-video`.

- [ ] **Step 4: Implement camera-safe styling**

```css
.capture-screen { position: relative; min-height: calc(100vh - 72px); overflow: hidden; background: var(--color-bg-photo); }
.capture-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); }
.capture-overlay { position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(0,0,0,.58), transparent 30%, transparent 65%, rgba(0,0,0,.56)); pointer-events: none; }
.capture-prompt, .capture-progress, .capture-countdown, .capture-guidance { position: absolute; z-index: 1; margin: 0; }
.capture-prompt { top: 32px; left: 32px; max-width: 60%; font-size: 24px; font-weight: 700; }
.capture-progress { top: 32px; right: 32px; padding: 10px 16px; border-radius: var(--radius-pill); background: rgba(0,0,0,.55); font-variant-numeric: tabular-nums; }
.capture-countdown { inset: 50% auto auto 50%; transform: translate(-50%, -50%); font-size: clamp(96px, 14vw, 160px); font-weight: 800; text-shadow: 0 4px 32px rgba(0,0,0,.58); }
.capture-guidance { left: 50%; bottom: 32px; transform: translateX(-50%); color: var(--color-text-secondary); }
```

Do not add a color filter, backdrop filter, opacity, or blend mode to `.capture-video`.

- [ ] **Step 5: Run capture tests and the capture sequence regression tests**

Run: `npm test -- tests/operator/components/CaptureScreen.test.tsx tests/operator/camera/capture-sequence.test.ts tests/operator/camera/camera-port.test.ts`

Expected: PASS with six-shot capture timing and callbacks unchanged.

- [ ] **Step 6: Commit the capture UI**

```bash
git add src/operator/components/CaptureScreen.tsx src/operator/styles/screens.css tests/operator/components/CaptureScreen.test.tsx
git commit -m "feat: style booth capture screen"
```

---

### Task 5: Style the six-photo selection workflow

**Files:**
- Modify: `src/operator/components/SelectionScreen.tsx`
- Modify: `src/operator/styles/screens.css`
- Modify: `tests/operator/components/SelectionScreen.test.tsx`

**Interfaces:**
- Consumes: existing `photos`, ordered `selectedIds`, toggle, clear, and continue callbacks.
- Produces: 3×2 photo grid, visible `n / 4` progress, selection badges, disabled overflow state, and action bar.

- [ ] **Step 1: Add failing selection presentation assertions**

```tsx
expect(screen.getByRole("heading", { name: "마음에 드는 사진 4장을 순서대로 골라주세요" })).toBeVisible();
expect(screen.getByText("0 / 4 선택")).toBeVisible();
expect(screen.getByLabelText("촬영 사진 목록")).toHaveClass("photo-grid");
expect(screen.getByRole("button", { name: "촬영 사진 1" })).toHaveClass("photo-card");
```

After selecting four photos, assert `4 / 4 선택`, `aria-pressed="true"`, and existing disabled behavior for the remaining cards.

- [ ] **Step 2: Run the selection test and verify the new hierarchy is absent**

Run: `npm test -- tests/operator/components/SelectionScreen.test.tsx`

Expected: FAIL on missing heading, progress copy, and classes.

- [ ] **Step 3: Add headings, progress, grid, badges, and action bar classes**

Keep selection calculations and handlers unchanged. Add:

```tsx
<header className="screen-heading">
  <div><p className="eyebrow">SELECT FOUR</p><h1>마음에 드는 사진 4장을 순서대로 골라주세요</h1></div>
  <output className="selection-progress" aria-live="polite">{selectedIds.length} / 4 선택</output>
</header>
```

Apply `photo-grid`, `photo-card`, `photo-card__image`, and `selection-badge`. Add `data-selected={selected}` to each existing button; keep `aria-pressed`, `disabled`, and `onClick` exactly.

Wrap the two existing actions in `.screen-actions`, assign ghost to reset and primary to continue.

- [ ] **Step 4: Implement a stable 3×2 grid with no image tint**

```css
.selection-screen { width: min(1280px, calc(100% - 64px)); height: calc(100vh - 72px); margin: 0 auto; padding: 32px 0 104px; display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 24px; }
.photo-grid { min-height: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr)); gap: 16px; }
.photo-card { position: relative; min-width: 0; overflow: hidden; padding: 4px; border: 0; border-radius: var(--radius-panel); background: var(--color-bg-photo); }
.photo-card__image { width: 100%; height: 100%; border-radius: 16px; object-fit: cover; }
.photo-card[data-selected="true"] { box-shadow: inset 0 0 0 4px var(--color-border-selected); }
.selection-badge { position: absolute; top: 16px; left: 16px; width: 44px; height: 44px; display: grid; place-items: center; border-radius: 50%; color: var(--color-text-on-accent); background: var(--color-accent-primary); font-size: 20px; font-weight: 700; }
.photo-card:disabled:not([data-selected="true"])::after { content: "4장 선택 완료"; position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.4); color: white; }
```

At `1024px`, keep three columns but reduce gaps to `12px`. Do not add an image filter.

- [ ] **Step 5: Run selection and App flow tests**

Run: `npm test -- tests/operator/components/SelectionScreen.test.tsx tests/operator/App.test.tsx`

Expected: PASS; ordered selection, maximum four, clearing, and continue gating remain unchanged.

- [ ] **Step 6: Commit the selection UI**

```bash
git add src/operator/components/SelectionScreen.tsx src/operator/styles/screens.css tests/operator/components/SelectionScreen.test.tsx
git commit -m "feat: style booth photo selection"
```

---

### Task 6: Style frame selection without changing composition lifecycle

**Files:**
- Modify: `src/operator/components/FrameScreen.tsx`
- Modify: `src/operator/styles/screens.css`
- Modify: `tests/operator/components/FrameScreen.test.tsx`

**Interfaces:**
- Consumes: selected photos, frame manifests, current frame ID, compositor, object URL lifecycle, frame select, and continue callbacks.
- Produces: split preview/list layout with visual radio cards and unchanged composition behavior.

- [ ] **Step 1: Add failing frame-layout assertions**

```tsx
expect(screen.getByRole("heading", { name: "마지막으로 프레임을 골라주세요" })).toBeVisible();
expect(screen.getByLabelText("프레임 선택")).toHaveClass("frame-screen");
expect(screen.getByLabelText("프레임 목록")).toHaveClass("frame-options");
expect(screen.getByRole("radio", { name: "기본 프레임" }).closest("label")).toHaveClass("frame-option");
```

Retain all existing preview URL creation/revocation, stale result, failure, selection, and continue assertions.

- [ ] **Step 2: Run the frame test and verify only presentation assertions fail**

Run: `npm test -- tests/operator/components/FrameScreen.test.tsx`

Expected: FAIL on missing heading and classes; existing composition assertions still pass until the test stops.

- [ ] **Step 3: Group existing elements into a split presentation**

Add `.frame-screen`, `.frame-preview-panel`, `.selected-photo-strip`, `.composed-preview`, `.frame-sidebar`, `.frame-options`, `.frame-option`, and `.screen-actions`. Keep the `useEffect` bodies and `continueWithSelectedFrame` unchanged.

Use the selected radio input as the source of truth. Add `data-selected={selectedFrameId === frame.id}` to the label; do not add parallel selection state.

The preview failure remains a `role="alert"` and receives inline alert classes. Do not add a new retry callback because none exists in the current interface.

- [ ] **Step 4: Implement the 58/42 split layout**

```css
.frame-screen { width: min(1280px, calc(100% - 64px)); height: calc(100vh - 72px); margin: 0 auto; padding: 24px 0 104px; display: grid; grid-template-columns: minmax(0, 58fr) minmax(320px, 42fr); gap: 32px; }
.frame-preview-panel, .frame-sidebar { min-height: 0; }
.frame-preview-panel { display: grid; place-items: center; border: 1px solid var(--color-border-default); border-radius: var(--radius-feature); background: var(--color-bg-photo); overflow: hidden; }
.composed-preview { max-height: calc(100vh - 220px); width: auto; object-fit: contain; box-shadow: var(--shadow-raised); }
.frame-sidebar { display: flex; min-width: 0; flex-direction: column; gap: 20px; }
.frame-options { min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 4px; }
.frame-option { position: relative; display: grid; gap: 10px; padding: 12px; border: 1px solid var(--color-border-default); border-radius: var(--radius-panel); background: var(--color-surface-default); cursor: pointer; }
.frame-option[data-selected="true"] { border: 3px solid var(--color-border-selected); padding: 10px; }
.frame-option input { position: absolute; width: 1px; height: 1px; opacity: 0; }
```

At `1024px`, reduce the sidebar minimum to `300px` and gap to `20px`.

- [ ] **Step 5: Run frame, compositor, and App tests**

Run: `npm test -- tests/operator/components/FrameScreen.test.tsx tests/operator/frames/browser-compositor.test.ts tests/operator/App.test.tsx`

Expected: PASS with identical compose arguments and object URL release counts.

- [ ] **Step 6: Commit the frame UI**

```bash
git add src/operator/components/FrameScreen.tsx src/operator/styles/screens.css tests/operator/components/FrameScreen.test.tsx
git commit -m "feat: style booth frame selection"
```

---

### Task 7: Style delivery, QR, timer urgency, and retry states

**Files:**
- Modify: `src/operator/components/QrScreen.tsx`
- Modify: `src/operator/App.tsx`
- Modify: `src/operator/styles/screens.css`
- Modify: `tests/operator/components/QrScreen.test.tsx`
- Modify: `tests/operator/App.test.tsx`

**Interfaces:**
- Consumes: existing issued session, QR rendering attempts, timer interval, and App retry callback.
- Produces: QR-safe card, completion hierarchy, presentation-only urgency tone, and styled delivery/error states.

- [ ] **Step 1: Add failing QR hierarchy and urgency assertions**

```tsx
expect(screen.getByRole("heading", { name: "사진이 완성됐어요" })).toBeVisible();
expect(screen.getByRole("img", { name: "사진 받기 QR 코드" })).toHaveClass("qr-image");
expect(screen.getByText("01:00")).toHaveAttribute("data-tone", "warning");
expect(screen.getByText("팀원 모두 각자 스캔할 수 있습니다")).toBeVisible();
```

For a ten-minute fixture, add timer cases that verify `neutral` above 2 minutes, `warning` at 2 minutes or below, and `danger` at 30 seconds or below. Keep every existing QR retry and `toDataURL` argument assertion.

- [ ] **Step 2: Run QR tests and verify hierarchy/tone assertions fail**

Run: `npm test -- tests/operator/components/QrScreen.test.tsx tests/operator/App.test.tsx`

Expected: FAIL on missing heading, classes, and tone attributes.

- [ ] **Step 3: Add a pure timer tone helper and QR presentation**

```ts
function timerTone(milliseconds: number): "neutral" | "warning" | "danger" {
  if (milliseconds <= 30_000) return "danger";
  if (milliseconds <= 120_000) return "warning";
  return "neutral";
}
```

Use this helper only for `data-tone`; do not change the interval, expiry calculation, or formatted time. Render:

```tsx
<section className="qr-screen" aria-label="QR 코드">
  <div className="qr-copy"><p className="eyebrow">READY TO SAVE</p><h1>사진이 완성됐어요</h1></div>
  <div className="qr-card">{/* existing error/loading/image branch */}</div>
  <output className="qr-timer" data-tone={timerTone(remaining)} aria-live="polite">{formatRemaining(remaining)}</output>
  <p>팀원 모두 각자 스캔할 수 있습니다</p>
  <p className="privacy-note">시간이 끝나면 암호화된 사진도 자동으로 삭제됩니다.</p>
</section>
```

Keep the hidden delivery URL test hook unchanged.

In `App.tsx`, style `delivering` and `ErrorScreen` with approved heading, helper text, loader, and button classes. Do not change `onRetry`.

- [ ] **Step 4: Implement QR-safe styling**

```css
.qr-screen { min-height: calc(100vh - 72px); display: grid; place-content: center; justify-items: center; gap: 20px; padding: 32px; text-align: center; }
.qr-card { width: 352px; min-height: 352px; display: grid; place-items: center; padding: 16px; border-radius: var(--radius-feature); background: white; box-shadow: var(--shadow-raised); }
.qr-image { width: 320px; height: 320px; image-rendering: pixelated; }
.qr-timer { font-size: 32px; font-weight: 700; font-variant-numeric: tabular-nums; }
.qr-timer[data-tone="warning"] { color: var(--color-status-warning); }
.qr-timer[data-tone="danger"] { color: var(--color-status-danger); }
```

Do not apply pseudo-elements, animation, filters, or overlays to `.qr-image`.

- [ ] **Step 5: Run QR, App, and E2E flow regression tests**

Run: `npm test -- tests/operator/components/QrScreen.test.tsx tests/operator/App.test.tsx && npm run test:e2e -- e2e/booth-flow.spec.ts`

Expected: unit and E2E tests pass; delivery URL, QR rendering, and retry behavior are unchanged.

- [ ] **Step 6: Commit delivery presentation**

```bash
git add src/operator/App.tsx src/operator/components/QrScreen.tsx src/operator/styles/screens.css tests/operator/components/QrScreen.test.tsx tests/operator/App.test.tsx
git commit -m "feat: style booth delivery states"
```

---

### Task 8: Apply the mobile recipient design without changing security or event order

**Files:**
- Modify: `src/recipient/client.ts`
- Modify: `src/recipient/page.css`
- Modify: `scripts/build-recipient.mjs`
- Modify: `tests/recipient/client.test.ts`
- Modify: `tests/server/recipient-page.test.ts`

**Interfaces:**
- Consumes: existing decrypt, fetch, history, key import, save, join URL, event metrics, and object URL lifecycle.
- Produces: styled loading, photo-ready, save-complete, expired, not-found, network, and decrypt-error recipient states.

- [ ] **Step 1: Add failing recipient presentation assertions while retaining security assertions**

For ready state:

```ts
expect(screen.getByRole("main")).toHaveClass("recipient-page", "recipient-page--ready");
expect(screen.getByText("UMC PHOTO BOOTH")).toBeVisible();
expect(screen.getByRole("heading", { name: "우리의 네컷이 도착했어요" })).toBeVisible();
expect(screen.getByText("사진은 이 기기 안에서만 복호화됐어요")).toBeVisible();
```

After save:

```ts
expect(screen.getByRole("button", { name: "사진 저장하기" })).toHaveAttribute("data-saved", "true");
expect(screen.getByText("사진을 저장했어요")).toBeVisible();
expect(screen.getByRole("link", { name: "지원 페이지 보기" })).toBeVisible();
```

For expiry, preserve the existing heading text assertion and add `recipient-page--expired` plus the helper copy `QR 발급 후 10분이 지나 암호화된 사진이 삭제됐습니다.`.

- [ ] **Step 2: Run recipient tests and verify presentation assertions fail**

Run: `npm test -- tests/recipient/client.test.ts tests/server/recipient-page.test.ts`

Expected: FAIL on new classes, brand text, headings, helper copy, and saved state.

- [ ] **Step 3: Add presentation helpers without touching the bootstrap sequence**

Keep `bootstrapRecipientPage` control flow unchanged. Add only DOM helpers used by `renderPhoto` and `renderMessage`:

```ts
function brand(root: Document): HTMLElement {
  const mark = root.createElement("p");
  mark.className = "recipient-brand";
  mark.textContent = "UMC PHOTO BOOTH";
  return mark;
}

function helper(root: Document, text: string): HTMLParagraphElement {
  const paragraph = root.createElement("p");
  paragraph.className = "recipient-helper";
  paragraph.textContent = text;
  return paragraph;
}
```

In `renderPhoto`, use `recipient-page recipient-page--ready`, heading `우리의 네컷이 도착했어요`, a `.recipient-photo-frame`, existing image, helper copy, existing save button, a hidden save-success line, and existing join link. Preserve the save listener order. In the existing `finally` block, add only presentation mutations before revealing the existing link:

```ts
saveButton.dataset.saved = "true";
saveSuccess.hidden = false;
joinLink.hidden = false;
void sendEvent(dependencies.fetch, "save_intent");
```

Keep `saveButton.textContent = "사진 저장하기"` and its accessible name unchanged.

Extend `renderMessage` with a pure copy map keyed by the exact existing messages. Do not alter which branch passes which message.

- [ ] **Step 4: Replace recipient CSS with mobile dark technical styles**

The CSS must include the same semantic colors, a dependency-free system font stack, safe areas, and no horizontal overflow:

```css
:root { color-scheme: dark; font-family: "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: #050807; color: #fff; }
.recipient-page { width: min(100%, 480px); min-height: 100svh; margin: 0 auto; padding: max(24px, env(safe-area-inset-top)) 20px max(24px, env(safe-area-inset-bottom)); display: grid; align-content: center; gap: 20px; text-align: center; }
.recipient-page--ready { align-content: start; }
.recipient-brand { margin: 0; color: #63c4b8; font-size: 13px; font-weight: 700; letter-spacing: .08em; }
.recipient-page h1 { margin: 0; font-size: clamp(28px, 8vw, 32px); line-height: 1.25; letter-spacing: -.02em; }
.recipient-photo-frame { min-height: 0; padding: 12px; border: 1px solid rgba(159,220,212,.4); border-radius: 28px; background: #0b0f0e; box-shadow: 0 16px 48px rgba(0,0,0,.36); }
.recipient-photo-frame img { width: 100%; max-height: 62svh; border-radius: 18px; object-fit: contain; }
.recipient-page button, .recipient-page a { min-height: 52px; display: grid; place-items: center; width: 100%; padding: 0 20px; border-radius: 12px; font: inherit; font-weight: 700; text-decoration: none; }
.recipient-page button { border: 0; color: #031412; background: #9fdcd4; }
.recipient-page a { border: 1px solid rgba(159,220,212,.4); color: white; background: rgba(12,42,37,.72); }
[hidden] { display: none !important; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 1ms !important; transition-duration: 80ms !important; } }
```

- [ ] **Step 5: Update only the recipient initial loading markup**

In `scripts/build-recipient.mjs`, keep the embedded JS, join config marker, route, and build settings unchanged. Change the initial main to:

```html
<main class="recipient-page recipient-page--loading">
  <p class="recipient-brand">UMC PHOTO BOOTH</p>
  <h1>사진을 안전하게 여는 중이에요</h1>
  <p class="recipient-helper">암호화된 사진을 불러오고 있어요</p>
  <span class="recipient-loader" aria-hidden="true"></span>
</main>
```

Add `<meta name="color-scheme" content="dark">` in `<head>`.

- [ ] **Step 6: Run recipient tests, build, and E2E save flow**

Run: `npm test -- tests/recipient/client.test.ts tests/server/recipient-page.test.ts tests/server/private-static-assets.test.ts && npm run build:recipient && npm run test:e2e -- e2e/booth-flow.spec.ts`

Expected: all tests pass; fragment scrubbing still precedes fetch/decrypt, save intent still reveals the link, and object URLs are released exactly once.

- [ ] **Step 7: Commit recipient presentation only**

```bash
git add src/recipient/client.ts src/recipient/page.css scripts/build-recipient.mjs tests/recipient/client.test.ts tests/server/recipient-page.test.ts
git commit -m "feat: style booth recipient experience"
```

---

### Task 9: Add responsive layout regression coverage

**Files:**
- Create: `e2e/ui-layout.spec.ts`
- Modify: `src/operator/styles/components.css`
- Modify: `src/operator/styles/screens.css`
- Modify: `src/recipient/page.css`

**Interfaces:**
- Consumes: completed operator and recipient presentation from Tasks 1–8 and existing E2E helper flow behavior.
- Produces: automated protection against horizontal overflow, hidden primary actions, broken 3×2 selection layout, undersized controls, and mobile recipient overflow.

- [ ] **Step 1: Write failing responsive E2E assertions**

Create `e2e/ui-layout.spec.ts` with local helper functions copied explicitly from the existing flow:

```ts
import { expect, test } from "@playwright/test";

test("operator welcome and selection fit the supported 1024px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "체험 시작" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);

  await page.getByRole("checkbox", { name: "모든 팀원이 촬영에 동의했습니다" }).check();
  await page.getByRole("button", { name: "체험 시작" }).click();
  await expect(page.getByAltText("촬영 사진 6")).toBeVisible();

  const cards = page.getByRole("button", { name: /촬영 사진 \d/ });
  const boxes = await cards.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  }));
  expect(new Set(boxes.map(({ x }) => x)).size).toBe(3);
  expect(new Set(boxes.map(({ y }) => y)).size).toBe(2);
  expect(boxes.every(({ width, height }) => width >= 48 && height >= 48)).toBe(true);
  await expect(page.getByRole("button", { name: "프레임 선택하기" })).toBeInViewport();
});

test("recipient fits a 390px mobile viewport without horizontal overflow", async ({ browser, page }) => {
  await page.goto("/");
  await page.getByRole("checkbox", { name: "모든 팀원이 촬영에 동의했습니다" }).check();
  await page.getByRole("button", { name: "체험 시작" }).click();
  await expect(page.getByAltText("촬영 사진 6")).toBeVisible();
  for (const number of [4, 1, 6, 3]) await page.getByAltText(`촬영 사진 ${number}`).click();
  await page.getByRole("button", { name: "프레임 선택하기" }).click();
  await page.getByRole("radio", { name: "기본 프레임" }).check();
  await page.getByRole("button", { name: "이 프레임으로 사진 만들기" }).click();
  const deliveryUrl = await page.getByTestId("delivery-url").getAttribute("data-url");

  const recipient = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await recipient.goto(deliveryUrl!);
  await expect(recipient.getByRole("button", { name: "사진 저장하기" })).toBeInViewport();
  expect(await recipient.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const buttonBox = await recipient.getByRole("button", { name: "사진 저장하기" }).boundingBox();
  expect(buttonBox?.height).toBeGreaterThanOrEqual(44);
  await recipient.close();
});
```

- [ ] **Step 2: Run the new layout spec against the current combined UI**

Run: `npm run test:e2e -- e2e/ui-layout.spec.ts`

Expected: the spec may pass if the earlier screen CSS already satisfies every boundary. If it fails, the output must identify a layout-only contract such as grid sizing, viewport placement, control height, or overflow; do not alter application behavior to make it pass.

- [ ] **Step 3: Tune only CSS at the supported viewport boundaries**

Add exact media-query behavior:

```css
@media (max-width: 1100px) {
  .operator-header { padding-inline: 20px; }
  .operator-steps span { padding-inline: 10px; }
  .selection-screen, .frame-screen { width: calc(100% - 40px); }
  .photo-grid { gap: 12px; }
}
@media (max-height: 760px) {
  .selection-screen { padding-top: 20px; padding-bottom: 92px; gap: 16px; }
  .screen-heading h1 { font-size: 28px; }
  .screen-actions { min-height: 80px; }
}
@media (max-width: 767px) {
  .operator-steps { display: none; }
}
```

For recipient CSS, ensure `min-width: 0`, `max-width: 100%`, and wrapping on every content child. Do not shrink the save button below 44px.

- [ ] **Step 4: Run all E2E specs**

Run: `npm run test:e2e`

Expected: all booth flow, reset/expiry, and UI layout tests pass with one worker.

- [ ] **Step 5: Commit responsive regression coverage**

```bash
git add e2e/ui-layout.spec.ts src/operator/styles/components.css src/operator/styles/screens.css src/recipient/page.css
git commit -m "test: cover booth UI layouts"
```

---

### Task 10: Final behavior-preservation and design QA gate

**Files:**
- Verify: `design.md`
- Verify: all files changed in Tasks 1–9
- Do not modify functional modules.

**Interfaces:**
- Consumes: complete visual implementation and all existing unit/E2E contracts.
- Produces: evidence that the visual layer matches the spec and existing functionality is unchanged.

- [ ] **Step 1: Prove that protected functional files and existing user edits were not changed**

Run:

```bash
shasum -a 256 \
  src/server/tunnel-supervisor.ts \
  src/shared/config.ts \
  tests/server/tunnel-supervisor.test.ts \
  tests/shared/config.test.ts \
  docs/operations.md

git diff --name-only HEAD -- \
  src/operator/booth-machine.ts \
  src/operator/camera \
  src/operator/delivery \
  src/operator/frames/browser-compositor.ts \
  src/server \
  src/shared
```

Expected: all five hashes still equal the Global Constraints values. The Git command may list the two already-dirty protected source files, but it must not list `booth-machine.ts`, camera, delivery, or compositor files. If a protected fingerprint changed during UI work, stop and identify the responsible UI commit before proceeding.

- [ ] **Step 2: Run the complete unit and integration suite**

Run: `npm test`

Expected: all Vitest suites pass with zero failures.

- [ ] **Step 3: Run the complete production build**

Run: `npm run build`

Expected: operator build, recipient build, and TypeScript typecheck all exit successfully.

- [ ] **Step 4: Run the complete E2E suite**

Run: `npm run test:e2e`

Expected: all Playwright tests pass; capture-to-selection, frame composition, encrypted delivery, save-before-join, reset, expiry, and layout contracts remain intact.

- [ ] **Step 5: Perform desktop visual inspection at the three required sizes**

Start: `npm run dev`

Inspect `1024 × 700`, `1440 × 900`, and `1728 × 1117` and verify:

- one mint-filled primary CTA per screen;
- no horizontal page scroll;
- camera fills the capture work area without tint;
- six photos are simultaneously comparable in a 3×2 grid;
- selection badges 1–4 remain legible without relying on border color;
- composed frame preview is larger than its frame options;
- QR is at least 320px, fully white-backed, and visually unmodified;
- reset and operator status remain visible but lower priority than the main CTA.

- [ ] **Step 6: Perform mobile visual inspection at the three required sizes**

Inspect `360 × 800`, `390 × 844`, and `430 × 932` and verify:

- no horizontal scroll;
- complete photo fits within 62svh;
- save button is visible, at least 44px high, and has the only filled mint treatment;
- support CTA is absent before save and present after save;
- safe-area padding prevents clipping;
- expired and decrypt-error states use distinct headings and helper copy.

- [ ] **Step 7: Check accessibility and motion contracts**

Verify by keyboard and browser emulation:

- tab order reaches consent, start, photo cards, frame radios, actions, status, and reset logically;
- all focus rings are visible;
- reset modal receives focus, Escape closes it, and focus returns to `처음으로`;
- `prefers-reduced-motion: reduce` disables transform-heavy animation;
- camera, photo, and QR retain unfiltered pixels;
- interactive names listed in Global Constraints remain unchanged.

- [ ] **Step 8: Check the final diff and commit only verification corrections if any were required**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and no unintended staged or modified protected files. If CSS-only corrections were made during QA:

```bash
git add src/operator/styles src/recipient/page.css e2e/ui-layout.spec.ts
git commit -m "fix: complete booth UI visual QA"
```

Do not create an empty commit when no corrections were necessary.
