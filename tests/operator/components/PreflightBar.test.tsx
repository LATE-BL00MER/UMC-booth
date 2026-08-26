import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  getPreflightReadiness,
  PreflightBar,
  type PreflightStatus,
} from "../../../src/operator/components/PreflightBar.js";

const readyStatus: PreflightStatus = {
  cameraReady: true,
  acceptingCaptures: true,
  tunnel: { state: "healthy", publicUrl: "https://calm-river.trycloudflare.com", latencyMs: 42, error: null },
  lastSuccessfulSweepAt: 40_001,
  framePackValid: true,
  loadedPoseCount: 6,
  joinUrlConfigured: true,
  activeCiphertextCount: 2,
};

const checkedAt = 400_000;

describe("PreflightBar", () => {
  it("renders only operational preflight information and exposes a ready state", () => {
    const onReadyChange = vi.fn();
    render(<PreflightBar status={readyStatus} now={() => checkedAt} onReadyChange={onReadyChange} />);

    expect(screen.getByLabelText("운영 준비 상태")).toHaveAttribute("data-ready", "true");
    expect(screen.getByText("카메라: 준비됨")).toBeVisible();
    expect(screen.getByText("터널: 연결됨")).toBeVisible();
    expect(screen.getByText("정리: 정상")).toBeVisible();
    expect(screen.getByText("활성 암호문: 2")).toBeVisible();
    expect(screen.getByText("공개 지연: 42ms")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(onReadyChange).toHaveBeenCalledWith(true);
  });

  it("requires every readiness gate, including a sweep within the cleanup interval and grace period", () => {
    expect(getPreflightReadiness(readyStatus, checkedAt)).toBe(true);
    expect(getPreflightReadiness({ ...readyStatus, loadedPoseCount: 5 }, checkedAt)).toBe(false);
    expect(getPreflightReadiness({ ...readyStatus, lastSuccessfulSweepAt: 39_999 }, checkedAt)).toBe(false);
    expect(getPreflightReadiness({ ...readyStatus, tunnel: { ...readyStatus.tunnel, state: "down" } }, checkedAt)).toBe(false);
    expect(getPreflightReadiness({ ...readyStatus, acceptingCaptures: false }, checkedAt)).toBe(false);

    render(<PreflightBar status={{ ...readyStatus, joinUrlConfigured: false }} now={() => checkedAt} />);
    expect(screen.getByLabelText("운영 준비 상태")).toHaveAttribute("data-ready", "false");
  });
});
