import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { CapturedPhoto } from "../booth-machine.js";
import type { CameraPort } from "../camera/camera-port.js";
import {
  abortableSleep,
  runCaptureSequence,
  type CaptureSequenceOptions,
} from "../camera/capture-sequence.js";
import { playShutterSound, prepareShutterSound } from "../camera/shutter-sound.js";

type PosePrompts = [string, string, string, string, string, string];

export interface CaptureScreenProps {
  camera: CameraPort;
  captureAspectRatio: number;
  prompts: PosePrompts;
  generation: number;
  signal: AbortSignal;
  tickMs: number;
  postCaptureDelayMs?: number;
  sleep?: CaptureSequenceOptions["sleep"];
  playCaptureSound?: () => void;
  onPhotoCaptured(photo: CapturedPhoto, generation: number): void;
  onRetry?(shotIndex: number): void;
  onError?(error: unknown): void;
}

export function CaptureScreen({
  camera,
  captureAspectRatio,
  prompts,
  generation,
  signal,
  tickMs,
  postCaptureDelayMs = 1_500,
  sleep = abortableSleep,
  playCaptureSound = playShutterSound,
  onPhotoCaptured,
  onRetry,
  onError,
}: CaptureScreenProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pulseTimeoutRef = useRef<number | null>(null);
  const callbacksRef = useRef({ onPhotoCaptured, onRetry, onError });
  const [shotIndex, setShotIndex] = useState(0);
  const [countdown, setCountdown] = useState<5 | 4 | 3 | 2 | 1 | null>(null);
  const [isCapturePulsing, setIsCapturePulsing] = useState(false);
  const captureViewportStyle = {
    "--capture-aspect-ratio": captureAspectRatio,
  } as CSSProperties;

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

        prepareShutterSound();
        await camera.start(video);
        if (screenAbortController.signal.aborted) return;

        await runCaptureSequence({
          camera,
          prompts,
          signal: screenAbortController.signal,
          tickMs,
          postCaptureDelayMs,
          sleep,
          onCountdown: (value, nextShotIndex) => {
            setShotIndex(nextShotIndex);
            setCountdown(value);
          },
          onCaptureFeedback: () => {
            setCountdown(null);
            try {
              playCaptureSound();
            } catch {
              // Audio feedback must never interrupt or retry a successful camera capture.
            }
            setIsCapturePulsing(true);
            if (pulseTimeoutRef.current !== null) window.clearTimeout(pulseTimeoutRef.current);
            pulseTimeoutRef.current = window.setTimeout(() => {
              setIsCapturePulsing(false);
              pulseTimeoutRef.current = null;
            }, 360);
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
      if (pulseTimeoutRef.current !== null) window.clearTimeout(pulseTimeoutRef.current);
      camera.stop();
    };
  }, [camera, generation, playCaptureSound, postCaptureDelayMs, prompts, signal, sleep, tickMs]);

  return (
    <section className="capture-screen" aria-label="사진 촬영">
      <div className="capture-viewport" style={captureViewportStyle} data-capture-pulse={isCapturePulsing}>
        <video
          className="capture-video"
          ref={videoRef}
          aria-label="카메라 미리보기"
          autoPlay
          muted
          playsInline
        />
        <div className="capture-overlay" aria-hidden="true" />
      </div>
      <p className="capture-prompt" aria-live="polite">{prompts[shotIndex]}</p>
      <p className="capture-progress" aria-live="polite">{shotIndex + 1} / 6</p>
      <output className="capture-countdown" aria-live="assertive">{countdown ?? ""}</output>
      <p className="capture-guidance">테두리 안에 모두 들어오도록 위치해 주세요</p>
    </section>
  );
}
