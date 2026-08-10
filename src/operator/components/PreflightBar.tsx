import { useEffect } from "react";

export interface PreflightTunnelStatus {
  state: "starting" | "healthy" | "down";
  publicUrl: string | null;
  latencyMs: number | null;
  error: "missing-binary" | "process-exit" | "health-failed" | null;
}

export interface PreflightStatus {
  cameraReady: boolean;
  acceptingCaptures: boolean;
  tunnel: PreflightTunnelStatus;
  lastSuccessfulSweepAt: number | null;
  framePackValid: boolean;
  loadedPoseCount: number;
  joinUrlConfigured: boolean;
  activeCiphertextCount: number;
}

export interface PreflightBarProps {
  status: PreflightStatus;
  now?: () => number;
  onReadyChange?(ready: boolean): void;
}

const SWEEP_FRESHNESS_MS = 60_000;

export function getPreflightReadiness(status: PreflightStatus, now: number): boolean {
  return status.cameraReady &&
    status.acceptingCaptures &&
    status.tunnel.state === "healthy" &&
    isFreshSweep(status.lastSuccessfulSweepAt, now) &&
    status.framePackValid &&
    status.loadedPoseCount === 6 &&
    status.joinUrlConfigured;
}

export function PreflightBar({ status, now = Date.now, onReadyChange }: PreflightBarProps) {
  const checkedAt = now();
  const ready = getPreflightReadiness(status, checkedAt);
  const cleanupReady = isFreshSweep(status.lastSuccessfulSweepAt, checkedAt);

  useEffect(() => {
    onReadyChange?.(ready);
  }, [onReadyChange, ready]);

  return (
    <section className="preflight-panel" aria-label="운영 준비 상태" data-ready={ready}>
      <p className="preflight-item" data-tone={status.cameraReady ? "success" : "danger"}>카메라: {status.cameraReady ? "준비됨" : "확인 필요"}</p>
      <p className="preflight-item" data-tone={status.tunnel.state === "healthy" ? "success" : "warning"}>터널: {status.tunnel.state === "healthy" ? "연결됨" : "연결 대기"}</p>
      <p className="preflight-item" data-tone={cleanupReady ? "success" : "danger"}>정리: {cleanupReady ? "정상" : "확인 필요"}</p>
      <p className="preflight-item" data-tone="neutral">활성 암호문: {status.activeCiphertextCount}</p>
      <p className="preflight-item" data-tone={status.tunnel.latencyMs === null ? "warning" : "success"}>공개 지연: {status.tunnel.latencyMs === null ? "측정 중" : `${status.tunnel.latencyMs}ms`}</p>
    </section>
  );
}

function isFreshSweep(lastSuccessfulSweepAt: number | null, now: number): boolean {
  return lastSuccessfulSweepAt !== null &&
    lastSuccessfulSweepAt <= now &&
    now - lastSuccessfulSweepAt <= SWEEP_FRESHNESS_MS;
}
