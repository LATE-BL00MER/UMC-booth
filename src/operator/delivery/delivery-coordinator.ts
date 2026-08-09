import type { IssuedSession } from "../../shared/contracts.js";
import {
  encryptPhoto,
  exportKeyFragment,
  generatePhotoKey,
} from "../../shared/crypto-envelope.js";
import {
  buildDeliveryUrl,
  type IssuedSessionRegistry,
} from "./issued-session-registry.js";
import type { PrivateApiClient } from "./private-api-client.js";

export interface DeliveryCoordinator {
  issue(input: {
    jpeg: Blob;
    publicBaseUrl: string;
    generation: number;
    signal: AbortSignal;
  }): Promise<IssuedSession>;
}

export type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export class EncryptedDeliveryCoordinator implements DeliveryCoordinator {
  constructor(
    private readonly api: PrivateApiClient,
    private readonly registry: IssuedSessionRegistry,
    private readonly sleep: Sleep = abortableSleep,
  ) {}

  async issue(input: {
    jpeg: Blob;
    publicBaseUrl: string;
    generation: number;
    signal: AbortSignal;
  }): Promise<IssuedSession> {
    throwIfAborted(input.signal);
    const plain = new Uint8Array(await input.jpeg.arrayBuffer());
    let lastError: unknown;

    for (const delay of [0, 1_000, 2_000]) {
      throwIfAborted(input.signal);
      if (delay > 0) await this.sleep(delay, input.signal);

      let pendingId: string | null = null;
      try {
        const key = await generatePhotoKey();
        throwIfAborted(input.signal);
        const keyFragment = await exportKeyFragment(key);
        const ciphertext = await encryptPhoto(plain, key);
        throwIfAborted(input.signal);

        const pending = await this.api.createPending(ciphertext, input.signal);
        pendingId = pending.id;
        throwIfAborted(input.signal);

        const activated = await this.api.activate(pendingId, input.signal);
        const issued: IssuedSession = {
          id: pendingId,
          publicToken: activated.publicToken,
          deliveryUrl: buildDeliveryUrl(input.publicBaseUrl, activated.publicToken, keyFragment),
          expiresAt: activated.expiresAt,
        };
        this.registry.add(issued, keyFragment);
        return issued;
      } catch (error) {
        if (pendingId !== null) await this.deletePendingQuietly(pendingId);
        if (input.signal.aborted || isAbortError(error)) throw abortError();
        lastError = error;
      }
    }

    throw lastError ?? new Error("Could not issue delivery session");
  }

  private async deletePendingQuietly(id: string): Promise<void> {
    try {
      await this.api.deletePending(id);
    } catch {
      // Cleanup is best effort; the original issue failure remains the useful error.
    }
  }
}

export function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}
