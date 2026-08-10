# Recipient Download Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove native file sharing, always download the JPEG, and replace the recipient preview with a branded completion screen containing one support-site CTA.

**Architecture:** Keep browser download mechanics isolated in `save-photo.ts`. Keep recipient state rendering in `client.ts` by adding a dedicated completion renderer that releases the now-unused preview URL and replaces the document body only after download initiation succeeds. Extend the existing recipient CSS rather than replacing the user's in-progress mobile visual system.

**Tech Stack:** TypeScript, DOM APIs, Vitest, Testing Library, Playwright, esbuild, CSS

## Global Constraints

- Save only as `umc-photo-booth.jpg`; do not call `navigator.canShare()` or `navigator.share()`.
- After successful download initiation, show only `UMC PHOTO BOOTH`, `사진을 저장했어요`, and a `지원 페이지 바로가기` link.
- Preserve the configured HTTPS join URL and the fixed aggregate events `decrypt_success`, `save_intent`, and `join_click`.
- The approved separate completion screen supersedes `design.md` section 10.9's same-screen CTA reveal.
- Follow `design.md`: dark mobile surface, mint primary action, one meaningful `h1`, at least `44 × 44px` touch target, short opacity/translate entrance, and reduced-motion fallback at `80ms` or less.
- Preserve unrelated user changes in the dirty worktree.

---

### Task 1: Download-only photo saving

**Files:**
- Modify: `tests/recipient/save-photo.test.ts`
- Modify: `src/recipient/save-photo.ts`

**Interfaces:**
- Consumes: `Blob`, filename string, injected `Document`, and injected `URL` static methods.
- Produces: `savePhoto(blob: Blob, filename: string, dependencies?: SavePhotoDependencies): Promise<void>` with no `Navigator` dependency.

- [ ] **Step 1: Replace the share-first test with a failing download-only test**

```ts
it("downloads the photo without opening a native share sheet", async () => {
  vi.useFakeTimers();
  const click = vi.fn();
  const anchor = { click, download: "", href: "" };
  const createObjectURL = vi.fn(() => "blob:download");
  const revokeObjectURL = vi.fn();

  await savePhoto(new Blob(["jpeg"], { type: "image/jpeg" }), "umc-photo-booth.jpg", {
    document: { createElement: vi.fn(() => anchor) } as unknown as Document,
    url: { createObjectURL, revokeObjectURL } as unknown as typeof URL,
  });

  expect(anchor.download).toBe("umc-photo-booth.jpg");
  expect(anchor.href).toBe("blob:download");
  expect(click).toHaveBeenCalledOnce();
  vi.runOnlyPendingTimers();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:download");
});
```

Remove the old native-share test and redundant fallback test so the suite specifies one unconditional path.

- [ ] **Step 2: Run the focused test and verify the new dependency shape fails**

Run: `npm test -- --run tests/recipient/save-photo.test.ts`

Expected: FAIL because the current implementation reads `dependencies.navigator.canShare` before creating the download.

- [ ] **Step 3: Remove Web Share API code and the `Navigator` dependency**

```ts
export interface SavePhotoDependencies {
  document: Document;
  url: typeof URL;
}

export async function savePhoto(
  blob: Blob,
  filename: string,
  dependencies: SavePhotoDependencies = { document, url: URL },
): Promise<void> {
  const objectUrl = dependencies.url.createObjectURL(blob);
  const anchor = dependencies.document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => dependencies.url.revokeObjectURL(objectUrl), 0);
}
```

- [ ] **Step 4: Run the focused test and typecheck**

Run: `npm test -- --run tests/recipient/save-photo.test.ts && npm run typecheck`

Expected: the save-photo test passes and TypeScript reports no `navigator` dependency errors.

- [ ] **Step 5: Commit the isolated saving change**

```bash
git add src/recipient/save-photo.ts tests/recipient/save-photo.test.ts
git commit -m "fix: download recipient photos without sharing"
```

### Task 2: Branded completion state and failure recovery

**Files:**
- Modify: `tests/recipient/client.test.ts`
- Modify: `src/recipient/client.ts`
- Modify: `src/recipient/page.css`

