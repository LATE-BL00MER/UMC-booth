import { z } from "zod";

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  joinSiteUrl: string;
  privatePort: number;
  publicPort: number;
  sessionDir: string;
  framePackDir: string;
  poseConfigPath: string;
  tunnelMode: "quick" | "local";
  localPublicBaseUrl: string | null;
  countdownSeconds: 5;
  captureCount: 6;
  selectedCount: 4;
  activeTtlMs: number;
  pendingTtlMs: number;
  sweepIntervalMs: number;
  countdownTickMs: number;
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  JOIN_SITE_URL: z
    .string()
    .url()
    .default("https://forms.gle/nMDuKHj6rGt8stiH8"),
  PRIVATE_PORT: z.coerce.number().int().min(1024).max(65_535).default(4173),
  PUBLIC_PORT: z.coerce.number().int().min(1024).max(65_535).default(4174),
  SESSION_DIR: z.string().min(1).default("runtime-data/sessions"),
  FRAME_PACK_DIR: z.string().min(1).default("assets/frame-packs"),
  POSE_CONFIG_PATH: z.string().min(1).default("assets/poses/poses.json"),
  COUNTDOWN_TICK_MS: z.coerce.number().int().min(1).optional(),
  ACTIVE_TTL_MS: z.coerce.number().int().min(1).optional(),
  PENDING_TTL_MS: z.coerce.number().int().min(1).optional(),
  SWEEP_INTERVAL_MS: z.coerce.number().int().min(1).optional(),
  TUNNEL_MODE: z.enum(["quick", "local"]).default("quick"),
  LOCAL_PUBLIC_BASE_URL: z.string().url().optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = schema.parse(env);
  if (new URL(parsed.JOIN_SITE_URL).protocol !== "https:") {
    throw new Error("JOIN_SITE_URL must use https");
  }
  if (parsed.PRIVATE_PORT === parsed.PUBLIC_PORT) {
    throw new Error("PRIVATE_PORT and PUBLIC_PORT must differ");
  }
  const testOnly = parsed.NODE_ENV === "test";
  if (parsed.TUNNEL_MODE === "local" && !testOnly) {
    throw new Error("Local tunnel mode is test-only");
  }
  if (parsed.TUNNEL_MODE === "local" && !parsed.LOCAL_PUBLIC_BASE_URL) {
    throw new Error("LOCAL_PUBLIC_BASE_URL is required in local tunnel mode");
  }
  return {
    nodeEnv: parsed.NODE_ENV,
    joinSiteUrl: parsed.JOIN_SITE_URL,
    privatePort: parsed.PRIVATE_PORT,
    publicPort: parsed.PUBLIC_PORT,
    sessionDir: parsed.SESSION_DIR,
    framePackDir: parsed.FRAME_PACK_DIR,
    poseConfigPath: parsed.POSE_CONFIG_PATH,
    tunnelMode: parsed.TUNNEL_MODE,
    localPublicBaseUrl: parsed.LOCAL_PUBLIC_BASE_URL ?? null,
    countdownSeconds: 5,
    captureCount: 6,
    selectedCount: 4,
    activeTtlMs: testOnly ? (parsed.ACTIVE_TTL_MS ?? 300_000) : 300_000,
    pendingTtlMs: testOnly ? (parsed.PENDING_TTL_MS ?? 120_000) : 120_000,
    sweepIntervalMs: testOnly ? (parsed.SWEEP_INTERVAL_MS ?? 30_000) : 30_000,
    countdownTickMs: testOnly ? (parsed.COUNTDOWN_TICK_MS ?? 1_000) : 1_000,
  };
}
