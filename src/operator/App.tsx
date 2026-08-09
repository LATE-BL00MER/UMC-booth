import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import {
  boothReducer,
  initialBoothState,
  type BoothEvent,
  type BoothState,
} from "./booth-machine.js";
import type { CameraPort } from "./camera/camera-port.js";
import { CaptureScreen } from "./components/CaptureScreen.js";
import {
  getPreflightReadiness,
  PreflightBar,
  type PreflightStatus,
} from "./components/PreflightBar.js";
import { QrScreen } from "./components/QrScreen.js";
import { ResetControl } from "./components/ResetControl.js";
import { SelectionScreen } from "./components/SelectionScreen.js";
import { FrameScreen } from "./components/FrameScreen.js";
import { WelcomeScreen } from "./components/WelcomeScreen.js";
import type { DeliveryCoordinator } from "./delivery/delivery-coordinator.js";
import type { IssuedSessionRegistry } from "./delivery/issued-session-registry.js";
import type { PrivateApiClient } from "./delivery/private-api-client.js";
import type { BrowserCompositor } from "./frames/browser-compositor.js";
import type { FrameManifest } from "./frames/frame-contract.js";

export interface RuntimePreflightStatus {
  tunnel: PreflightStatus["tunnel"];
  lastSuccessfulSweepAt: number | null;
  activeCiphertextCount: number;
}

/** Reads the server-owned readiness fields which cannot be inferred from a public URL alone. */
export interface PreflightPort {
  readStatus(signal: AbortSignal): Promise<RuntimePreflightStatus>;
}

export interface AppServices {
  camera: CameraPort;
  compositor: Pick<BrowserCompositor, "compose">;
  delivery: DeliveryCoordinator;
  registry: IssuedSessionRegistry;
  api: PrivateApiClient;
  frames: FrameManifest[];
  prompts: [string, string, string, string, string, string];
  countdownTickMs: number;
  getPublicUrl(): string | null;
  preflight: PreflightPort;
}