**Interfaces:**
- Consumes: the existing `RecipientDependencies`, active `RecipientPageLifecycle`, decrypted photo Blob, and validated HTTPS join URL.
- Produces: a private `renderSaveComplete(root, lifecycle, fetcher, joinSiteUrl): void` renderer and a `recipient-page--complete` visual state.

- [ ] **Step 1: Change the recipient success test to require full screen replacement**

After clicking `사진 저장하기`, assert:

```ts
expect(savePhoto).toHaveBeenCalledWith(expect.any(Blob), "umc-photo-booth.jpg");
expect(screen.queryByAltText("완성된 네컷 사진")).not.toBeInTheDocument();
expect(screen.queryByRole("button", { name: "사진 저장하기" })).not.toBeInTheDocument();
expect(screen.getByText("UMC PHOTO BOOTH")).toBeVisible();
expect(screen.getByRole("heading", { name: "사진을 저장했어요" })).toBeVisible();
expect(screen.getByRole("link", { name: "지원 페이지 바로가기" })).toHaveAttribute(
  "href",
  "https://join.example.test/apply",
);
```

Update the pre-save assertion to query `지원 페이지 바로가기`, click that link after completion, and assert that event bodies are exactly `decrypt_success`, `save_intent`, then `join_click` without the delivery token.

- [ ] **Step 2: Add a failing test for download-initiation failure**

```ts
it("keeps the preview and re-enables saving when download initiation fails", async () => {
  const key = await generatePhotoKey();
  const ciphertext = await encryptPhoto(new Uint8Array(await savedBlob.arrayBuffer()), key);
  const responseBytes = new Uint8Array(ciphertext.byteLength);
  responseBytes.set(ciphertext);
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(responseBytes.buffer))
    .mockResolvedValue(new Response(null, { status: 204 }));
  const savePhoto = vi.fn(async () => { throw new Error("download failed"); });
  const user = userEvent.setup();

  await bootstrapRecipientPage(document, {
    decryptPhoto,
    fetch: fetchMock,
    importKeyFragment: async () => key,
    joinSiteUrl: "https://join.example.test/apply",
    location: new URL("https://booth.test/d/token-value#key=secret-fragment"),
    savePhoto,
    createObjectURL: () => "blob:photo-preview",
  });

  await user.click(screen.getByRole("button", { name: "사진 저장하기" }));

  expect(screen.getByAltText("완성된 네컷 사진")).toBeVisible();
  expect(screen.getByRole("button", { name: "사진 저장하기" })).toBeEnabled();
  expect(screen.queryByRole("link", { name: "지원 페이지 바로가기" })).not.toBeInTheDocument();
  const eventBodies = fetchMock.mock.calls
    .filter(([url]) => url === "/events")
    .map(([, init]) => String(init?.body));
  expect(eventBodies).toEqual([JSON.stringify({ event: "decrypt_success" })]);
});
```

- [ ] **Step 3: Run the client tests and verify both fail for the intended reasons**

Run: `npm test -- --run tests/recipient/client.test.ts`

Expected: FAIL because the current code retains the photo screen, uses `지원 페이지 보기`, and transitions in `finally` even when saving rejects.

- [ ] **Step 4: Implement the successful completion renderer**

Add a focused private renderer:

```ts
function renderSaveComplete(
  root: Document,
  lifecycle: RecipientPageLifecycle,
  fetcher: typeof fetch,
  joinSiteUrl: string,
): void {
  if (!isCurrentPage(root, lifecycle)) return;
  if (lifecycle.previewObjectUrl) {
    lifecycle.revokeObjectURL(lifecycle.previewObjectUrl);
    lifecycle.previewObjectUrl = null;
  }
  const container = root.createElement("main");
  container.className = "recipient-page recipient-page--complete";
  const brand = createBrand(root);
  const heading = root.createElement("h1");
  heading.textContent = "사진을 저장했어요";
  const joinLink = root.createElement("a");
  joinLink.className = "recipient-primary recipient-complete-link";
  joinLink.href = joinSiteUrl;
  joinLink.textContent = "지원 페이지 바로가기";
  joinLink.addEventListener("click", () => void sendEvent(fetcher, "join_click"));
  container.append(brand, heading, joinLink);
  root.body.replaceChildren(container);
}
```

