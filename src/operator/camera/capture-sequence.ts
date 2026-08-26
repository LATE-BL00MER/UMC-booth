import {
  captureCountdownValues,
  type CaptureCountdownValue,
} from "../../shared/capture-policy.js";
import type { CameraPort } from "./camera-port.js";

export interface CaptureSequenceOptions {
  camera: CameraPort;
  prompts: [string, string, string, string, string, string];
  signal: AbortSignal;
  tickMs: number;
  postCaptureDelayMs: number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  onCountdown(value: CaptureCountdownValue, shotIndex: number): void;
  onCaptureFeedback?(shotIndex: number): void;
  onCaptured(photo: Blob, shotIndex: number): void;
  onRetry(shotIndex: number): void;
}

export async function runCaptureSequence(options: CaptureSequenceOptions): Promise<void> {
  for (let shotIndex = 0; shotIndex < options.prompts.length; shotIndex += 1) {
    while (!options.signal.aborted) {
      for (const value of captureCountdownValues) {
        if (options.signal.aborted) return;
        options.onCountdown(value, shotIndex);
        try {
          await options.sleep(options.tickMs, options.signal);
        } catch (error) {
          if (options.signal.aborted) return;
          throw error;
        }
        if (options.signal.aborted) return;
      }

      try {
        const photo = await options.camera.capture();
        if (options.signal.aborted) return;

        options.onCaptureFeedback?.(shotIndex);
        if (options.postCaptureDelayMs > 0) {
          try {
            await options.sleep(options.postCaptureDelayMs, options.signal);
          } catch (error) {
            if (options.signal.aborted) return;
            throw error;
          }
        }
        if (options.signal.aborted) return;

        options.onCaptured(photo, shotIndex);
        break;
      } catch (error) {
        if (options.signal.aborted) return;
        options.onRetry(shotIndex);
      }
    }
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timeout = window.setTimeout(finish, ms);
    const onAbort = () => finish();
    function finish(): void {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
