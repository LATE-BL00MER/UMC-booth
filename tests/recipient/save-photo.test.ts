import { afterEach, describe, expect, it, vi } from "vitest";
import { savePhoto } from "../../src/recipient/save-photo";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("savePhoto", () => {
  it("uses the native share sheet when the photo file can be shared", async () => {
    const canShare = vi.fn(() => true);
    const share = vi.fn(async () => undefined);
    const click = vi.fn();
    const document = { createElement: vi.fn(() => ({ click })) } as unknown as Document;

    await savePhoto(new Blob(["jpeg"], { type: "image/jpeg" }), "umc-photo-booth.jpg", {
      document,
      navigator: { canShare, share } as unknown as Navigator,
      url: { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() } as unknown as typeof URL,
    });

    expect(canShare).toHaveBeenCalledWith({ files: [expect.any(File)] });
    expect(share).toHaveBeenCalledWith({ files: [expect.any(File)] });
    expect(click).not.toHaveBeenCalled();
  });

  it("downloads through a temporary anchor when native sharing is unavailable", async () => {
    vi.useFakeTimers();
    const click = vi.fn();
    const anchor = { click, download: "", href: "" };
    const createObjectURL = vi.fn(() => "blob:download");
    const revokeObjectURL = vi.fn();

    await savePhoto(new Blob(["jpeg"], { type: "image/jpeg" }), "umc-photo-booth.jpg", {
      document: { createElement: vi.fn(() => anchor) } as unknown as Document,
      navigator: {} as Navigator,
      url: { createObjectURL, revokeObjectURL } as unknown as typeof URL,
    });

    expect(anchor.download).toBe("umc-photo-booth.jpg");
    expect(anchor.href).toBe("blob:download");
    expect(click).toHaveBeenCalledOnce();
    vi.runOnlyPendingTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:download");
  });
});
