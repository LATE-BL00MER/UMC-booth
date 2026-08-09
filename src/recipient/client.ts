import { decryptPhoto, importKeyFragment } from "../shared/crypto-envelope";
import { savePhoto } from "./save-photo";

declare global {
  interface Window {
    __UMC_JOIN_SITE_URL__?: unknown;
  }
}

type AggregateEvent = "decrypt_success" | "save_intent" | "join_click";

export interface RecipientDependencies {
  createObjectURL: (blob: Blob) => string;
  decryptPhoto: typeof decryptPhoto;
  fetch: typeof fetch;
  history: Pick<History, "replaceState">;
  importKeyFragment: typeof importKeyFragment;
  joinSiteUrl?: unknown;
  location: URL;
  revokeObjectURL: (url: string) => void;
  savePhoto: typeof savePhoto;
}

interface RecipientPageLifecycle {
  active: boolean;
  onPageHide: (() => void) | null;
  pageWindow: Window | null;
  previewObjectUrl: string | null;
  revokeObjectURL: (url: string) => void;
}

const pageLifecycles = new WeakMap<Document, RecipientPageLifecycle>();

const defaultDependencies: RecipientDependencies = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  decryptPhoto,
  fetch: window.fetch.bind(window),
  history: window.history,
  importKeyFragment,
  joinSiteUrl: window.__UMC_JOIN_SITE_URL__,
  location: new URL(window.location.href),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  savePhoto,
};

export async function bootstrapRecipientPage(
  root: Document,
  suppliedDependencies: Partial<RecipientDependencies> = {},
): Promise<() => void> {
  const dependencies = { ...defaultDependencies, ...suppliedDependencies };
  const lifecycle = beginPage(root, dependencies.revokeObjectURL);
  const teardown = () => disposePage(root, lifecycle);
  const joinSiteUrl = httpsUrl(dependencies.joinSiteUrl);

  if (!joinSiteUrl) {
    renderMessage(root, lifecycle, "사진을 열 수 없습니다");
    return teardown;
  }

  const token = tokenFromPath(dependencies.location.pathname);
  const keyFragment = keyFromHash(dependencies.location.hash);
  if (!token || !keyFragment) {
    renderMessage(root, lifecycle, "사진을 열 수 없습니다");
    return teardown;
  }

  // The fragment never reaches the server, but it must also leave local browser history
  // before any request or cryptographic work can expose a recoverable page URL.
  dependencies.history.replaceState(null, "", `${dependencies.location.pathname}${dependencies.location.search}`);

  let response: Response;
  try {
    response = await dependencies.fetch(`/f/${token}`, { cache: "no-store", credentials: "omit" });
  } catch {
    renderMessage(root, lifecycle, "사진을 불러오지 못했습니다");
    return teardown;
  }

  if (!isCurrentPage(root, lifecycle)) {
    return teardown;
  }

  if (response.status === 410) {
    renderMessage(root, lifecycle, "사진이 자동 삭제되었습니다");
    return teardown;
  }
  if (!response.ok) {
    renderMessage(root, lifecycle, "사진을 찾을 수 없습니다");
    return teardown;
  }

  try {
    const key = await dependencies.importKeyFragment(keyFragment);
    const plaintext = await dependencies.decryptPhoto(new Uint8Array(await response.arrayBuffer()), key);
    if (!isCurrentPage(root, lifecycle)) {
      return teardown;
    }
    const photoBytes = new Uint8Array(plaintext.byteLength);
    photoBytes.set(plaintext);
    const photo = new Blob([photoBytes.buffer], { type: "image/jpeg" });
    if (renderPhoto(root, lifecycle, photo, dependencies, joinSiteUrl)) {
      void sendEvent(dependencies.fetch, "decrypt_success");
    }
  } catch {
    renderMessage(root, lifecycle, "사진을 열 수 없습니다");
  }
  return teardown;
}

export function teardownRecipientPage(root: Document): void {
  const lifecycle = pageLifecycles.get(root);
  if (lifecycle) disposePage(root, lifecycle);
}

