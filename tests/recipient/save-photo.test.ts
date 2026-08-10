import { afterEach, describe, expect, it, vi } from "vitest";
import { savePhoto } from "../../src/recipient/save-photo";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("savePhoto", () => {
  it("downloads through a temporary anchor", async () => {
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
});
