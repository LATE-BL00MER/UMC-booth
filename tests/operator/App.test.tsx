import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toDataURL } from "qrcode";

import { App, type AppServices, type RuntimePreflightStatus } from "../../src/operator/App.js";
import type { CameraPort } from "../../src/operator/camera/camera-port.js";
import { MemoryIssuedSessionRegistry } from "../../src/operator/delivery/issued-session-registry.js";
import type { FrameManifest } from "../../src/operator/frames/frame-contract.js";
import type { PreflightStatus } from "../../src/operator/components/PreflightBar.js";
import type { IssuedSession } from "../../src/shared/contracts.js";

vi.mock("qrcode", () => ({
  toDataURL: vi.fn(async () => "data:image/png;base64,cXI="),
}));

const prompts: [string, string, string, string, string, string] = [
  "첫 번째 포즈",
  "두 번째 포즈",
  "세 번째 포즈",
  "네 번째 포즈",
  "다섯 번째 포즈",
  "여섯 번째 포즈",
];

const frame: FrameManifest = {
  id: "basic",
  label: "기본 프레임",
  canvas: { width: 100, height: 100 },
  jpegQuality: 0.9,
  thumbnail: "/basic-thumbnail.svg",
  overlay: "/basic-overlay.svg",
  slots: [0, 1, 2, 3].map((index) => ({
    x: index * 10,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    fit: "cover" as const,
  })) as FrameManifest["slots"],
};

const readyStatus: PreflightStatus = {
  cameraReady: true,
  acceptingCaptures: true,
  tunnel: { state: "healthy", publicUrl: "https://booth.example", latencyMs: 12, error: null },
  lastSuccessfulSweepAt: Date.now(),
  framePackValid: true,
  loadedPoseCount: 6,
  joinUrlConfigured: true,
  activeCiphertextCount: 0,
};

class FakeCamera implements CameraPort {
  captureCount = 0;

  async probe(): Promise<boolean> {
    return true;
  }

  async start(_video: HTMLVideoElement): Promise<void> {}

  async capture(): Promise<Blob> {
    this.captureCount += 1;
    return new Blob([`photo-${this.captureCount}`], { type: "image/jpeg" });
  }

  stop(): void {}

  async finishSixShots(): Promise<void> {
    await waitFor(() => expect(this.captureCount).toBe(6));
  }
}

function createFakeServices(): AppServices {
  const registry = new MemoryIssuedSessionRegistry();
  const issued: IssuedSession = {
    id: "issued-session",
    publicToken: "public-token",
    deliveryUrl: "https://booth.example/d/public-token#key=kept-out-of-app-state",
    expiresAt: Date.now() + 600_000,
  };

  return {
    camera: new FakeCamera(),
    compositor: {
      compose: vi.fn(async () => new Blob(["composed"], { type: "image/jpeg" })),
    },
    delivery: {
      issue: vi.fn(async () => {
        registry.add(issued, "kept-out-of-app-state");
        return issued;
      }),
    },
    registry,
    api: {
      createPending: vi.fn(),
      activate: vi.fn(),
      resolveActivationOrDelete: vi.fn(async () => ({ status: "deleted" as const })),
      deletePending: vi.fn(async () => undefined),
    },
    frames: [frame],
    prompts,
    countdownTickMs: 1,
    getPublicUrl: () => "https://booth.example",
    preflight: {
      readStatus: async () => readyStatus,
    },
  };
}

