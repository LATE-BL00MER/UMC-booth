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
