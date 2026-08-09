import type { IssuedSession } from "../../shared/contracts.js";

export interface IssuedSessionRegistry {
  add(issued: IssuedSession, keyFragment: string): void;
  reissueAll(newPublicBaseUrl: string): IssuedSession[];
  prune(now: number): number;
  activeCount(): number;
}

interface StoredSession {
  issued: IssuedSession;
  keyFragment: string;
}

export class MemoryIssuedSessionRegistry implements IssuedSessionRegistry {
  private readonly sessions = new Map<string, StoredSession>();

  constructor() {
    setInterval(() => this.prune(Date.now()), 30_000);
  }

  add(issued: IssuedSession, keyFragment: string): void {
    this.sessions.set(issued.id, { issued, keyFragment });
  }

  reissueAll(newPublicBaseUrl: string): IssuedSession[] {
    this.prune(Date.now());
    return [...this.sessions.values()].map(({ issued, keyFragment }) => {
      const reissued = {
        ...issued,
        deliveryUrl: buildDeliveryUrl(newPublicBaseUrl, issued.publicToken, keyFragment),
      };
      this.sessions.set(reissued.id, { issued: reissued, keyFragment });
      return reissued;
    });
  }

  prune(now: number): number {
    let removed = 0;
    for (const [id, { issued }] of this.sessions) {
      if (issued.expiresAt <= now) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  activeCount(): number {
    return this.sessions.size;
  }
}

export function buildDeliveryUrl(
  publicBaseUrl: string,
  publicToken: string,
  keyFragment: string,
): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/d/${publicToken}#key=${keyFragment}`;
}
