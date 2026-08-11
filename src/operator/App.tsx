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
import { OperatorShell } from "./components/OperatorShell.js";
import { SelectionScreen } from "./components/SelectionScreen.js";
import { FrameScreen } from "./components/FrameScreen.js";
import { WelcomeScreen } from "./components/WelcomeScreen.js";
import type { DeliveryCoordinator } from "./delivery/delivery-coordinator.js";
import type { IssuedSessionRegistry } from "./delivery/issued-session-registry.js";
import type { PrivateApiClient } from "./delivery/private-api-client.js";
import type { BrowserCompositor } from "./frames/browser-compositor.js";
import { getCaptureAspectRatio, type FrameManifest } from "./frames/frame-contract.js";

const RESET_PENDING_DELETE_TIMEOUT_MS = 500;
const RESET_PREFLIGHT_TIMEOUT_MS = 2_000;
const STATUS_POLL_INTERVAL_MS = 2_000;

export type OperatorMetricEvent = "team_start" | "completed_qr";

export interface OperatorMetricsPort {
  record(event: OperatorMetricEvent): Promise<void>;
}

export interface RuntimePreflightStatus {
  tunnel: PreflightStatus["tunnel"];
  acceptingCaptures: boolean;
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
  exposeDeliveryUrl?: boolean;
  getPublicUrl(): string | null;
  preflight: PreflightPort;
  metrics?: OperatorMetricsPort;
}

