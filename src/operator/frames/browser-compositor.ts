import type { FrameManifest, PhotoSlot } from "./frame-contract";

export interface LoadedImage {
  source: string;
  width: number;
  height: number;
  element?: CanvasImageSource;
}

export interface CanvasSurface {
  drawCover(image: LoadedImage, slot: PhotoSlot): void;
  drawOverlay(image: LoadedImage): void;
  toJpeg(quality: number): Promise<Blob>;
}

/** Browser APIs isolated behind this port keep compositing deterministic in tests. */
export interface CanvasPort {
  createCanvas(width: number, height: number): CanvasSurface;
  createObjectURL(photo: Blob): string;
  revokeObjectURL(url: string): void;
  loadImage(source: string): Promise<LoadedImage>;
}

export class BrowserCompositor {
  constructor(private readonly canvasPort: CanvasPort = new BrowserCanvasPort()) {}

  async compose({ photos, frame }: { photos: readonly Blob[]; frame: FrameManifest }): Promise<Blob> {
    if (photos.length !== 4) {
      throw new Error("Composition requires exactly four photos");
    }
    if (photos.some((photo) => photo.type !== "image/jpeg")) {
      throw new Error("Composition requires JPEG photos");
    }

    const temporaryUrls: string[] = [];
    try {
      const surface = this.canvasPort.createCanvas(frame.canvas.width, frame.canvas.height);
      for (const [index, photo] of photos.entries()) {
        const photoUrl = this.canvasPort.createObjectURL(photo);
        temporaryUrls.push(photoUrl);
        const image = await this.canvasPort.loadImage(photoUrl);
        surface.drawCover(image, frame.slots[index]!);
      }

      surface.drawOverlay(await this.canvasPort.loadImage(frame.overlay));
      return await surface.toJpeg(frame.jpegQuality);
    } finally {
      for (const url of temporaryUrls) {
        this.canvasPort.revokeObjectURL(url);
      }
    }
  }
}

export class BrowserCanvasPort implements CanvasPort {
  createCanvas(width: number, height: number): CanvasSurface {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create a 2D canvas context");
    }
    return new BrowserCanvasSurface(canvas, context);
  }

  createObjectURL(photo: Blob): string {
    return URL.createObjectURL(photo);
  }

  revokeObjectURL(url: string): void {
    URL.revokeObjectURL(url);
  }

  loadImage(source: string): Promise<LoadedImage> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ source, width: image.naturalWidth, height: image.naturalHeight, element: image });
      image.onerror = () => reject(new Error(`Could not load image: ${source}`));
      image.src = source;
    });
  }
}

class BrowserCanvasSurface implements CanvasSurface {
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly context: CanvasRenderingContext2D,
  ) {}

  drawCover(image: LoadedImage, slot: PhotoSlot): void {
    if (!image.element || image.width <= 0 || image.height <= 0) {
      throw new Error(`Could not draw image: ${image.source}`);
    }
    const sourceAspect = image.width / image.height;
    const slotAspect = slot.width / slot.height;
    const sourceWidth = sourceAspect > slotAspect ? image.height * slotAspect : image.width;
    const sourceHeight = sourceAspect > slotAspect ? image.height : image.width / slotAspect;
    const sourceX = (image.width - sourceWidth) / 2;
    const sourceY = (image.height - sourceHeight) / 2;

    this.context.save();
    this.context.translate(slot.x + slot.width / 2, slot.y + slot.height / 2);
    this.context.rotate((slot.rotation * Math.PI) / 180);
    this.context.drawImage(image.element, sourceX, sourceY, sourceWidth, sourceHeight, -slot.width / 2, -slot.height / 2, slot.width, slot.height);
    this.context.restore();
  }

  drawOverlay(image: LoadedImage): void {
    if (!image.element) {
      throw new Error(`Could not draw overlay: ${image.source}`);
    }
    this.context.drawImage(image.element, 0, 0, this.canvas.width, this.canvas.height);
  }

  toJpeg(quality: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Could not encode composition as JPEG"));
      }, "image/jpeg", quality);
    });
  }
}
