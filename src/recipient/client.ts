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
  storage: Pick<Storage, "getItem" | "setItem">;
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
  storage: window.sessionStorage,
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
  const suppliedKeyFragment = keyFromHash(dependencies.location.hash);
  if (token && suppliedKeyFragment) {
    retainKeyFragment(dependencies.storage, token, suppliedKeyFragment);
  }
  const keyFragment = suppliedKeyFragment
    ?? (token ? retainedKeyFragment(dependencies.storage, token) : null);
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
  container.className = "recipient-page recipient-page--ready";
  const brand = createBrand(root);
  const heading = root.createElement("h1");
  heading.textContent = "우리의 네컷이 도착했어요";
  const photoFrame = root.createElement("div");
  photoFrame.className = "recipient-photo-frame";
  const image = root.createElement("img");
  image.alt = "완성된 네컷 사진";
  const previewObjectUrl = dependencies.createObjectURL(photo);
  image.src = previewObjectUrl;
  photoFrame.append(image);
  const helper = createHelper(root, "사진은 이 기기 안에서만 복호화됐어요");
  const saveButton = root.createElement("button");
  saveButton.className = "recipient-primary";
  saveButton.type = "button";
  saveButton.textContent = "사진 저장하기";
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
  container.append(brand, heading, photoFrame, helper, saveButton);
  root.body.replaceChildren(container);
  lifecycle.previewObjectUrl = previewObjectUrl;
  return true;
}

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
  joinLink.addEventListener("click", () => {
    void sendEvent(fetcher, "join_click");
  });
  container.append(brand, heading, joinLink);
  root.body.replaceChildren(container);
}

function renderMessage(root: Document, lifecycle: RecipientPageLifecycle, message: string): void {
  if (!isCurrentPage(root, lifecycle)) return;
  const container = root.createElement("main");
  container.className = "recipient-page recipient-page--message";
  const brand = createBrand(root);
  const heading = root.createElement("h1");
  heading.textContent = message;
  const helper = createHelper(root, messageHelper(message));
  container.append(brand, heading, helper);
  root.body.replaceChildren(container);
}

function createBrand(root: Document): HTMLParagraphElement {
  const brand = root.createElement("p");
  brand.className = "recipient-brand";
  brand.textContent = "UMC PHOTO BOOTH";
  return brand;
}

function createHelper(root: Document, text: string): HTMLParagraphElement {
  const helper = root.createElement("p");
  helper.className = "recipient-helper";
  helper.textContent = text;
  return helper;
}

function messageHelper(message: string): string {
  if (message === "사진이 자동 삭제되었습니다") {
    return "QR 발급 후 5분이 지나 암호화된 사진이 삭제됐습니다.";
  }
  if (message === "사진을 불러오지 못했습니다") {
    return "네트워크 연결을 확인한 뒤 QR을 다시 열어 주세요.";
  }
  if (message === "사진을 찾을 수 없습니다") {
    return "사진 주소가 올바른지 확인해 주세요.";
  }
  return "보안을 위해 평문 대체 링크는 제공하지 않습니다.";
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

function retainedKeyFragment(
  storage: Pick<Storage, "getItem">,
  token: string,
): string | null {
  try {
    return storage.getItem(keyStorageName(token))?.trim() || null;
  } catch {
    return null;
  }
}

function retainKeyFragment(
  storage: Pick<Storage, "setItem">,
  token: string,
  keyFragment: string,
): void {
  try {
    storage.setItem(keyStorageName(token), keyFragment);
  } catch {
    // Some privacy modes disable session storage. The in-memory fragment still works.
  }
}

function keyStorageName(token: string): string {
  return `umc-photo-booth-photo-key:${token}`;
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
