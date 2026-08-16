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

const framePackIndexSchema = z.object({
  packs: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).min(1),
});

export function parseFrameManifest(value: unknown): FrameManifest {
  return frameManifestSchema.parse(value) as FrameManifest;
}

export function parseFramePackIndex(value: unknown): string[] {
  return framePackIndexSchema.parse(value).packs;
}

export async function loadFramePacks(baseUrl: string, fetcher: Fetcher = fetch): Promise<FrameManifest[]> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const response = await fetcher(`${normalizedBaseUrl}/index.json`);
  if (!response.ok) {
    throw new Error(`Could not load frame pack index (${response.status})`);
  }

  const packIds = parseFramePackIndex(await response.json());
  return Promise.all(packIds.map((packId) => loadFramePack(`${normalizedBaseUrl}/${packId}`, fetcher)));
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
