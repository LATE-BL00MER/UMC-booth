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
    onPendingSessionCreated?(id: string): void;
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
    onPendingSessionCreated?(id: string): void;
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
        input.onPendingSessionCreated?.(pendingId);
        throwIfAborted(input.signal);

        const id = pendingId;
        const activated = await this.api.activate(id, input.signal);
        pendingId = null;
        const issued: IssuedSession = {
          id,
          publicToken: activated.publicToken,
          deliveryUrl: buildDeliveryUrl(input.publicBaseUrl, activated.publicToken, keyFragment),
          expiresAt: activated.expiresAt,
        };
        this.registry.add(issued, keyFragment);
        return issued;
      } catch (error) {
        if (pendingId !== null) {
          try {
            await this.api.deletePending(pendingId);
          } catch (cleanupError) {
            throw errorWithCleanupCause(error, cleanupError);
          }
        }
        if (input.signal.aborted || isAbortError(error)) throw abortError();
        lastError = error;
      }
    }

    throw lastError ?? new Error("Could not issue delivery session");
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

function errorWithCleanupCause(primaryError: unknown, cleanupError: unknown): Error {
  if (primaryError instanceof Error) {
    const error = new Error(primaryError.message, { cause: cleanupError });
    error.name = primaryError.name;
    return error;
  }
  return new Error("Delivery failed and pending cleanup failed", { cause: cleanupError });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}