describe("App", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("runs welcome, six captures, four selections, frame, QR, and reset", async () => {
    const user = userEvent.setup();
    const fakeServices = createFakeServices();
    const compose = vi.fn(async (_input: Parameters<AppServices["compositor"]["compose"]>[0]) => new Blob(["composed"], { type: "image/jpeg" }));
    fakeServices.compositor = { compose };
    render(<App services={fakeServices} />);

    await screen.findByRole("button", { name: "촬영 시작" });
    await user.click(screen.getByRole("checkbox", { name: "모든 팀원이 촬영에 동의했습니다" }));
    await user.click(screen.getByRole("button", { name: "촬영 시작" }));
    await (fakeServices.camera as FakeCamera).finishSixShots();
    for (const number of [4, 1, 6, 3]) {
      await user.click(screen.getByAltText(`촬영 사진 ${number}`));
    }
    await user.click(screen.getByRole("button", { name: "프레임 선택하기" }));
    await user.click(screen.getByRole("radio", { name: "기본 프레임" }));
    await user.click(screen.getByRole("button", { name: "이 프레임으로 사진 만들기" }));

    expect(await screen.findByText("팀원 모두 각자 스캔할 수 있습니다")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "처음으로" }));
    await user.click(screen.getByRole("button", { name: "확인" }));

    expect(await screen.findByRole("button", { name: "촬영 시작" })).toBeVisible();
    expect(fakeServices.registry.activeCount()).toBe(1);
    const [composition] = compose.mock.calls[0]!;
    expect(await Promise.all(composition.photos.map((photo) => photo.text()))).toEqual([
      "photo-4",
      "photo-1",
      "photo-6",
      "photo-3",
    ]);
  });

  it("requires complete readiness and team consent before capture can start", async () => {
    const user = userEvent.setup();
    const services = createFakeServices();
    render(<App services={services} />);

    const start = await screen.findByRole("button", { name: "촬영 시작" });
    expect(start).toBeDisabled();
    expect(screen.getByRole("button", { name: "이전 QR 다시 보기" })).toBeDisabled();
    expect(screen.getByText("사진은 암호화되어 QR 발급 5분 후 삭제됩니다")).toBeVisible();

    await user.click(screen.getByRole("checkbox", { name: "모든 팀원이 촬영에 동의했습니다" }));
    expect(start).toBeEnabled();
    await user.click(start);
    expect(await screen.findByLabelText("사진 촬영")).toBeVisible();
  });

  it("records one aggregate start and completed QR per generation despite stale clicks and delivery retries", async () => {
    const user = userEvent.setup();
    const services = createFakeServices();
    const record = vi.fn(async () => undefined);
    services.metrics = { record };
    render(<App services={services} />);

    await startAndReachFrame(user, services);
    await user.click(screen.getByRole("button", { name: "이 프레임으로 사진 만들기" }));
    await screen.findByLabelText("QR 코드");
    fireEvent.click(screen.getByRole("button", { name: "처음으로" }));

    expect(record.mock.calls).toEqual([["team_start"], ["completed_qr"]]);
  });

  it("disables and guards welcome start as soon as live readiness closes", async () => {
    vi.useFakeTimers();
    const services = createFakeServices();
    let currentStatus = runtimeReadyStatus();
    services.preflight = { readStatus: vi.fn(async () => currentStatus) };
    render(<App services={services} />);

    await flushReact();
    fireEvent.click(screen.getByRole("checkbox", { name: "모든 팀원이 촬영에 동의했습니다" }));
    expect(screen.getByRole("button", { name: "촬영 시작" })).toBeEnabled();

    currentStatus = {
      ...runtimeReadyStatus(),
      acceptingCaptures: false,
      tunnel: { state: "down", publicUrl: null, latencyMs: null, error: "health-failed" },
    };
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await flushReact();

    const start = screen.getByRole("button", { name: "촬영 시작" });
    expect(start).toBeDisabled();
    fireEvent.click(start);
    expect(screen.queryByLabelText("촬영")) .not.toBeInTheDocument();
    expect((services.camera as FakeCamera).captureCount).toBe(0);
  });

  it("disables and guards welcome start when a live status poll rejects", async () => {
    vi.useFakeTimers();
    const services = createFakeServices();
    let reads = 0;
    services.preflight = {
      readStatus: async () => {
        reads += 1;
        if (reads === 1) return runtimeReadyStatus();
        throw new Error("status unavailable");
      },
    };
    render(<App services={services} />);

    await flushReact();
    fireEvent.click(screen.getByRole("checkbox", { name: "모든 팀원이 촬영에 동의했습니다" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await flushReact();

    const start = screen.getByRole("button", { name: "촬영 시작" });
    expect(start).toBeDisabled();
    fireEvent.click(start);
    expect((services.camera as FakeCamera).captureCount).toBe(0);
  });

  it("lets staff redisplay an unexpired issued QR after reset using the replacement tunnel URL", async () => {
    const user = userEvent.setup();
    const services = createFakeServices();
    services.registry.add(issuedSession(), "kept-out-of-app-state");
    render(<App services={services} />);

    await screen.findByRole("button", { name: "촬영 시작" });
    expect(screen.getByRole("button", { name: "이전 QR 다시 보기" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "이전 QR 다시 보기" }));

    expect(await screen.findByLabelText("QR 코드")).toBeVisible();
    expect(vi.mocked(toDataURL)).toHaveBeenLastCalledWith(
      "https://booth.example/d/public-token#key=kept-out-of-app-state",
      { errorCorrectionLevel: "M" },
    );
  });

  it("keeps the reset control available in every application phase", async () => {
    const user = userEvent.setup();
    const services = createFakeServices();
    const delivery = deferred<IssuedSession>();
    services.delivery = { issue: vi.fn(() => delivery.promise) };
    render(<App services={services} />);

    const expectReset = () => expect(screen.getByRole("button", { name: "처음으로" })).toBeVisible();
    expectReset();
    await screen.findByRole("button", { name: "촬영 시작" });
    expectReset();
    await startExperience(user);
    expect(await screen.findByLabelText("사진 촬영")).toBeVisible();
    expectReset();
    await (services.camera as FakeCamera).finishSixShots();
    expect(await screen.findByLabelText("사진 선택")).toBeVisible();
    expectReset();
    for (const number of [4, 1, 6, 3]) {
      await user.click(screen.getByAltText(`촬영 사진 ${number}`));
    }
    await user.click(screen.getByRole("button", { name: "프레임 선택하기" }));
    await user.click(screen.getByRole("radio", { name: "기본 프레임" }));
    expect(await screen.findByLabelText("프레임 선택")).toBeVisible();
    expectReset();
    await user.click(screen.getByRole("button", { name: "이 프레임으로 사진 만들기" }));
    expect(await screen.findByLabelText("사진 발급")).toBeVisible();
    expectReset();

    delivery.resolve(issuedSession());
    expect(await screen.findByLabelText("QR 코드")).toBeVisible();
    expectReset();
  });

  it("shows only retry and the global reset when readiness fails", async () => {
    const services = createFakeServices();
    services.preflight = {
      readStatus: async () => ({
        ...runtimeReadyStatus(),
        tunnel: { state: "down", publicUrl: null, latencyMs: null, error: "health-failed" },
      }),
    };
    render(<App services={services} />);

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "처음으로",
      "다시 시도",
    ]);
  });

  it("ignores preflight work from before reset", async () => {
    const user = userEvent.setup();
    const services = createFakeServices();
    const firstRead = deferred<RuntimePreflightStatus>();
    let reads = 0;
    services.preflight = {
      readStatus: async () => {
        reads += 1;
        return reads === 1 ? firstRead.promise : runtimeReadyStatus();
      },
    };
    render(<App services={services} />);

    await user.click(screen.getByRole("button", { name: "처음으로" }));
    await user.click(screen.getByRole("button", { name: "확인" }));
    expect(await screen.findByRole("button", { name: "촬영 시작" })).toBeVisible();

    await act(async () => firstRead.resolve(runtimeReadyStatus()));
    expect(screen.getByRole("button", { name: "촬영 시작" })).toBeVisible();
  });

  it("ignores a capture completing after reset and does not revive the old session", async () => {
    const user = userEvent.setup();
    const services = createFakeServices();
    const camera = new BlockingCamera();
    services.camera = camera;
    render(<App services={services} />);

    await startExperience(user);
    await waitFor(() => expect(camera.captureStarted).toBe(1));
    await reset(user);
    expect(await screen.findByRole("button", { name: "촬영 시작" })).toBeVisible();

    camera.photo.resolve(new Blob(["old photo"], { type: "image/jpeg" }));
    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "촬영 시작" })).toBeVisible();
    expect(screen.queryByLabelText("사진 선택")).not.toBeInTheDocument();
  });

  it("ignores delivery completion from before reset and preserves no QR for the old session", async () => {
    const user = userEvent.setup();
    const services = createFakeServices();
    const delivery = deferred<IssuedSession>();
    services.delivery = { issue: vi.fn(() => delivery.promise) };
    render(<App services={services} />);

    await startAndReachFrame(user, services);
    await user.click(screen.getByRole("button", { name: "이 프레임으로 사진 만들기" }));
    expect(await screen.findByLabelText("사진 발급")).toBeVisible();
    await reset(user);
    expect(await screen.findByRole("button", { name: "촬영 시작" })).toBeVisible();

    delivery.resolve(issuedSession());
    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "촬영 시작" })).toBeVisible();
    expect(screen.queryByLabelText("QR 코드")).not.toBeInTheDocument();
  });

  it("disposes all six raw preview URLs immediately after activation", async () => {
    const user = userEvent.setup();
    const services = createFakeServices();
    const createdUrls: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:raw-preview-${createdUrls.length + 1}`;
      createdUrls.push(url);
      return url;
    });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    render(<App services={services} />);

    await startAndReachFrame(user, services);
    await user.click(screen.getByRole("button", { name: "이 프레임으로 사진 만들기" }));
    await screen.findByLabelText("QR 코드");

    expect(revoke).toHaveBeenCalledTimes(7);
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining(createdUrls));
    expect(screen.queryByAltText("촬영 사진 1")).not.toBeInTheDocument();
    expect(screen.queryByAltText("선택한 사진 1")).not.toBeInTheDocument();

    await reset(user);
    expect(await screen.findByRole("button", { name: "촬영 시작" })).toBeVisible();
    expect(revoke).toHaveBeenCalledTimes(7);
    expect(services.registry.activeCount()).toBe(1);
  });

  it("starts delivery only once when the frame confirmation is activated twice", async () => {
    const user = userEvent.setup();
    const services = createFakeServices();
    const delivery = deferred<IssuedSession>();
    const issue = vi.fn(() => delivery.promise);
    services.delivery = { issue };
    render(<App services={services} />);

    await startAndReachFrame(user, services);
    const confirm = screen.getByRole("button", { name: "이 프레임으로 사진 만들기" });
    await Promise.all([user.click(confirm), user.click(confirm)]);
    await waitFor(() => expect(issue).toHaveBeenCalledOnce());
  });

  it("starts pending deletion after local teardown and before reset preflight", async () => {
    const user = userEvent.setup();
    const services = createFakeServices();
    const calls: string[] = [];
    const deletion = deferred<void>();
    const camera = services.camera as FakeCamera;
    camera.stop = () => calls.push("camera.stop");
    camera.probe = async () => {
      calls.push("camera.probe");
      return true;
    };
    services.preflight = {
      readStatus: async () => {
        calls.push("preflight");
        return runtimeReadyStatus();
      },
    };
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => calls.push("preview.revoke"));
    services.api.deletePending = vi.fn((id) => {
      calls.push(`delete:${id}`);
      return deletion.promise;
    });
    const delivery = { signal: null as AbortSignal | null };
    const issue = vi.fn(async (input: Parameters<AppServices["delivery"]["issue"]>[0]) => {
      delivery.signal = input.signal;
      input.onPendingSessionCreated?.("pending-before-reset");
      return new Promise<IssuedSession>(() => undefined);
    });
    services.delivery = { issue };
    render(<App services={services} />);

    await startAndReachFrame(user, services);
    await user.click(screen.getByRole("button", { name: "이 프레임으로 사진 만들기" }));
    await waitFor(() => expect(issue).toHaveBeenCalledOnce());
    calls.length = 0;

    await reset(user);

    expect(delivery.signal?.aborted).toBe(true);
    expect(calls).toEqual([
      "camera.stop",
      "preview.revoke",
      "preview.revoke",
      "preview.revoke",
      "preview.revoke",
      "preview.revoke",
      "preview.revoke",
      "delete:pending-before-reset",
    ]);
    expect(screen.getByLabelText("사진 발급")).toBeVisible();

    deletion.resolve();
    expect(await screen.findByRole("button", { name: "촬영 시작" })).toBeVisible();
    expect(calls.slice(-2)).toEqual(["camera.probe", "preflight"]);
  });

  it("completes reset before three seconds while a known pending cleanup hangs", async () => {
    vi.useFakeTimers();
    const services = createFakeServices();
    const deletion = vi.fn(() => new Promise<void>(() => undefined));
    services.api.deletePending = deletion;
    const delivery = deferred<IssuedSession>();
    const issue = vi.fn(async (input: Parameters<AppServices["delivery"]["issue"]>[0]) => {
      input.onPendingSessionCreated?.("pending-before-reset");
      return delivery.promise;
    });
    services.delivery = {
      issue,
    };
    render(<App services={services} />);

    await flushReact();
    fireEvent.click(screen.getByRole("checkbox", { name: "모든 팀원이 촬영에 동의했습니다" }));
    fireEvent.click(screen.getByRole("button", { name: "촬영 시작" }));
    await flushReact();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect((services.camera as FakeCamera).captureCount).toBe(6);
    for (const number of [4, 1, 6, 3]) {
      fireEvent.click(screen.getByAltText(`촬영 사진 ${number}`));
    }
    fireEvent.click(screen.getByRole("button", { name: "프레임 선택하기" }));
    fireEvent.click(screen.getByRole("radio", { name: "기본 프레임" }));
    fireEvent.click(screen.getByRole("button", { name: "이 프레임으로 사진 만들기" }));
    expect(screen.getByLabelText("사진 발급")).toBeVisible();
    await flushReact();
    expect(issue).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "처음으로" }));
    fireEvent.click(screen.getByRole("button", { name: "확인" }));
    expect(screen.getByLabelText("사진 발급")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(screen.getByLabelText("사진 발급")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flushReact();

    expect(screen.getByRole("button", { name: "촬영 시작" })).toBeVisible();
    expect(deletion).toHaveBeenCalledWith("pending-before-reset");
  });

  it("bounds reset when the next camera and readiness checks never settle", async () => {
    vi.useFakeTimers();
    const services = createFakeServices();
    let probeCalls = 0;
    let preflightCalls = 0;
    const camera = new FakeCamera();
    camera.probe = async () => {
      probeCalls += 1;
      if (probeCalls === 1) return true;
      return new Promise<boolean>(() => undefined);
    };
    services.camera = camera;
    services.preflight = {
      readStatus: async () => {
        preflightCalls += 1;
        if (preflightCalls === 1) return runtimeReadyStatus();
        return new Promise<RuntimePreflightStatus>(() => undefined);
      },
    };
    render(<App services={services} />);

    await flushReact();
    expect(screen.getByRole("button", { name: "촬영 시작" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "처음으로" }));
    fireEvent.click(screen.getByRole("button", { name: "확인" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_999);
    });

    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "처음으로",
      "다시 시도",
    ]);
  });

  it("starts a fresh preflight lifecycle when the services object changes", async () => {
    const firstServices = createFakeServices();
    firstServices.preflight = { readStatus: async () => new Promise<RuntimePreflightStatus>(() => undefined) };
    const { rerender } = render(<App services={firstServices} />);
    const replacementServices = createFakeServices();

    rerender(<App services={replacementServices} />);

    expect(await screen.findByRole("button", { name: "촬영 시작" })).toBeVisible();
  });

  it("keeps a stale preflight URL from replacing the validated delivery URL", async () => {
    const user = userEvent.setup();
    const services = createFakeServices();
    const stale = deferred<RuntimePreflightStatus>();
    const fresh = {
      ...runtimeReadyStatus(),
      tunnel: { state: "healthy" as const, publicUrl: "https://fresh.example", latencyMs: 12, error: null },
    };
    let publicUrl: string | null = null;
    let reads = 0;
    services.getPublicUrl = () => publicUrl;
    services.preflight = {
      readStatus: async () => {
        reads += 1;
        if (reads === 1) {
          const result = await stale.promise;
          publicUrl = result.tunnel.publicUrl;
          return result;
        }
        publicUrl = fresh.tunnel.publicUrl;
        return fresh;
      },
    };
    const issue = vi.fn(async (_input: Parameters<AppServices["delivery"]["issue"]>[0]) => issuedSession());
    services.delivery = { issue };
    render(<App services={services} />);

    await reset(user);
    expect(await screen.findByRole("button", { name: "촬영 시작" })).toBeVisible();
    stale.resolve({
      ...runtimeReadyStatus(),
      tunnel: { state: "healthy", publicUrl: "https://stale.example", latencyMs: 12, error: null },
    });
    await act(async () => undefined);

    await startAndReachFrame(user, services);
    await user.click(screen.getByRole("button", { name: "이 프레임으로 사진 만들기" }));
    await waitFor(() => expect(issue).toHaveBeenCalledOnce());
    const [deliveryInput] = issue.mock.calls[0]!;
    expect(deliveryInput.publicBaseUrl).toBe("https://fresh.example");
  });

  it("reissues retained sessions only after a new public URL passes preflight", async () => {
    const user = userEvent.setup();
    const services = createFakeServices();
    const oldStatus = {
      ...runtimeReadyStatus(),
      tunnel: { state: "healthy" as const, publicUrl: "https://old.example", latencyMs: 12, error: null },
    };
    const newStatus = {
      ...runtimeReadyStatus(),
      tunnel: { state: "healthy" as const, publicUrl: "https://new.example", latencyMs: 12, error: null },
    };
    let reads = 0;
    services.preflight = { readStatus: async () => (++reads === 1 ? oldStatus : newStatus) };
    services.registry.add(issuedSession(), "retained-key");
    const reissue = vi.spyOn(services.registry, "reissueAll");
    render(<App services={services} />);

    await screen.findByRole("button", { name: "촬영 시작" });
    await reset(user);

    expect(await screen.findByRole("button", { name: "촬영 시작" })).toBeVisible();
    expect(reissue).toHaveBeenCalledExactlyOnceWith("https://new.example");
  });

  it("polls status every two seconds and replaces the displayed QR after a tunnel URL change", async () => {
    vi.useFakeTimers();
    const services = createFakeServices();
    const oldStatus = runtimeReadyStatus();
    const newStatus = {
      ...runtimeReadyStatus(),
      tunnel: { state: "healthy" as const, publicUrl: "https://new.example", latencyMs: 8, error: null },
    };
    let currentStatus = oldStatus;
    const readStatus = vi.fn(async () => currentStatus);
    services.preflight = { readStatus };
    const reissue = vi.spyOn(services.registry, "reissueAll");
    render(<App services={services} />);

    await flushReact();
    fireEvent.click(screen.getByRole("checkbox", { name: "모든 팀원이 촬영에 동의했습니다" }));
    fireEvent.click(screen.getByRole("button", { name: "촬영 시작" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    for (const number of [4, 1, 6, 3]) fireEvent.click(screen.getByAltText(`촬영 사진 ${number}`));
    fireEvent.click(screen.getByRole("button", { name: "프레임 선택하기" }));
    fireEvent.click(screen.getByRole("radio", { name: "기본 프레임" }));
    fireEvent.click(screen.getByRole("button", { name: "이 프레임으로 사진 만들기" }));
    await flushReact();
    expect(screen.getByLabelText("QR 코드")).toBeVisible();

    currentStatus = newStatus;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_899); });
    expect(readStatus).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await flushReact();

    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(reissue).toHaveBeenCalledWith("https://new.example");
    expect(vi.mocked(toDataURL)).toHaveBeenLastCalledWith(
      "https://new.example/d/public-token#key=kept-out-of-app-state",
      { errorCorrectionLevel: "M" },
    );
  });

  it("reissues after activation when the tunnel URL changed while delivery was in flight", async () => {
    vi.useFakeTimers();
    const services = createFakeServices();
    const activation = deferred<IssuedSession>();
    let currentStatus = runtimeReadyStatus();
    services.preflight = { readStatus: vi.fn(async () => currentStatus) };
    services.delivery = {
      issue: vi.fn(async () => {
        const issued = await activation.promise;
        services.registry.add(issued, "kept-out-of-app-state");
        return issued;
      }),
    };
    render(<App services={services} />);

    await flushReact();
    fireEvent.click(screen.getByRole("checkbox", { name: "모든 팀원이 촬영에 동의했습니다" }));
    fireEvent.click(screen.getByRole("button", { name: "촬영 시작" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    for (const number of [4, 1, 6, 3]) fireEvent.click(screen.getByAltText(`촬영 사진 ${number}`));
    fireEvent.click(screen.getByRole("button", { name: "프레임 선택하기" }));
    fireEvent.click(screen.getByRole("radio", { name: "기본 프레임" }));
    fireEvent.click(screen.getByRole("button", { name: "이 프레임으로 사진 만들기" }));
    await flushReact();

    currentStatus = {
      ...runtimeReadyStatus(),
      tunnel: { state: "healthy", publicUrl: "https://during-delivery.example", latencyMs: 9, error: null },
    };
    await act(async () => { await vi.advanceTimersByTimeAsync(1_900); });
    activation.resolve(issuedSession());
    await flushReact();

    expect(screen.getByLabelText("QR 코드")).toBeVisible();
    expect(vi.mocked(toDataURL)).toHaveBeenLastCalledWith(
      "https://during-delivery.example/d/public-token#key=kept-out-of-app-state",
      { errorCorrectionLevel: "M" },
    );
  });
});

class BlockingCamera implements CameraPort {
  captureStarted = 0;
  photo = deferred<Blob>();

  async probe(): Promise<boolean> {
    return true;
  }

  async start(_video: HTMLVideoElement): Promise<void> {}

  async capture(): Promise<Blob> {
    this.captureStarted += 1;
    return this.photo.promise;
  }

  stop(): void {}
}

async function startExperience(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByRole("button", { name: "촬영 시작" });
  await user.click(screen.getByRole("checkbox", { name: "모든 팀원이 촬영에 동의했습니다" }));
  await user.click(screen.getByRole("button", { name: "촬영 시작" }));
}

async function startAndReachFrame(user: ReturnType<typeof userEvent.setup>, services: AppServices): Promise<void> {
  await startExperience(user);
  await (services.camera as FakeCamera).finishSixShots();
  for (const number of [4, 1, 6, 3]) {
    await user.click(screen.getByAltText(`촬영 사진 ${number}`));
  }
  await user.click(screen.getByRole("button", { name: "프레임 선택하기" }));
  await user.click(screen.getByRole("radio", { name: "기본 프레임" }));
}

async function reset(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "처음으로" }));
  await user.click(screen.getByRole("button", { name: "확인" }));
}

function runtimeReadyStatus(): RuntimePreflightStatus {
  return {
    acceptingCaptures: true,
    tunnel: { state: "healthy", publicUrl: "https://booth.example", latencyMs: 12, error: null },
    lastSuccessfulSweepAt: Date.now(),
    activeCiphertextCount: 0,
  };
}

function issuedSession(): IssuedSession {
  return {
    id: "issued-session",
    publicToken: "public-token",
    deliveryUrl: "https://booth.example/d/public-token#key=kept-out-of-app-state",
    expiresAt: Date.now() + 600_000,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
