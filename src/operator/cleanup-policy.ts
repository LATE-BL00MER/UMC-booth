export const cloudCleanupIntervalMs = 5 * 60 * 1_000;

export function isCloudCleanupDue(now: number, lastSuccessfulCleanupAt: number | null): boolean {
  return lastSuccessfulCleanupAt === null
    || now - lastSuccessfulCleanupAt >= cloudCleanupIntervalMs;
}
