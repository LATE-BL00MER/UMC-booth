import { describe, expect, it, vi } from "vitest";

import {
  EncryptedDeliveryCoordinator,
  type Sleep,
} from "../../../src/operator/delivery/delivery-coordinator.js";
import {
  FetchPrivateApiClient,
  type PrivateApiClient,
} from "../../../src/operator/delivery/private-api-client.js";
import { MemoryIssuedSessionRegistry } from "../../../src/operator/delivery/issued-session-registry.js";

class FakePrivateApi implements PrivateApiClient {
  calls: Array<{ operation: string; id?: string; ciphertext?: number[] }> = [];
  createAttempts = 0;
  failCreateCount = 0;
  failActivateCount = 0;
  failDeleteCount = 0;
  createdId = "pending-1";
  deletedPendingIds: string[] = [];
  pauseOnActivate = false;
  commitActivationBeforeAbort = false;
  activated: { publicToken: string; expiresAt: number } | null = null;

  async createPending(ciphertext: Uint8Array, signal: AbortSignal): Promise<{ id: string }> {
    this.calls.push({ operation: "create", ciphertext: [...ciphertext] });
    this.createAttempts += 1;
    if (this.failCreateCount > 0) {
      this.failCreateCount -= 1;
      throw new Error("temporary create failure");
    }
    if (signal.aborted) throw abortError();
    return { id: this.createdId };
  }

  async activate(id: string, signal: AbortSignal): Promise<{ publicToken: string; expiresAt: number }> {
    this.calls.push({ operation: "activate", id });
    if (this.failActivateCount > 0) {
      this.failActivateCount -= 1;
      throw new Error("temporary activation failure");
    }
    if (this.commitActivationBeforeAbort) {
      this.activated = { publicToken: "public-token", expiresAt: 1_800_000_000_000 };
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    }
    if (!this.pauseOnActivate) {
      if (signal.aborted) throw abortError();
      return { publicToken: "public-token", expiresAt: 1_800_000_000_000 };
    }
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  }

  async deletePending(id: string): Promise<void> {
    this.calls.push({ operation: "delete", id });
    this.deletedPendingIds.push(id);
    if (this.failDeleteCount > 0) {
      this.failDeleteCount -= 1;
      throw new Error("pending cleanup failed");
    }
  }

  async getActivated(id: string): Promise<{ publicToken: string; expiresAt: number } | null> {
    this.calls.push({ operation: "get-activated", id });
    return this.activated;
  }
}

class FakeSleeper {
  delays: number[] = [];

  sleep: Sleep = async (milliseconds, signal) => {
    this.delays.push(milliseconds);
    if (signal.aborted) throw abortError();
  };
}

