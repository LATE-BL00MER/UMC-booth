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
  importKeyFragment: typeof importKeyFragment;
  joinSiteUrl?: unknown;
  location: URL;
  savePhoto: typeof savePhoto;
}

const defaultDependencies: RecipientDependencies = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  decryptPhoto,
  fetch: window.fetch.bind(window),
  importKeyFragment,
  joinSiteUrl: window.__UMC_JOIN_SITE_URL__,
  location: new URL(window.location.href),
  savePhoto,
};

export async function bootstrapRecipientPage(
  root: Document,
  suppliedDependencies: Partial<RecipientDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultDependencies, ...suppliedDependencies };
  const joinSiteUrl = httpsUrl(dependencies.joinSiteUrl);

  if (!joinSiteUrl) {
    renderMessage(root, "사진을 열 수 없습니다");
    return;
  }

  const token = tokenFromPath(dependencies.location.pathname);
  const keyFragment = keyFromHash(dependencies.location.hash);
  if (!token || !keyFragment) {
    renderMessage(root, "사진을 열 수 없습니다");
    return;
  }

  let response: Response;
  try {
    response = await dependencies.fetch(`/f/${token}`, { cache: "no-store", credentials: "omit" });
  } catch {
    renderMessage(root, "사진을 불러오지 못했습니다");
    return;
  }

  if (response.status === 410) {
    renderMessage(root, "사진이 자동 삭제되었습니다");
    return;
  }
  if (!response.ok) {
    renderMessage(root, "사진을 찾을 수 없습니다");
    return;
  }

  try {
    const key = await dependencies.importKeyFragment(keyFragment);
    const plaintext = await dependencies.decryptPhoto(new Uint8Array(await response.arrayBuffer()), key);
    const photoBytes = new Uint8Array(plaintext.byteLength);
    photoBytes.set(plaintext);
    const photo = new Blob([photoBytes.buffer], { type: "image/jpeg" });
    renderPhoto(root, photo, dependencies, joinSiteUrl);
    void sendEvent(dependencies.fetch, "decrypt_success");
  } catch {
    renderMessage(root, "사진을 열 수 없습니다");
  }
}

function renderPhoto(
  root: Document,
  photo: Blob,
  dependencies: RecipientDependencies,
  joinSiteUrl: string,
): void {
  const container = root.createElement("main");
  container.className = "recipient-page";
  const heading = root.createElement("h1");
  heading.textContent = "사진이 준비되었습니다";
  const image = root.createElement("img");
  image.alt = "완성된 네컷 사진";
  image.src = dependencies.createObjectURL(photo);
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
}

function renderMessage(root: Document, message: string): void {
  const container = root.createElement("main");
  container.className = "recipient-page";
  const heading = root.createElement("h1");
  heading.textContent = message;
  container.append(heading);
  root.body.replaceChildren(container);
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
