import { describe, expect, it, vi } from "vitest";
import {
  loadFramePack,
  loadFramePacks,
  parseFrameManifest,
  parseFramePackIndex,
} from "../../../src/operator/frames/frame-repository";

const validFrame = {
  id: "basic",
  label: "Basic",
  canvas: { width: 1200, height: 1800 },
  jpegQuality: 0.92,
  thumbnail: "thumbnail.svg",
  overlay: "overlay.svg",
  slots: [
    { x: 30, y: 30, width: 540, height: 720, rotation: 0, fit: "cover" },
    { x: 630, y: 30, width: 540, height: 720, rotation: 0, fit: "cover" },
    { x: 30, y: 1050, width: 540, height: 720, rotation: 0, fit: "cover" },
    { x: 630, y: 1050, width: 540, height: 720, rotation: 0, fit: "cover" },
  ],
};

describe("frame manifests", () => {
  it("parses a valid four-slot frame manifest", () => {
    expect(parseFrameManifest(validFrame)).toEqual(validFrame);
  });

  it("rejects any frame that does not have exactly four slots", () => {
    expect(() => parseFrameManifest({ ...validFrame, slots: validFrame.slots.slice(0, 3) })).toThrow(
      "Frame requires exactly four slots",
    );
  });

  it("rejects invalid output quality and non-positive canvas or slot dimensions", () => {
    expect(() => parseFrameManifest({ ...validFrame, jpegQuality: 0.49 })).toThrow();
    expect(() => parseFrameManifest({ ...validFrame, canvas: { width: 0, height: 1800 } })).toThrow();
    expect(() => parseFrameManifest({ ...validFrame, slots: [{ ...validFrame.slots[0], height: 0 }, ...validFrame.slots.slice(1)] })).toThrow();
  });

  it("loads and validates a manifest relative to its pack base URL", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(validFrame)));

    await expect(loadFramePack("/frame-pack/basic", fetcher)).resolves.toEqual({
      ...validFrame,
      thumbnail: "/frame-pack/basic/thumbnail.svg",
      overlay: "/frame-pack/basic/overlay.svg",
    });
    expect(fetcher).toHaveBeenCalledWith("/frame-pack/basic/manifest.json");
  });

  it("loads every frame listed by the pack index in order", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/frame-pack/index.json") {
        return new Response(JSON.stringify({ packs: ["sky", "ticket"] }));
      }
      const id = String(input).includes("/sky/") ? "sky" : "ticket";
      return new Response(JSON.stringify({ ...validFrame, id, label: id }));
    });

    await expect(loadFramePacks("/frame-pack/", fetcher)).resolves.toEqual([
      expect.objectContaining({ id: "sky", overlay: "/frame-pack/sky/overlay.svg" }),
      expect.objectContaining({ id: "ticket", overlay: "/frame-pack/ticket/overlay.svg" }),
    ]);
  });

  it("rejects unsafe or empty frame pack indexes", () => {
    expect(() => parseFramePackIndex({ packs: [] })).toThrow();
    expect(() => parseFramePackIndex({ packs: ["../secret"] })).toThrow();
  });
});
