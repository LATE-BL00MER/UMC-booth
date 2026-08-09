import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryIssuedSessionRegistry } from "../../../src/operator/delivery/issued-session-registry.js";

describe("MemoryIssuedSessionRegistry", () => {
  afterEach(() => vi.useRealTimers());

  it("reissues each unexpired session with its original token and key", () => {
    const registry = new MemoryIssuedSessionRegistry();
    registry.add(
      {
        id: "session-1",
        publicToken: "stable-token",
        deliveryUrl: "https://old.example/d/stable-token#key=secret-fragment",
        expiresAt: 1_800_000_000_000,
      },
      "secret-fragment",
    );

    expect(registry.reissueAll("https://new.example")).toEqual([
      {
        id: "session-1",
        publicToken: "stable-token",
        deliveryUrl: "https://new.example/d/stable-token#key=secret-fragment",
        expiresAt: 1_800_000_000_000,
      },
    ]);
  });

  it("removes expired entries every thirty seconds without browser storage", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    const registry = new MemoryIssuedSessionRegistry();
    registry.add(
      {
        id: "expired",
        publicToken: "token",
        deliveryUrl: "https://booth.example/d/token#key=secret",
        expiresAt: Date.now() + 29_999,
      },
      "secret",
    );

    vi.advanceTimersByTime(30_000);

    expect(registry.activeCount()).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
  });

  it("returns how many explicitly pruned entries it removed", () => {
    const registry = new MemoryIssuedSessionRegistry();
    registry.add(
      { id: "expired", publicToken: "one", deliveryUrl: "old", expiresAt: 9 },
      "key-one",
    );
    registry.add(
      { id: "active", publicToken: "two", deliveryUrl: "old", expiresAt: 11 },
      "key-two",
    );

    expect(registry.prune(10)).toBe(1);
    expect(registry.activeCount()).toBe(1);
  });

  it("reissues one unexpired history entry without writing the key to browser storage", () => {
    const registry = new MemoryIssuedSessionRegistry();
    registry.add(
      { id: "active", publicToken: "two", deliveryUrl: "old", expiresAt: Date.now() + 60_000 },
      "key-two",
    );

    expect(registry.reissue("active", "https://replacement.example")).toMatchObject({
      id: "active",
      deliveryUrl: "https://replacement.example/d/two#key=key-two",
    });
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
  });
});
