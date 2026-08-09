import { describe, expect, it } from "vitest";
import {
  BrowserCompositor,
  type CanvasPort,
  type CanvasSurface,
} from "../../../src/operator/frames/browser-compositor";
import type { FrameManifest } from "../../../src/operator/frames/frame-contract";

const frame: FrameManifest = {
  id: "basic",
  label: "Basic",
  canvas: { width: 1200, height: 1800 },
  jpegQuality: 0.92,
  thumbnail: "thumbnail.svg",
  overlay: "overlay.svg",
  slots: [
    { x: 30, y: 30, width: 540, height: 720, rotation: 0, fit: "cover" },
    { x: 630, y: 30, width: 540, height: 720, rotation: 1, fit: "cover" },
    { x: 30, y: 1050, width: 540, height: 720, rotation: 0, fit: "cover" },
    { x: 630, y: 1050, width: 540, height: 720, rotation: 0, fit: "cover" },
  ],
};

class RecordingCanvasPort implements CanvasPort {
  readonly operations: Array<{ source: string }> = [];
  readonly revoked: string[] = [];
  readonly output = new Blob(["jpeg"], { type: "image/jpeg" });

  createCanvas(): CanvasSurface {
    return {
      drawCover: (image) => this.operations.push({ source: image.source }),
      drawOverlay: (image) => this.operations.push({ source: image.source }),
      toJpeg: async () => this.output,
    };
  }

  createObjectURL(photo: Blob): string {
    return `blob:${photo.size}`;
  }

  revokeObjectURL(url: string): void {
    this.revoked.push(url);
  }

  async loadImage(source: string) {
    return { source, width: 100, height: 100 };
  }
}

const photos = [
  new Blob(["1"], { type: "image/jpeg" }),
  new Blob(["22"], { type: "image/jpeg" }),
  new Blob(["333"], { type: "image/jpeg" }),
  new Blob(["4444"], { type: "image/jpeg" }),
];

describe("BrowserCompositor", () => {
  it("draws photos in selection order before the overlay", async () => {
    const port = new RecordingCanvasPort();
    const compositor = new BrowserCompositor(port);
    await compositor.compose({ photos, frame });
    expect(port.operations.map((operation) => operation.source)).toEqual([
      "blob:1",
      "blob:2",
      "blob:3",
      "blob:4",
      "overlay.svg",
    ]);
  });

  it("rejects compositions without exactly four photos", async () => {
    const compositor = new BrowserCompositor(new RecordingCanvasPort());
    await expect(compositor.compose({ photos: photos.slice(0, 3), frame })).rejects.toThrow(
      "Composition requires exactly four photos",
    );
  });

  it("rejects non-JPEG photo inputs before allocating object URLs", async () => {
    const port = new RecordingCanvasPort();
    const compositor = new BrowserCompositor(port);
    const invalidPhotos = [...photos.slice(0, 3), new Blob(["png"], { type: "image/png" })];

    await expect(compositor.compose({ photos: invalidPhotos, frame })).rejects.toThrow(
      "Composition requires JPEG photos",
    );
    expect(port.revoked).toEqual([]);
  });

  it("revokes each temporary photo URL after composition", async () => {
    const port = new RecordingCanvasPort();
    await new BrowserCompositor(port).compose({ photos, frame });
    expect(port.revoked).toEqual(["blob:1", "blob:2", "blob:3", "blob:4"]);
  });
});
