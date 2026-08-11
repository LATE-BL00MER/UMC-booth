export interface PhotoSlot {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Clockwise rotation in degrees. */
  rotation: number;
  fit: "cover";
}

export interface FrameManifest {
  id: string;
  label: string;
  canvas: { width: number; height: number };
  jpegQuality: number;
  thumbnail: string;
  overlay: string;
  slots: [PhotoSlot, PhotoSlot, PhotoSlot, PhotoSlot];
}

const DEFAULT_CAPTURE_ASPECT_RATIO = 3 / 4;

/** Uses the first photo slot as the capture contract so preview and saved JPEG crop identically. */
export function getCaptureAspectRatio(frames: readonly FrameManifest[]): number {
  const firstSlot = frames[0]?.slots[0];
  return firstSlot ? firstSlot.width / firstSlot.height : DEFAULT_CAPTURE_ASPECT_RATIO;
}