export function App({ services }: { services: AppServices }) {
  const [state, reactDispatch] = useReducer(boothReducer, undefined, initialBoothState);
  const stateRef = useRef<BoothState>(state);
  const currentAbortController = useRef(new AbortController());
  const mounted = useRef(true);
  const resetPromise = useRef<Promise<void> | null>(null);
  const [preflightStatus, setPreflightStatus] = useState<PreflightStatus | null>(null);

  const dispatch = useCallback((event: BoothEvent) => {
    if (!mounted.current) return;
    stateRef.current = boothReducer(stateRef.current, event);
    reactDispatch(event);
  }, []);

  const runPreflight = useCallback(async () => {
    const currentState = stateRef.current;
    const controller = currentAbortController.current;
    const generation = currentState.generation;
    if (currentState.phase !== "preflight" || controller.signal.aborted) return;

    setPreflightStatus(null);
    try {
      const [cameraReady, runtimeStatus] = await Promise.all([
        services.camera.probe(),
        services.preflight.readStatus(controller.signal),
      ]);
      if (controller.signal.aborted || currentAbortController.current !== controller) return;

      const status: PreflightStatus = {
        cameraReady,
        tunnel: runtimeStatus.tunnel,
        lastSuccessfulSweepAt: runtimeStatus.lastSuccessfulSweepAt,
        framePackValid: hasValidFramePack(services.frames),
        loadedPoseCount: services.prompts.filter((prompt) => prompt.trim().length > 0).length,
        joinUrlConfigured: services.getPublicUrl() !== null,
        activeCiphertextCount: runtimeStatus.activeCiphertextCount,
      };
      if (!mounted.current || currentAbortController.current !== controller) return;

      setPreflightStatus(status);
      if (getPreflightReadiness(status, Date.now())) {
        dispatch({ type: "PREFLIGHT_SUCCEEDED", generation });
      } else {
        dispatch({ type: "PREFLIGHT_FAILED", generation, message: "운영 준비 상태를 확인할 수 없습니다" });
      }
    } catch {
      if (controller.signal.aborted || !mounted.current || currentAbortController.current !== controller) return;
      dispatch({ type: "PREFLIGHT_FAILED", generation, message: "운영 준비 상태를 확인할 수 없습니다" });
    }
  }, [dispatch, services]);

  const resetCurrentSession = useCallback(async () => {
    if (resetPromise.current) return resetPromise.current;

    const teardown = (async () => {
      currentAbortController.current.abort();
      services.camera.stop();

      const currentState = stateRef.current;
      revokePreviews(currentState);
      if (currentState.pendingSessionId !== null) {
        try {
          await services.api.deletePending(currentState.pendingSessionId);
        } catch {
          // The server endpoint is idempotent. Reset still must return the kiosk to a usable state.
        }
      }

      dispatch({ type: "RESET_CONFIRMED" });
      currentAbortController.current = new AbortController();
      await runPreflight();
    })();
    resetPromise.current = teardown;
    try {
      await teardown;
    } finally {
      resetPromise.current = null;
    }
  }, [dispatch, runPreflight, services]);

  const startDelivery = useCallback(async () => {
    const currentState = stateRef.current;
    const controller = currentAbortController.current;
    const generation = currentState.generation;
    if (currentState.phase !== "delivering" || controller.signal.aborted || currentState.selectedFrameId === null) return;

    const frame = services.frames.find((candidate) => candidate.id === currentState.selectedFrameId);
    const photosById = new Map(currentState.photos.map((photo) => [photo.id, photo]));
    const photos = currentState.selectedIds.map((id) => photosById.get(id));
    if (!frame || photos.length !== 4 || photos.some((photo) => photo === undefined)) {
      dispatch({ type: "DELIVERY_FAILED", generation, message: "사진을 만들지 못했습니다" });
      return;
    }

    try {
      const jpeg = await services.compositor.compose({
        photos: photos.map((photo) => photo!.blob),
        frame,
      });
      if (controller.signal.aborted || currentAbortController.current !== controller) return;

      const publicBaseUrl = services.getPublicUrl();
      if (publicBaseUrl === null) throw new Error("Public delivery URL is unavailable");
      const issued = await services.delivery.issue({
        jpeg,
        publicBaseUrl,
        generation,
        signal: controller.signal,
        onPendingSessionCreated: (id) => dispatch({ type: "PENDING_SESSION_CREATED", generation, id }),
      });
      if (controller.signal.aborted || currentAbortController.current !== controller) return;

      revokePreviews(currentState);
      dispatch({ type: "DELIVERY_SUCCEEDED", generation, issued });
    } catch (error) {
      if (controller.signal.aborted || currentAbortController.current !== controller || isAbortError(error)) return;
      dispatch({ type: "DELIVERY_FAILED", generation, message: "사진을 만들지 못했습니다" });
    }
  }, [dispatch, services]);

  const confirmFrame = useCallback(() => {
    if (stateRef.current.phase !== "framing") return;
    dispatch({ type: "FRAME_CONFIRMED" });
    void startDelivery();
  }, [dispatch, startDelivery]);

  const retry = useCallback(() => {
    const currentState = stateRef.current;
    if (currentState.phase !== "error") return;
    if (currentState.selectedIds.length === 4 && currentState.selectedFrameId !== null) {
      dispatch({ type: "DELIVERY_RETRY_REQUESTED" });
      void startDelivery();
      return;
    }
    void resetCurrentSession();
  }, [dispatch, resetCurrentSession, startDelivery]);

  useEffect(() => {
    void runPreflight();
    return () => {
      mounted.current = false;
      currentAbortController.current.abort();
      services.camera.stop();
      const currentState = stateRef.current;
      revokePreviews(currentState);
      if (currentState.pendingSessionId !== null) {
        void services.api.deletePending(currentState.pendingSessionId).catch(() => undefined);
      }
    };
  }, [runPreflight, services]);

  const phaseScreen = renderPhase({
    state,
    services,
    controller: currentAbortController.current,
    preflightStatus,
    dispatch,
    onConfirmFrame: confirmFrame,
    onRetry: retry,
  });

  return (
    <>
      <main>{phaseScreen}</main>
      <ResetControl onConfirm={() => void resetCurrentSession()} />
    </>
  );
}

