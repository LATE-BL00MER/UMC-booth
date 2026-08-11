import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
  it("shows the live preview, first prompt, progress, and initial countdown without local navigation", async () => {
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

    expect(await screen.findByText("pose 1")).toBeVisible();
    expect(screen.getByText("1 / 6")).toBeVisible();
    expect(screen.getByText("5")).toBeVisible();
    expect(screen.getByLabelText("카메라 미리보기")).toBe(camera.video);
    expect(document.querySelector(".capture-viewport")).toHaveStyle({ "--capture-aspect-ratio": String(7 / 9) });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    controller.abort();
  });
});