function renderPhoto(
  root: Document,
  lifecycle: RecipientPageLifecycle,
  photo: Blob,
  dependencies: RecipientDependencies,
  joinSiteUrl: string,
): boolean {
  if (!isCurrentPage(root, lifecycle)) return false;
  const container = root.createElement("main");
  container.className = "recipient-page";
  const heading = root.createElement("h1");
  heading.textContent = "사진이 준비되었습니다";
  const image = root.createElement("img");
  image.alt = "완성된 네컷 사진";
  const previewObjectUrl = dependencies.createObjectURL(photo);
  image.src = previewObjectUrl;
  const saveButton = root.createElement("button");
  saveButton.type = "button";
  saveButton.textContent = "사진 저장하기";
  const joinLink = root.createElement("a");
  joinLink.href = joinSiteUrl;
  joinLink.textContent = "지원 페이지 보기";
  joinLink.hidden = true;
  joinLink.addEventListener("click", () => {
    void sendEvent(dependencies.fetch, "join_click");
  });
  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    try {
      await dependencies.savePhoto(photo, "umc-photo-booth.jpg");
    } catch {
      // A native share sheet can reject after it has already been opened.
    } finally {
      joinLink.hidden = false;
      void sendEvent(dependencies.fetch, "save_intent");
    }
  });
  container.append(heading, image, saveButton, joinLink);
  root.body.replaceChildren(container);
  lifecycle.previewObjectUrl = previewObjectUrl;
  return true;
}

function renderMessage(root: Document, lifecycle: RecipientPageLifecycle, message: string): void {
  if (!isCurrentPage(root, lifecycle)) return;
  const container = root.createElement("main");
  container.className = "recipient-page";
  const heading = root.createElement("h1");
  heading.textContent = message;
  container.append(heading);
  root.body.replaceChildren(container);
}

function beginPage(root: Document, revokeObjectURL: (url: string) => void): RecipientPageLifecycle {
  teardownRecipientPage(root);
  const lifecycle: RecipientPageLifecycle = {
    active: true,
    onPageHide: null,
    pageWindow: root.defaultView,
    previewObjectUrl: null,
    revokeObjectURL,
  };
  pageLifecycles.set(root, lifecycle);
  if (lifecycle.pageWindow) {
    lifecycle.onPageHide = () => disposePage(root, lifecycle);
    lifecycle.pageWindow.addEventListener("pagehide", lifecycle.onPageHide, { once: true });
  }
  return lifecycle;
}

function disposePage(root: Document, lifecycle: RecipientPageLifecycle): void {
  if (!lifecycle.active) return;
  lifecycle.active = false;
  if (lifecycle.previewObjectUrl) {
    lifecycle.revokeObjectURL(lifecycle.previewObjectUrl);
    lifecycle.previewObjectUrl = null;
  }
  if (lifecycle.pageWindow && lifecycle.onPageHide) {
    lifecycle.pageWindow.removeEventListener("pagehide", lifecycle.onPageHide);
    lifecycle.onPageHide = null;
  }
  if (pageLifecycles.get(root) === lifecycle) {
    pageLifecycles.delete(root);
  }
}

function isCurrentPage(root: Document, lifecycle: RecipientPageLifecycle): boolean {
  return lifecycle.active && pageLifecycles.get(root) === lifecycle;
}

function tokenFromPath(pathname: string): string | null {
  const match = /^\/d\/([^/]+)$/.exec(pathname);
  return match?.[1] ?? null;
}

function keyFromHash(hash: string): string | null {
  const parameters = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const keys = parameters.getAll("key");
  return keys.length === 1 && keys[0] ? keys[0] : null;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

async function sendEvent(fetcher: typeof fetch, event: AggregateEvent): Promise<void> {
  try {
    await fetcher("/events", {
      body: JSON.stringify({ event }),
      cache: "no-store",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      keepalive: true,
      method: "POST",
    });
  } catch {
    // Metrics must never prevent a recipient from receiving or saving their photo.
  }
}
