import { screen } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptPhoto, encryptPhoto, generatePhotoKey } from "../../src/shared/crypto-envelope";
import { bootstrapRecipientPage, teardownRecipientPage } from "../../src/recipient/client";

const savedBlob = new Blob(["jpeg-fixture"], { type: "image/jpeg" });

afterEach(() => {
  teardownRecipientPage(document);
  document.body.replaceChildren();
});

describe("recipient page", () => {
  it("fetches ciphertext without sending the key and reveals the CTA after save intent", async () => {
    const key = await generatePhotoKey();
    const ciphertext = await encryptPhoto(new Uint8Array(await savedBlob.arrayBuffer()), key);
    const responseBytes = new Uint8Array(ciphertext.byteLength);
    responseBytes.set(ciphertext);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(responseBytes.buffer))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const savePhoto = vi.fn(async () => undefined);
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

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/f/token-value");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("secret-fragment");
    expect(screen.getByAltText("완성된 네컷 사진")).toHaveAttribute("src", "blob:photo-preview");
    expect(screen.queryByRole("link", { name: "지원 페이지 보기" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ event: "decrypt_success" }),
      method: "POST",
    });

    await user.click(screen.getByRole("button", { name: "사진 저장하기" }));

    expect(savePhoto).toHaveBeenCalledWith(expect.any(Blob), "umc-photo-booth.jpg");
    expect(screen.getByRole("link", { name: "지원 페이지 보기" })).toHaveAttribute(
      "href",
      "https://join.example.test/apply",
    );
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({
      body: JSON.stringify({ event: "save_intent" }),
      method: "POST",
    });
    const eventBodies = fetchMock.mock.calls
      .filter(([url]) => url === "/events")
      .map(([, init]) => String(init?.body));
    expect(eventBodies).toEqual([
      JSON.stringify({ event: "decrypt_success" }),
      JSON.stringify({ event: "save_intent" }),
    ]);
    expect(eventBodies.every((body) => !body.includes("token-value"))).toBe(true);
  });

  it("shows the deletion-complete state for an expired photo", async () => {
    await bootstrapRecipientPage(document, {
      decryptPhoto,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 410 })),
      importKeyFragment: vi.fn(),
      joinSiteUrl: "https://join.example.test/apply",
      location: new URL("https://booth.test/d/token-value#key=secret-fragment"),
      savePhoto: vi.fn(),
      createObjectURL: () => "blob:photo-preview",
    });

    expect(screen.getByText("사진이 자동 삭제되었습니다")).toBeVisible();
  });

  it("rejects a non-HTTPS application link before rendering the photo", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await bootstrapRecipientPage(document, {
      decryptPhoto,
      fetch: fetchMock,
      importKeyFragment: vi.fn(),
      joinSiteUrl: "http://join.example.test/apply",
      location: new URL("https://booth.test/d/token-value#key=secret-fragment"),
      savePhoto: vi.fn(),
      createObjectURL: () => "blob:photo-preview",
    });

    expect(screen.getByText("사진을 열 수 없습니다")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("releases the preview object URL exactly once when its page is torn down", async () => {
    const key = await generatePhotoKey();
    const ciphertext = await encryptPhoto(new Uint8Array(await savedBlob.arrayBuffer()), key);
    const responseBytes = new Uint8Array(ciphertext.byteLength);
    responseBytes.set(ciphertext);
    const revokeObjectURL = vi.fn();

    const teardown = await bootstrapRecipientPage(document, {
      decryptPhoto,
      fetch: vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(responseBytes.buffer))
        .mockResolvedValue(new Response(null, { status: 204 })),
      importKeyFragment: async () => key,
      joinSiteUrl: "https://join.example.test/apply",
      location: new URL("https://booth.test/d/token-value#key=secret-fragment"),
      savePhoto: vi.fn(),
      createObjectURL: () => "blob:preview-to-release",
      revokeObjectURL,
    });

    expect(revokeObjectURL).not.toHaveBeenCalled();
    teardown();
    teardown();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-to-release");
  });

  it("releases the preview URL when the browser tears the page down", async () => {
    const key = await generatePhotoKey();
    const ciphertext = await encryptPhoto(new Uint8Array(await savedBlob.arrayBuffer()), key);
    const responseBytes = new Uint8Array(ciphertext.byteLength);
    responseBytes.set(ciphertext);
    const revokeObjectURL = vi.fn();

    await bootstrapRecipientPage(document, {
      decryptPhoto,
      fetch: vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(responseBytes.buffer))
        .mockResolvedValue(new Response(null, { status: 204 })),
      importKeyFragment: async () => key,
      joinSiteUrl: "https://join.example.test/apply",
      location: new URL("https://booth.test/d/token-value#key=secret-fragment"),
      savePhoto: vi.fn(),
      createObjectURL: () => "blob:pagehide-preview",
      revokeObjectURL,
    });

    document.defaultView?.dispatchEvent(new Event("pagehide"));
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:pagehide-preview");
  });

  it("does not create a preview URL when a fetch resolves after teardown", async () => {
    const key = await generatePhotoKey();
    const ciphertext = await encryptPhoto(new Uint8Array(await savedBlob.arrayBuffer()), key);
    const responseBytes = new Uint8Array(ciphertext.byteLength);
    responseBytes.set(ciphertext);
    let resolveResponse!: (response: Response) => void;
    const createObjectURL = vi.fn(() => "blob:stale-preview");
    const revokeObjectURL = vi.fn();

    const bootstrap = bootstrapRecipientPage(document, {
      decryptPhoto,
      fetch: vi.fn<typeof fetch>(() => new Promise((resolve) => {
        resolveResponse = resolve;
      })),
      importKeyFragment: async () => key,
      joinSiteUrl: "https://join.example.test/apply",
      location: new URL("https://booth.test/d/token-value#key=secret-fragment"),
      savePhoto: vi.fn(),
      createObjectURL,
      revokeObjectURL,
    });

    teardownRecipientPage(document);
    resolveResponse(new Response(responseBytes.buffer));
    await bootstrap;

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("releases the old preview URL before rendering a replacement page", async () => {
    const key = await generatePhotoKey();
    const ciphertext = await encryptPhoto(new Uint8Array(await savedBlob.arrayBuffer()), key);
    const responseBytes = new Uint8Array(ciphertext.byteLength);
    responseBytes.set(ciphertext);
    const revokeObjectURL = vi.fn();
    const sharedDependencies = {
      decryptPhoto,
      importKeyFragment: async () => key,
      joinSiteUrl: "https://join.example.test/apply",
      location: new URL("https://booth.test/d/token-value#key=secret-fragment"),
      savePhoto: vi.fn(),
      createObjectURL: () => "blob:replaced-preview",
      revokeObjectURL,
    };

    await bootstrapRecipientPage(document, {
      ...sharedDependencies,
      fetch: vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(responseBytes.buffer))
        .mockResolvedValue(new Response(null, { status: 204 })),
    });
    await bootstrapRecipientPage(document, {
      ...sharedDependencies,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 410 })),
    });

    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:replaced-preview");
  });
});
