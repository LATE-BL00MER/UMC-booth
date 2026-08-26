import { describe, expect, it } from "vitest";

import {
  cloudCleanupIntervalMs,
  isCloudCleanupDue,
} from "../../src/operator/cleanup-policy";

describe("cloud cleanup policy", () => {
  it("runs immediately and then no more than once every five minutes", () => {
    expect(cloudCleanupIntervalMs).toBe(300_000);
    expect(isCloudCleanupDue(1_000, null)).toBe(true);
    expect(isCloudCleanupDue(300_999, 1_000)).toBe(false);
    expect(isCloudCleanupDue(301_000, 1_000)).toBe(true);
  });
});
