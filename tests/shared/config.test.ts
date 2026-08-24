import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/shared/config";

const validEnv = {
  NODE_ENV: "test",
  JOIN_SITE_URL:
    "https://join.example.test/apply?utm_source=club_fair&utm_medium=photo_booth",
  PRIVATE_PORT: "4173",
  PUBLIC_PORT: "4174",
  SESSION_DIR: "/tmp/umc-booth-test-sessions",
  FRAME_PACK_DIR: "assets/frame-packs/basic",
  POSE_CONFIG_PATH: "assets/poses/poses.json",
};

describe("loadConfig", () => {
  it("uses the UMC application page when the join URL is not configured", () => {
    const { JOIN_SITE_URL: _joinSiteUrl, ...envWithoutJoinSite } = validEnv;

    expect(loadConfig(envWithoutJoinSite).joinSiteUrl).toBe(
      "https://forms.gle/nMDuKHj6rGt8stiH8",
    );
  });

  it("loads the exact booth runtime settings", () => {
    expect(loadConfig(validEnv)).toMatchObject({
      privatePort: 4173,
      publicPort: 4174,
      countdownSeconds: 5,
      captureCount: 6,
      selectedCount: 4,
      tunnelMode: "quick",
      localPublicBaseUrl: null,
      activeTtlMs: 300_000,
      pendingTtlMs: 120_000,
      sweepIntervalMs: 30_000,
      countdownTickMs: 1_000,
    });
  });

  it("rejects a non-HTTPS join URL", () => {
    expect(() =>
      loadConfig({ ...validEnv, JOIN_SITE_URL: "http://join.example.test" }),
    ).toThrow("JOIN_SITE_URL must use https");
  });

  it("rejects identical private and public ports", () => {
    expect(() => loadConfig({ ...validEnv, PUBLIC_PORT: "4173" })).toThrow(
      "PRIVATE_PORT and PUBLIC_PORT must differ",
    );
  });

  it("rejects local tunnel mode outside tests", () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        NODE_ENV: "production",
        TUNNEL_MODE: "local",
        LOCAL_PUBLIC_BASE_URL: "http://127.0.0.1:4174",
      }),
    ).toThrow("Local tunnel mode is test-only");
  });
});