export function App({ services }: { services: AppServices }) {
  const [state, reactDispatch] = useReducer(boothReducer, undefined, initialBoothState);
  const stateRef = useRef<BoothState>(state);
  const currentAbortController = useRef(new AbortController());
  const validatedPublicUrl = useRef<string | null>(null);
  const lastHealthyPublicUrl = useRef<string | null>(null);
  const mounted = useRef(true);
  const mountedServices = useRef<AppServices | null>(null);
  const resetPromise = useRef<Promise<void> | null>(null);
  const [preflightStatus, setPreflightStatus] = useState<PreflightStatus | null>(null);
  const [acceptingLive, setAcceptingLive] = useState(false);
  const acceptingLiveRef = useRef(false);
  const [issuedHistory, setIssuedHistory] = useState(() => services.registry.list());
  const startedMetricGenerations = useRef(new Set<number>());
  const completedMetricGenerations = useRef(new Set<number>());

  const dispatch = useCallback((event: BoothEvent) => {
    if (!mounted.current) return;
    stateRef.current = boothReducer(stateRef.current, event);
    reactDispatch(event);
  }, []);

  const applyRuntimeStatus = useCallback((runtimeStatus: RuntimePreflightStatus) => {
    const publicUrl = runtimeStatus.acceptingCaptures && runtimeStatus.tunnel.state === "healthy"
      ? runtimeStatus.tunnel.publicUrl
      : null;
    const accepting = publicUrl !== null;
    acceptingLiveRef.current = accepting;
    setAcceptingLive(accepting);
    if (publicUrl === null) {
      validatedPublicUrl.current = null;
      return;
    }
    if (lastHealthyPublicUrl.current !== null && lastHealthyPublicUrl.current !== publicUrl) {
      const reissued = services.registry.reissueAll(publicUrl);
      setIssuedHistory(services.registry.list());
      const currentIssued = stateRef.current.issuedSession;
      const replacement = currentIssued === null
        ? null
        : reissued.find((issued) => issued.id === currentIssued.id) ?? null;
      if (replacement !== null) {
        dispatch({ type: "ISSUED_SESSION_REISSUED", issued: replacement });
      }
    }
    lastHealthyPublicUrl.current = publicUrl;
    validatedPublicUrl.current = publicUrl;
  }, [dispatch, services]);

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
        acceptingCaptures: runtimeStatus.acceptingCaptures,
        tunnel: runtimeStatus.tunnel,
        lastSuccessfulSweepAt: runtimeStatus.lastSuccessfulSweepAt,
        framePackValid: hasValidFramePack(services.frames),
        loadedPoseCount: services.prompts.filter((prompt) => prompt.trim().length > 0).length,
        joinUrlConfigured: runtimeStatus.tunnel.state === "healthy" && runtimeStatus.tunnel.publicUrl !== null,
        activeCiphertextCount: runtimeStatus.activeCiphertextCount,
      };
      if (!mounted.current || currentAbortController.current !== controller) return;

      setPreflightStatus(status);
      if (getPreflightReadiness(status, Date.now())) {
        applyRuntimeStatus(runtimeStatus);
        dispatch({ type: "PREFLIGHT_SUCCEEDED", generation });
      } else {
        dispatch({ type: "PREFLIGHT_FAILED", generation, message: "운영 준비 상태를 확인할 수 없습니다" });
      }
    } catch {
      if (controller.signal.aborted || !mounted.current || currentAbortController.current !== controller) return;
      dispatch({ type: "PREFLIGHT_FAILED", generation, message: "운영 준비 상태를 확인할 수 없습니다" });
    }
  }, [applyRuntimeStatus, dispatch, services]);

  const resetCurrentSession = useCallback(async () => {
    if (resetPromise.current) return resetPromise.current;

    const teardown = (async () => {
      currentAbortController.current.abort();
      services.camera.stop();

      const currentState = stateRef.current;
      revokePreviews(currentState);
      const pendingCleanup = currentState.pendingSessionId === null
        ? null
        : startPendingCleanup(services.api, currentState.pendingSessionId);
      if (pendingCleanup !== null) {
        await completesBefore(pendingCleanup, RESET_PENDING_DELETE_TIMEOUT_MS);
      }

      dispatch({ type: "RESET_CONFIRMED" });
      setIssuedHistory(services.registry.list());
      currentAbortController.current = new AbortController();
      const controller = currentAbortController.current;
      const completed = await completesBefore(runPreflight(), RESET_PREFLIGHT_TIMEOUT_MS);
      if (!completed && currentAbortController.current === controller) {
        controller.abort();
        dispatch({ type: "PREFLIGHT_FAILED", generation: stateRef.current.generation, message: "운영 준비 상태를 확인할 수 없습니다" });
      }
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

      const publicBaseUrl = validatedPublicUrl.current;
      if (publicBaseUrl === null) throw new Error("Public delivery URL is unavailable");
      const issued = await services.delivery.issue({
        jpeg,
        publicBaseUrl,
        generation,
        signal: controller.signal,
        onPendingSessionCreated: (id) => dispatch({ type: "PENDING_SESSION_CREATED", generation, id }),
      });
      if (controller.signal.aborted || currentAbortController.current !== controller) return;

      const latestPublicUrl = validatedPublicUrl.current;
      const displayedIssued = latestPublicUrl !== null && latestPublicUrl !== publicBaseUrl
        ? services.registry.reissueAll(latestPublicUrl).find((candidate) => candidate.id === issued.id) ?? issued
        : issued;

      if (!completedMetricGenerations.current.has(generation)) {
        completedMetricGenerations.current.add(generation);
        void services.metrics?.record("completed_qr").catch(() => undefined);
      }
      revokePreviews(currentState);
      dispatch({ type: "DELIVERY_SUCCEEDED", generation, issued: displayedIssued });
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

  const redisplayIssuedSession = useCallback((id: string) => {
    const publicUrl = validatedPublicUrl.current;
    if (!acceptingLiveRef.current || publicUrl === null) return;
    const issued = services.registry.reissue(id, publicUrl);
    if (!issued) {
      setIssuedHistory(services.registry.list());
      return;
    }
    setIssuedHistory(services.registry.list());
    dispatch({ type: "ISSUED_SESSION_DISPLAY_REQUESTED", issued });
  }, [dispatch, services]);

  const startExperience = useCallback(() => {
    const currentState = stateRef.current;
    if (!acceptingLiveRef.current || currentState.phase !== "welcome") return;
    if (!startedMetricGenerations.current.has(currentState.generation)) {
      startedMetricGenerations.current.add(currentState.generation);
      void services.metrics?.record("team_start").catch(() => undefined);
    }
    dispatch({ type: "EXPERIENCE_STARTED" });
  }, [dispatch, services]);

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

  const navigateBack = useCallback(() => {
    const currentState = stateRef.current;
    if (currentState.phase !== "capturing" && currentState.phase !== "selecting" && currentState.phase !== "framing") {
      return;
    }

    if (currentState.phase !== "framing") {
      currentAbortController.current.abort();
      services.camera.stop();
      revokePreviews(currentState);
      currentAbortController.current = new AbortController();
    }
    dispatch({ type: "NAVIGATED_BACK" });
  }, [dispatch, services.camera]);

  useEffect(() => {
    const servicesWereReplaced = mountedServices.current !== null && mountedServices.current !== services;
    mounted.current = true;
    if (currentAbortController.current.signal.aborted) {
      currentAbortController.current = new AbortController();
    }
    if (servicesWereReplaced && stateRef.current.phase !== "preflight") {
      dispatch({ type: "RESET_CONFIRMED" });
    }
    mountedServices.current = services;
    void runPreflight();
    return () => {
      mounted.current = false;
      currentAbortController.current.abort();
      services.camera.stop();
      const currentState = stateRef.current;
      revokePreviews(currentState);
      if (currentState.pendingSessionId !== null) {
        startPendingCleanup(services.api, currentState.pendingSessionId);
      }
    };
  }, [runPreflight, services]);

  useEffect(() => {
    const controller = new AbortController();
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void services.preflight.readStatus(controller.signal)
        .then((status) => {
          if (!controller.signal.aborted && mounted.current) applyRuntimeStatus(status);
        })
        .catch(() => {
          if (!controller.signal.aborted && mounted.current) {
            validatedPublicUrl.current = null;
            acceptingLiveRef.current = false;
            setAcceptingLive(false);
          }
        })
        .finally(() => {
          polling = false;
        });
    }, STATUS_POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [applyRuntimeStatus, services]);

  const phaseScreen = renderPhase({
    state,
    services,
    controller: currentAbortController.current,
    preflightStatus,
    dispatch,
    onConfirmFrame: confirmFrame,
    onRetry: retry,
    acceptingLive,
    issuedHistory,
    onRedisplayIssued: redisplayIssuedSession,
    onStartExperience: startExperience,
  });

  return (
    <OperatorShell
      phase={state.phase}
      status={preflightStatus}
      onBack={navigateBack}
      onReset={() => void resetCurrentSession()}
    >
      {phaseScreen}
    </OperatorShell>
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
  acceptingLive,
  issuedHistory,
  onRedisplayIssued,
  onStartExperience,
}: {
  state: BoothState;
  services: AppServices;
  controller: AbortController;
  preflightStatus: PreflightStatus | null;
  dispatch(event: BoothEvent): void;
  onConfirmFrame(): void;
  onRetry(): void;
  acceptingLive: boolean;
  issuedHistory: readonly import("../shared/contracts.js").IssuedSession[];
  onRedisplayIssued(id: string): void;
  onStartExperience(): void;
}) {
  switch (state.phase) {
    case "preflight":
      return (
        <section className="preflight-screen" aria-label="운영 준비 확인">
          <h1>운영 준비 상태를 확인하고 있어요</h1>
          {preflightStatus === null ? (
            <div className="loading-dots" aria-label="운영 준비 상태를 확인하는 중입니다" aria-live="polite">
              <span /><span /><span />
            </div>
          ) : (
            <PreflightBar status={preflightStatus} />
          )}
        </section>
      );
    case "welcome":
      return <WelcomeScreen
        acceptingCaptures={acceptingLive}
        issuedSessions={issuedHistory}
        onRedisplay={onRedisplayIssued}
        onStart={onStartExperience}
      />;
    case "capturing":
      return (
        <CaptureScreen
          camera={services.camera}
          captureAspectRatio={getCaptureAspectRatio(services.frames)}
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
          photoAspectRatio={getCaptureAspectRatio(services.frames)}
          selectedIds={state.selectedIds}
          onToggle={(id) => dispatch({ type: "PHOTO_TOGGLED", id })}
          onClear={() => dispatch({ type: "SELECTION_CLEARED" })}
          onContinue={() => {
            const defaultFrame = services.frames[0];
            if (defaultFrame) dispatch({ type: "SELECTION_CONFIRMED", frameId: defaultFrame.id });
          }}
        />
      );
    case "framing":
      return (
        <FrameScreen
          photos={state.photos}
          selectedIds={state.selectedIds}
          frames={services.frames}
          selectedFrameId={state.selectedFrameId}
          compositor={services.compositor}
          onFrameSelect={(id) => dispatch({ type: "FRAME_SELECTED", id })}
          onContinue={onConfirmFrame}
        />
      );
    case "delivering":
      return (
        <section className="phase-message" aria-label="사진 발급">
          <p className="eyebrow">FINALIZING</p>
          <h1>사진을 만들고 있어요</h1>
          <p aria-live="polite">사진을 만드는 중입니다</p>
          <div className="loading-dots" aria-hidden="true"><span /><span /><span /></div>
        </section>
      );
    case "qr":
      return state.issuedSession === null
        ? <ErrorScreen onRetry={onRetry} />
        : <QrScreen issued={state.issuedSession} exposeDeliveryUrl={services.exposeDeliveryUrl ?? false} />;
    case "error":
      return <ErrorScreen onRetry={onRetry} />;
    default:
      return assertNever(state.phase);
  }
}

function ErrorScreen({ onRetry }: { onRetry(): void }) {
  return (
    <section className="error-screen" aria-label="오류">
      <div className="error-screen__panel glass-panel">
        <p className="eyebrow">PLEASE TRY AGAIN</p>
        <h1 role="alert">사진을 준비하지 못했습니다</h1>
        <p>현재 단계부터 다시 시도할 수 있어요.</p>
        <button className="button button--primary" type="button" onClick={onRetry}>다시 시도</button>
      </div>
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

function completesBefore(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };
    void promise.then(() => finish(true), () => finish(true));
  });
}

function startPendingCleanup(api: PrivateApiClient, id: string): Promise<void> {
  let deletion: Promise<void>;
  try {
    deletion = api.deletePending(id);
  } catch (error) {
    deletion = Promise.reject(error);
  }
  void deletion.catch(() => undefined);
  return deletion;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled booth phase: ${value}`);
}
