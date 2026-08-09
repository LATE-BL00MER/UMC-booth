import { describe, expect, it } from "vitest";

import type { CameraPort } from "../../../src/operator/camera/camera-port.js";
import { runCaptureSequence, type CaptureSequenceOptions } from "../../../src/operator/camera/capture-sequence.js";

const prompts: [string, string, string, string, string, string] = [
  "pose 1",
  "pose 2",
  "pose 3",
  "pose 4",
  "pose 5",
  "pose 6",
];

class RecordingCamera implements CameraPort {
  readonly successfulShotIndexes: number[] = [];
  private captureAttempt = 0;

  constructor(private readonly failAttempt: number | null = null) {}

  async probe(): Promise<boolean> {
    return true;
  }

  async start(): Promise<void> {}

  async capture(): Promise<Blob> {
    const attempt = this.captureAttempt;
    this.captureAttempt += 1;
    if (attempt === this.failAttempt) {
      throw new Error("camera hiccup");
    }
    return new Blob([String(attempt)], { type: "image/jpeg" });
  }

  stop(): void {}
}

function baseOptions(camera: CameraPort): CaptureSequenceOptions {
  return {
    camera,
    prompts,
    signal: new AbortController().signal,
    tickMs: 10,
    sleep: async () => undefined,
    onCountdown: () => undefined,
    onCaptured: () => undefined,
    onRetry: () => undefined,
  };
}

describe("runCaptureSequence", () => {
  it("counts five to one before each of six successful captures", async () => {
    const countdowns: Array<[number, number]> = [];
    const captures: number[] = [];

    await runCaptureSequence({
      ...baseOptions(new RecordingCamera()),
      onCountdown: (value, shot) => countdowns.push([shot, value]),
      onCaptured: (_blob, shot) => captures.push(shot),
    });

    expect(countdowns).toHaveLength(30);
    expect(countdowns.slice(0, 5)).toEqual([
      [0, 5],
      [0, 4],
      [0, 3],
      [0, 2],
      [0, 1],
    ]);
    expect(captures).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("repeats only the failed shot", async () => {
    const camera = new RecordingCamera(2);
    const retried: number[] = [];
    const successfulShots: number[] = [];

    await runCaptureSequence({
      ...baseOptions(camera),
      onCaptured: (_photo, shot) => successfulShots.push(shot),
      onRetry: (shot) => retried.push(shot),
    });

    expect(retried).toEqual([2]);
    expect(successfulShots).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("stops before a capture when aborted during a countdown wait", async () => {
    const controller = new AbortController();
    const countdowns: number[] = [];
    const captures: number[] = [];

    await runCaptureSequence({
      ...baseOptions(new RecordingCamera()),
      signal: controller.signal,
      sleep: async () => controller.abort(),
      onCountdown: (value) => countdowns.push(value),
      onCaptured: (_photo, shot) => captures.push(shot),
    });

    expect(countdowns).toEqual([5]);
    expect(captures).toEqual([]);
  });

  it("does not reject when an aborted countdown wait rejects", async () => {
    const controller = new AbortController();

    await expect(
      runCaptureSequence({
        ...baseOptions(new RecordingCamera()),
        signal: controller.signal,
        sleep: async () => {
          controller.abort();
          throw new Error("wait cancelled");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("drops a capture result that resolves after abort", async () => {
    const controller = new AbortController();
    let resolveCapture: ((photo: Blob) => void) | undefined;
    let notifyCaptureStarted: (() => void) | undefined;
    const captureStarted = new Promise<void>((resolve) => {
      notifyCaptureStarted = resolve;
    });
    const camera: CameraPort = {
      probe: async () => true,
      start: async () => undefined,
      capture: () =>
        new Promise<Blob>((resolve) => {
          resolveCapture = resolve;
          notifyCaptureStarted!();
        }),
      stop: () => undefined,
    };
    const captures: number[] = [];
    const sequence = runCaptureSequence({
      ...baseOptions(camera),
      signal: controller.signal,
      onCaptured: (_photo, shot) => captures.push(shot),
    });

    await captureStarted;
    controller.abort();
    resolveCapture!(new Blob(["late"], { type: "image/jpeg" }));
    await sequence;

    expect(captures).toEqual([]);
  });
});
