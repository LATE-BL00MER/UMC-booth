export type SessionStatus = "pending" | "active" | "expired";

export type BoothPhase =
  | "preflight"
  | "welcome"
  | "capturing"
  | "selecting"
  | "framing"
  | "delivering"
  | "qr"
  | "error";

export interface SessionRecord {
  id: string;
  createdAt: number;
  expiresAt: number | null;
  status: SessionStatus;
  encryptedFile: string;
}

export interface IssuedSession {
  id: string;
  publicToken: string;
  deliveryUrl: string;
  expiresAt: number;
}

export interface Clock {
  now(): number;
}
