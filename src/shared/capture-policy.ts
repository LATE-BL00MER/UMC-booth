export const captureCountdownValues = [3, 2, 1] as const;

export type CaptureCountdownValue = (typeof captureCountdownValues)[number];

export const captureCountdownSeconds = captureCountdownValues[0];