describe("EncryptedDeliveryCoordinator", () => {
  it("keeps the photo key only in the delivery URL fragment", async () => {
    const api = new FakePrivateApi();
    const coordinator = new EncryptedDeliveryCoordinator(api, new MemoryIssuedSessionRegistry());

    const issued = await coordinator.issue(validIssueInput());

    expect(issued.deliveryUrl).toMatch(/^https:\/\/booth\.example\/d\//);
    expect(issued.deliveryUrl).toContain("#key=");
    const keyFragment = issued.deliveryUrl.split("#key=")[1];
    expect(keyFragment).toBeTruthy();
    expect(JSON.stringify(api.calls)).not.toContain(keyFragment!);
  });

  it("retries failed creation with one- and two-second backoff", async () => {
    const api = new FakePrivateApi();
    api.failCreateCount = 2;
    const sleeper = new FakeSleeper();
    const coordinator = new EncryptedDeliveryCoordinator(
      api,
      new MemoryIssuedSessionRegistry(),
      sleeper.sleep,
    );

    await coordinator.issue(validIssueInput());

    expect(api.createAttempts).toBe(3);
    expect(sleeper.delays).toEqual([1_000, 2_000]);
  });

  it("deletes the pending ciphertext when reset aborts before activation", async () => {
    const api = new FakePrivateApi();
    api.pauseOnActivate = true;
    const controller = new AbortController();
    const coordinator = new EncryptedDeliveryCoordinator(api, new MemoryIssuedSessionRegistry());

    const promise = coordinator.issue(validIssueInput(controller.signal));
    await vi.waitFor(() => expect(api.calls).toContainEqual({ operation: "activate", id: api.createdId }));
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(api.deletedPendingIds).toEqual([api.createdId]);
  });

  it("registers the issued session when activation commits before its response is aborted", async () => {
    const api = new FakePrivateApi();
    api.commitActivationBeforeAbort = true;
    const registry = new MemoryIssuedSessionRegistry();
    const controller = new AbortController();
    const coordinator = new EncryptedDeliveryCoordinator(api, registry);

    const issuing = coordinator.issue(validIssueInput(controller.signal));
    await vi.waitFor(() => expect(api.calls).toContainEqual({ operation: "activate", id: api.createdId }));
    controller.abort();

    await expect(issuing).resolves.toMatchObject({ id: api.createdId, publicToken: "public-token" });
    expect(api.calls).toContainEqual({ operation: "get-activated", id: api.createdId });
    expect(api.deletedPendingIds).toEqual([]);
    expect(registry.activeCount()).toBe(1);
  });

  it("cleans up a failed activation before starting a retry", async () => {
    const api = new FakePrivateApi();
    api.failActivateCount = 1;
    const sleeper = new FakeSleeper();
    const coordinator = new EncryptedDeliveryCoordinator(
      api,
      new MemoryIssuedSessionRegistry(),
      sleeper.sleep,
    );

    await coordinator.issue(validIssueInput());

    expect(api.calls.map(({ operation }) => operation)).toEqual([
      "create",
      "activate",
      "delete",
      "create",
      "activate",
    ]);
    expect(sleeper.delays).toEqual([1_000]);
  });

  it("stops when pending cleanup fails instead of creating another ciphertext", async () => {
    const api = new FakePrivateApi();
    api.failActivateCount = 1;
    api.failDeleteCount = 1;
    const sleeper = new FakeSleeper();
    const coordinator = new EncryptedDeliveryCoordinator(
      api,
      new MemoryIssuedSessionRegistry(),
      sleeper.sleep,
    );

    await expect(coordinator.issue(validIssueInput())).rejects.toMatchObject({
      message: "temporary activation failure",
      cause: expect.objectContaining({ message: "pending cleanup failed" }),
    });
    expect(api.createAttempts).toBe(1);
    expect(sleeper.delays).toEqual([]);
  });

  it("keeps an activated session registered after a later reset abort", async () => {
    const api = new FakePrivateApi();
    const registry = new MemoryIssuedSessionRegistry();
    const coordinator = new EncryptedDeliveryCoordinator(api, registry);
    const controller = new AbortController();

    await coordinator.issue(validIssueInput(controller.signal));
    controller.abort();

    expect(registry.activeCount()).toBe(1);
    expect(api.deletedPendingIds).toEqual([]);
  });
});

describe("FetchPrivateApiClient", () => {
  it("sends ciphertext only to the private session endpoints", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new FetchPrivateApiClient(async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/activate")) {
        return jsonResponse({ publicToken: "public-token", expiresAt: 1_800_000_000_000 });
      }
      if (String(url).endsWith("/activation")) {
        return jsonResponse({ publicToken: "public-token", expiresAt: 1_800_000_000_000 });
      }
      if (init?.method === "POST") return jsonResponse({ id: "pending-1" }, 201);
      return new Response(null, { status: 204 });
    });
    const signal = new AbortController().signal;

    await expect(client.createPending(new Uint8Array([1, 2, 3]), signal)).resolves.toEqual({ id: "pending-1" });
    await expect(client.activate("pending-1", signal)).resolves.toEqual({
      publicToken: "public-token",
      expiresAt: 1_800_000_000_000,
    });
    await expect(client.getActivated("pending-1")).resolves.toEqual({
      publicToken: "public-token",
      expiresAt: 1_800_000_000_000,
    });
    await expect(client.deletePending("pending-1")).resolves.toBeUndefined();

    expect(requests.map(({ url, init }) => [url, init?.method])).toEqual([
      ["/api/sessions", "POST"],
      ["/api/sessions/pending-1/activate", "POST"],
      ["/api/sessions/pending-1/activation", undefined],
      ["/api/sessions/pending-1", "DELETE"],
    ]);
    expect(requests[0]?.init?.headers).toEqual({ "content-type": "application/octet-stream" });
  });
});

function validIssueInput(signal = new AbortController().signal) {
  return {
    jpeg: new Blob(["jpeg bytes"], { type: "image/jpeg" }),
    publicBaseUrl: "https://booth.example",
    generation: 4,
    signal,
  };
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
