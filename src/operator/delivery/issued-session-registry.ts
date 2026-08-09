import type { IssuedSession } from "../../shared/contracts.js";

export interface IssuedSessionRegistry {
  add(issued: IssuedSession, keyFragment: string): void;
  list(): IssuedSession[];
  reissue(id: string, newPublicBaseUrl: string): IssuedSession | null;
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

  list(): IssuedSession[] {
    this.prune(Date.now());
    return [...this.sessions.values()].map(({ issued }) => issued);
  }

  reissue(id: string, newPublicBaseUrl: string): IssuedSession | null {
    this.prune(Date.now());
    const stored = this.sessions.get(id);
    if (!stored) return null;
    const reissued = {
      ...stored.issued,
      deliveryUrl: buildDeliveryUrl(newPublicBaseUrl, stored.issued.publicToken, stored.keyFragment),
    };
    this.sessions.set(id, { issued: reissued, keyFragment: stored.keyFragment });
    return reissued;
  }

  reissueAll(newPublicBaseUrl: string): IssuedSession[] {
    this.prune(Date.now());
    return [...this.sessions.keys()]
      .map((id) => this.reissue(id, newPublicBaseUrl))
      .filter((issued): issued is IssuedSession => issued !== null);
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
