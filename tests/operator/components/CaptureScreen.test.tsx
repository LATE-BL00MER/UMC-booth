import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CameraPort } from "../../../src/operator/camera/camera-port.js";
import { CaptureScreen } from "../../../src/operator/components/CaptureScreen.js";

const prompts: [string, string, string, string, string, string] = [
  "pose 1",
  "pose 2",
  "pose 3",
  "pose 4",
  "pose 5",
  "pose 6",
];

class PreviewCamera implements CameraPort {
  video: HTMLVideoElement | null = null;

  async probe(): Promise<boolean> {
    return true;
  }

  async start(video: HTMLVideoElement): Promise<void> {
    this.video = video;
  }

  async capture(): Promise<Blob> {
    return new Blob(["photo"], { type: "image/jpeg" });
  }

  stop(): void {}
}

describe("CaptureScreen", () => {
  it("shows the live preview, progress, and initial countdown without a pose prompt or local navigation", async () => {
    const camera = new PreviewCamera();
    const controller = new AbortController();

    render(
      <CaptureScreen
        camera={camera}
        captureAspectRatio={7 / 9}
        prompts={prompts}
        generation={7}
        signal={controller.signal}
        tickMs={10}
        sleep={() => new Promise(() => undefined)}
        onPhotoCaptured={() => undefined}
      />,
    );

    expect(await screen.findByText("5")).toBeVisible();
    expect(screen.queryByText("pose 1")).not.toBeInTheDocument();
    expect(screen.getByText("1 / 6")).toBeVisible();
    expect(screen.getByLabelText("카메라 미리보기")).toBe(camera.video);
    expect(document.querySelector(".capture-viewport")).toHaveStyle({ "--capture-aspect-ratio": String(7 / 9) });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    controller.abort();
  });

  it("plays the shutter sound and pulses the frame as soon as a photo is taken", async () => {
    const playCaptureSound = vi.fn();
    let releaseCountdown: (() => void) | undefined;
    let sleepCount = 0;
    const sleep = vi.fn(() => {
      sleepCount += 1;
      if (sleepCount < 5) return Promise.resolve();
      if (sleepCount === 5) return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseCountdown = resolve;
      });
    });

    const { unmount } = render(
      <CaptureScreen
        camera={new PreviewCamera()}
        captureAspectRatio={7 / 9}
        prompts={prompts}
        generation={1}
        signal={new AbortController().signal}
        tickMs={10}
        sleep={sleep}
        playCaptureSound={playCaptureSound}
        onPhotoCaptured={() => undefined}
      />,
    );

    await waitFor(() => expect(playCaptureSound).toHaveBeenCalledOnce());
    expect(document.querySelector(".capture-viewport")).toHaveAttribute("data-capture-pulse", "true");

    unmount();
    releaseCountdown?.();
  });
});