function renderPhase({
  state,
  services,
  controller,
  preflightStatus,
  dispatch,
  onConfirmFrame,
  onRetry,
}: {
  state: BoothState;
  services: AppServices;
  controller: AbortController;
  preflightStatus: PreflightStatus | null;
  dispatch(event: BoothEvent): void;
  onConfirmFrame(): void;
  onRetry(): void;
}) {
  switch (state.phase) {
    case "preflight":
      return (
        <section aria-label="운영 준비 확인">
          {preflightStatus === null ? (
            <p aria-live="polite">운영 준비 상태를 확인하는 중입니다</p>
          ) : (
            <PreflightBar status={preflightStatus} />
          )}
        </section>
      );
    case "welcome":
      return <WelcomeScreen onStart={() => dispatch({ type: "EXPERIENCE_STARTED" })} />;
    case "capturing":
      return (
        <CaptureScreen
          camera={services.camera}
          prompts={services.prompts}
          generation={state.generation}
          signal={controller.signal}
          tickMs={services.countdownTickMs}
          onPhotoCaptured={(photo, generation) => dispatch({ type: "PHOTO_CAPTURED", generation, photo })}
          onError={() => dispatch({ type: "CAPTURE_FAILED", generation: state.generation, message: "사진을 촬영하지 못했습니다" })}
        />
      );
    case "selecting":
      return (
        <SelectionScreen
          photos={state.photos}
          selectedIds={state.selectedIds}
          onToggle={(id) => dispatch({ type: "PHOTO_TOGGLED", id })}
          onClear={() => dispatch({ type: "SELECTION_CLEARED" })}
          onContinue={() => dispatch({ type: "SELECTION_CONFIRMED" })}
        />
      );
    case "framing":
      return (
        <FrameScreen
          photos={state.photos}
          selectedIds={state.selectedIds}
          frames={services.frames}
          selectedFrameId={state.selectedFrameId}
          onFrameSelect={(id) => dispatch({ type: "FRAME_SELECTED", id })}
          onContinue={onConfirmFrame}
        />
      );
    case "delivering":
      return <section aria-label="사진 발급"><p aria-live="polite">사진을 만드는 중입니다</p></section>;
    case "qr":
      return state.issuedSession === null
        ? <ErrorScreen onRetry={onRetry} />
        : <QrScreen issued={state.issuedSession} />;
    case "error":
      return <ErrorScreen onRetry={onRetry} />;
    default:
      return assertNever(state.phase);
  }
}

function ErrorScreen({ onRetry }: { onRetry(): void }) {
  return (
    <section aria-label="오류">
      <p role="alert">사진을 준비하지 못했습니다</p>
      <button type="button" onClick={onRetry}>다시 시도</button>
    </section>
  );
}

function hasValidFramePack(frames: readonly FrameManifest[]): boolean {
  return frames.length > 0 && frames.every((frame) =>
    frame.id.trim().length > 0 &&
    frame.label.trim().length > 0 &&
    frame.canvas.width > 0 &&
    frame.canvas.height > 0 &&
    frame.jpegQuality >= 0.5 &&
    frame.jpegQuality <= 1 &&
    frame.thumbnail.trim().length > 0 &&
    frame.overlay.trim().length > 0 &&
    frame.slots.length === 4,
  );
}

function revokePreviews(state: BoothState): void {
  for (const photo of state.photos) URL.revokeObjectURL(photo.previewUrl);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function assertNever(value: never): never {
  throw new Error(`Unhandled booth phase: ${value}`);
}