Change the save handler so success renders the completion state and records `save_intent`; rejection only re-enables the still-mounted button:

```ts
saveButton.addEventListener("click", async () => {
  saveButton.disabled = true;
  try {
    await dependencies.savePhoto(photo, "umc-photo-booth.jpg");
    if (!isCurrentPage(root, lifecycle)) return;
    renderSaveComplete(root, lifecycle, dependencies.fetch, joinSiteUrl);
    void sendEvent(dependencies.fetch, "save_intent");
  } catch {
    if (isCurrentPage(root, lifecycle)) saveButton.disabled = false;
  }
});
```

Remove the old hidden success paragraph and hidden support link from `renderPhoto`.

- [ ] **Step 5: Style the completion screen from `design.md`**

Retain all existing user-authored recipient styles. Replace now-unused `.recipient-save-success` and `[data-saved]` rules with a completion state:

```css
.recipient-page--complete {
  width: min(100%, 26rem);
  justify-items: stretch;
}

.recipient-page--complete > * {
  animation: recipient-complete-in 360ms cubic-bezier(.2, .9, .2, 1) both;
}

.recipient-page--complete h1 {
  margin-bottom: 1rem;
}

.recipient-complete-link {
  min-height: 3.25rem;
}

@keyframes recipient-complete-in {
  from { opacity: 0; transform: translateY(0.5rem); }
  to { opacity: 1; transform: translateY(0); }
}
```

In the existing reduced-motion media query, replace the transform animation with an opacity-only animation lasting no more than `80ms`.

```css
@keyframes recipient-complete-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .recipient-page--complete > * {
    animation: recipient-complete-fade 80ms linear both;
  }
}
```

- [ ] **Step 6: Run the recipient tests**

Run: `npm test -- --run tests/recipient/client.test.ts tests/recipient/save-photo.test.ts`

Expected: both files pass, including success replacement, click metrics, object URL release, and retryable failure.

- [ ] **Step 7: Commit the completion screen**

```bash
git add src/recipient/client.ts src/recipient/page.css tests/recipient/client.test.ts
git commit -m "feat: show recipient download completion screen"
```

### Task 3: End-to-end copy and bundle verification

**Files:**
- Modify: `e2e/booth-flow.spec.ts`

**Interfaces:**
- Consumes: the bundled recipient page served from the existing public delivery URL.
- Produces: end-to-end coverage for the approved completion-screen accessible names.

- [ ] **Step 1: Update the E2E assertion to the completion screen contract**

```ts
await expect(recipient.getByRole("link", { name: "지원 페이지 바로가기" })).toHaveCount(0);
await recipient.getByRole("button", { name: "사진 저장하기" }).click();
await expect(recipient.getByRole("heading", { name: "사진을 저장했어요" })).toBeVisible();
await expect(recipient.getByRole("link", { name: "지원 페이지 바로가기" })).toBeVisible();
await expect(recipient.getByAltText("완성된 네컷 사진")).toHaveCount(0);
```

- [ ] **Step 2: Build the inline recipient bundle**

Run: `npm run build:recipient && npm run typecheck`

Expected: esbuild and TypeScript exit successfully, and the inline bundle contains the new completion copy.

- [ ] **Step 3: Run the complete automated verification**

Run: `npm test && npm run build`

Expected: all Vitest files pass and the complete operator/recipient build exits with code 0.

- [ ] **Step 4: Run the booth-flow E2E when its configured browser/runtime is available**

Run: `npm run test:e2e -- e2e/booth-flow.spec.ts`

Expected: the booth flow reaches the recipient preview, downloads, and displays the standalone completion screen. If the local browser/runtime is unavailable, report that environment limitation separately rather than weakening the test.

- [ ] **Step 5: Commit the E2E copy update**

```bash
git add e2e/booth-flow.spec.ts
git commit -m "test: cover recipient completion screen"
```
