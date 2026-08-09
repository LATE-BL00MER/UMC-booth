export interface RuntimeStatus {
  tunnel: "starting" | "healthy" | "down";
  publicUrl: string | null;
  publicLatencyMs: number | null;
  lastSweepAt: number | null;
  pendingSessions: number;
  activeSessions: number;
  encryptedBytes: number;
  acceptingCaptures: boolean;
}

export interface RuntimeStatusProvider {
  getStatus(): Promise<RuntimeStatus>;
  requestShutdown(): Promise<void>;
}
