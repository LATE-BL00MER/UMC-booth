import { useEffect, useRef, useState } from "react";

import type { CapturedPhoto } from "../booth-machine.js";
import type { CameraPort } from "../camera/camera-port.js";
import {
  abortableSleep,
  runCaptureSequence,
  type CaptureSequenceOptions,
} from "../camera/capture-sequence.js";

type PosePrompts = [string, string, string, string, string, string];

export interface CaptureScreenProps {
  camera: CameraPort;
  prompts: PosePrompts;
  generation: number;
  signal: AbortSignal;
  tickMs: number;
  sleep?: CaptureSequenceOptions["sleep"];
  onPhotoCaptured(photo: CapturedPhoto, generation: number): void;
  onRetry?(shotIndex: number): void;
  onError?(error: unknown): void;
}

export function CaptureScreen({
  camera,
  prompts,
  generation,
  signal,
  tickMs,
  sleep = abortableSleep,
  onPhotoCaptured,
  onRetry,
  onError,
}: CaptureScreenProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const callbacksRef = useRef({ onPhotoCaptured, onRetry, onError });
  const [shotIndex, setShotIndex] = useState(0);
  const [countdown, setCountdown] = useState<5 | 4 | 3 | 2 | 1 | null>(null);

  callbacksRef.current = { onPhotoCaptured, onRetry, onError };

  useEffect(() => {
    const screenAbortController = new AbortController();
    const abortScreen = () => screenAbortController.abort();
    if (signal.aborted) abortScreen();
    else signal.addEventListener("abort", abortScreen, { once: true });

    void (async () => {
      try {
        const video = videoRef.current;
        if (!video || screenAbortController.signal.aborted) return;

        await camera.start(video);
        if (screenAbortController.signal.aborted) return;

        await runCaptureSequence({
          camera,
          prompts,
          signal: screenAbortController.signal,
          tickMs,
          sleep,
          onCountdown: (value, nextShotIndex) => {
            setShotIndex(nextShotIndex);
            setCountdown(value);
          },
          onCaptured: (blob, capturedShotIndex) => {
            const previewUrl = URL.createObjectURL(blob);
            callbacksRef.current.onPhotoCaptured(
              {
                id: `capture-${generation}-${capturedShotIndex + 1}`,
                blob,
                previewUrl,
              },
              generation,
            );
          },
          onRetry: (failedShotIndex) => callbacksRef.current.onRetry?.(failedShotIndex),
        });
      } catch (error) {
        if (!screenAbortController.signal.aborted) {
          callbacksRef.current.onError?.(error);
        }
      }
    })();

    return () => {
      screenAbortController.abort();
      signal.removeEventListener("abort", abortScreen);
      camera.stop();
    };
  }, [camera, generation, prompts, signal, sleep, tickMs]);

  return (
    <section aria-label="사진 촬영">
      <p>{prompts[shotIndex]}</p>
      <p aria-live="polite">{shotIndex + 1} / 6</p>
      <video
        ref={videoRef}
        aria-label="카메라 미리보기"
        autoPlay
        muted
        playsInline
        style={{ transform: "scaleX(-1)" }}
      />
      <output aria-live="assertive">{countdown ?? ""}</output>
    </section>
  );
}
