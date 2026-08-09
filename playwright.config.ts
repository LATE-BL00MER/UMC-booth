import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    },
  },
  webServer: {
    command: "npm run build && env NODE_ENV=test JOIN_SITE_URL=https://join.example.test/apply?utm_source=club_fair SESSION_DIR=runtime-data/e2e-sessions TUNNEL_MODE=local LOCAL_PUBLIC_BASE_URL=http://127.0.0.1:4174 COUNTDOWN_TICK_MS=10 ACTIVE_TTL_MS=5000 SWEEP_INTERVAL_MS=50 tsx src/server/index.ts",
    url: "http://127.0.0.1:4173/api/status",
    reuseExistingServer: false,
  },
});
