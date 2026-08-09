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

interface PendingActivationRecovery {
  id: string;
  keyFragment: string;
  publicBaseUrl: string;
  activationError: unknown;
  expiresAt: number;
}

type RecoveryResult =
  | { kind: "active"; issued: IssuedSession }
  | { kind: "deleted" }
  | { kind: "expired" }
  | { kind: "unavailable"; error: unknown };

const recoveryDelaysMs = [0, 1_000, 2_000] as const;
const retainedRecoveryTtlMs = 10 * 60 * 1_000;

export class EncryptedDeliveryCoordinator implements DeliveryCoordinator {
  private readonly pendingRecoveries = new Map<number, PendingActivationRecovery>();

  constructor(
    private readonly api: PrivateApiClient,
    private readonly registry: IssuedSessionRegistry,
    private readonly sleep: Sleep = abortableSleep,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async issue(input: {
    jpeg: Blob;
    publicBaseUrl: string;
    generation: number;
    signal: AbortSignal;
    onPendingSessionCreated?(id: string): void;
  }): Promise<IssuedSession> {
    const expired = this.pruneExpiredRecoveries();
    const expiredCurrentGeneration = expired.get(input.generation);
    if (expiredCurrentGeneration !== undefined) {
      throw localRecoveryExpiryError(expiredCurrentGeneration.activationError);
    }
    const retained = this.pendingRecoveries.get(input.generation);
    if (retained !== undefined) {
      const recovery = await this.recoverActivation(input.generation, retained);
      if (recovery.kind === "active") {
        return recovery.issued;
      }
      if (recovery.kind === "unavailable") {
        throw errorWithCause(retained.activationError, recovery.error, "Delivery activation recovery failed");
      }
      if (recovery.kind === "expired") {
        throw localRecoveryExpiryError(retained.activationError);
      }
      // The atomic resolver already removed the pending session before it
      // returned this result, so it is safe to create a replacement.
    }

    throwIfAborted(input.signal);
    const plain = new Uint8Array(await input.jpeg.arrayBuffer());
    let lastError: unknown;

    for (const delay of [0, 1_000, 2_000]) {
      throwIfAborted(input.signal);
      if (delay > 0) await this.sleep(delay, input.signal);

      let pendingId: string | null = null;
      let keyFragment: string | null = null;
      let activationAttempted = false;
      try {
        const key = await generatePhotoKey();
        throwIfAborted(input.signal);
        keyFragment = await exportKeyFragment(key);
        const ciphertext = await encryptPhoto(plain, key);
        throwIfAborted(input.signal);

        const pending = await this.api.createPending(ciphertext, input.signal);
        pendingId = pending.id;
        input.onPendingSessionCreated?.(pendingId);
        throwIfAborted(input.signal);

        const id = pendingId;
        activationAttempted = true;
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
        if (pendingId !== null && keyFragment !== null && activationAttempted) {
          const recovery: PendingActivationRecovery = {
            id: pendingId,
            keyFragment,
            publicBaseUrl: input.publicBaseUrl,
            activationError: error,
            expiresAt: this.now() + retainedRecoveryTtlMs,
          };
          this.pendingRecoveries.set(input.generation, recovery);
          const recovered = await this.recoverActivation(input.generation, recovery);
          if (recovered.kind === "active") {
            return recovered.issued;
          }
          if (recovered.kind === "unavailable") {
            throw errorWithCause(error, recovered.error, "Delivery activation recovery failed");
          }
          if (recovered.kind === "expired") {
            throw localRecoveryExpiryError(error);
          }
          if (recovered.kind === "deleted") {
            pendingId = null;
          }
        }
        if (pendingId !== null) {
          try {
            await this.api.deletePending(pendingId);
          } catch (cleanupError) {
            throw errorWithCause(error, cleanupError, "Delivery failed and pending cleanup failed");
          }
        }
        if (input.signal.aborted || isAbortError(error)) throw abortError();
        lastError = error;
      }
    }

    throw lastError ?? new Error("Could not issue delivery session");
  }

  /**
   * Explicitly resumes a retained ambiguous activation without creating a new
   * session. An unavailable recovery remains retained for a later attempt.
   */
  async recoverRetained(generation: number): Promise<IssuedSession | null> {
    this.pruneRetainedRecoveries();
    const retained = this.pendingRecoveries.get(generation);
    if (retained === undefined) {
      return null;
    }
    const recovery = await this.recoverActivation(generation, retained);
    if (recovery.kind === "active") {
      return recovery.issued;
    }
    return null;
  }

  /**
   * Releases only expired ambiguous-recovery key fragments. Runtime callers may
   * invoke this during maintenance; `issue()` also prunes before every attempt.
   */
  pruneRetainedRecoveries(now = this.now()): number {
    return this.pruneExpiredRecoveries(now).size;
  }

  private pruneExpiredRecoveries(now = this.now()): Map<number, PendingActivationRecovery> {
    const expired = new Map<number, PendingActivationRecovery>();
    for (const [generation, recovery] of this.pendingRecoveries) {
      if (recovery.expiresAt <= now) {
        this.pendingRecoveries.delete(generation);
        expired.set(generation, recovery);
      }
    }
    return expired;
  }

  private async recoverActivation(generation: number, recovery: PendingActivationRecovery): Promise<RecoveryResult> {
    const recoverySignal = new AbortController().signal;
    let lastError: unknown = new Error("Delivery activation recovery failed");

    for (const delay of recoveryDelaysMs) {
      try {
        if (delay > 0) {
          await this.sleep(delay, recoverySignal);
        }
        if (recovery.expiresAt <= this.now()) {
          this.clearRecovery(generation, recovery);
          return { kind: "expired" };
        }
        const resolution = await this.api.resolveActivationOrDelete(recovery.id);
        if (recovery.expiresAt <= this.now()) {
          this.clearRecovery(generation, recovery);
          return { kind: "expired" };
        }
        if (resolution.status === "deleted") {
          this.clearRecovery(generation, recovery);
          return { kind: "deleted" };
        }
        const issued: IssuedSession = {
          id: recovery.id,
          publicToken: resolution.publicToken,
          deliveryUrl: buildDeliveryUrl(recovery.publicBaseUrl, resolution.publicToken, recovery.keyFragment),
          expiresAt: resolution.expiresAt,
        };
        this.registry.add(issued, recovery.keyFragment);
        this.clearRecovery(generation, recovery);
        return { kind: "active", issued };
      } catch (error) {
        lastError = error;
      }
    }

    return { kind: "unavailable", error: lastError };
  }

  private clearRecovery(generation: number, recovery: PendingActivationRecovery): void {
    if (this.pendingRecoveries.get(generation) === recovery) {
      this.pendingRecoveries.delete(generation);
    }
  }
}

export function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorWithCause(primaryError: unknown, cause: unknown, fallbackMessage: string): Error {
  if (primaryError instanceof Error) {
    const error = new Error(primaryError.message, { cause });
    error.name = primaryError.name;
    return error;
  }
  return new Error(fallbackMessage, { cause });
}

function localRecoveryExpiryError(activationError: unknown): Error {
  return errorWithCause(
    activationError,
    new Error("Retained delivery activation recovery expired locally"),
    "Delivery activation recovery expired locally",
  );
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}
