import { z } from "zod";
import type { FrameManifest } from "./frame-contract";

const positiveNumber = z.number().finite().positive();

const photoSlotSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: positiveNumber,
  height: positiveNumber,
  rotation: z.number().finite(),
  fit: z.literal("cover"),
});

const frameManifestSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  canvas: z.object({ width: positiveNumber, height: positiveNumber }),
  jpegQuality: z.number().min(0.5).max(1),
  thumbnail: z.string().trim().min(1),
  overlay: z.string().trim().min(1),
  slots: z.array(photoSlotSchema).length(4, "Frame requires exactly four slots"),
});

export function parseFrameManifest(value: unknown): FrameManifest {
  return frameManifestSchema.parse(value) as FrameManifest;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Fetches a pack manifest and resolves its image paths relative to the pack URL. */
export async function loadFramePack(baseUrl: string, fetcher: Fetcher = fetch): Promise<FrameManifest> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const response = await fetcher(`${normalizedBaseUrl}/manifest.json`);
  if (!response.ok) {
    throw new Error(`Could not load frame manifest (${response.status})`);
  }

  const manifest = parseFrameManifest(await response.json());
  return {
    ...manifest,
    thumbnail: resolvePackAsset(normalizedBaseUrl, manifest.thumbnail),
    overlay: resolvePackAsset(normalizedBaseUrl, manifest.overlay),
  };
}

function resolvePackAsset(baseUrl: string, asset: string): string {
  if (/^(?:[a-z]+:)?\/\//i.test(asset) || asset.startsWith("/")) {
    return asset;
  }
  return `${baseUrl}/${asset.replace(/^\.\//, "")}`;
}
