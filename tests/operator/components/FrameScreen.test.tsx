import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CapturedPhoto } from "../../../src/operator/booth-machine.js";
import { FrameScreen } from "../../../src/operator/components/FrameScreen.js";
import type { FrameManifest } from "../../../src/operator/frames/frame-contract.js";

const photos: CapturedPhoto[] = Array.from({ length: 4 }, (_, index) => ({
  id: `p${index + 1}`,
  blob: new Blob([`photo ${index + 1}`], { type: "image/jpeg" }),
  previewUrl: `blob:photo-${index + 1}`,
}));

const frames: FrameManifest[] = [
  {
    id: "basic",
    label: "기본 프레임",
    canvas: { width: 100, height: 100 },
    jpegQuality: 0.9,
    thumbnail: "/basic-thumb.png",
    overlay: "/basic-overlay.svg",
    slots: Array.from({ length: 4 }, (_, index) => ({
      x: index,
      y: index,
      width: 10,
      height: 10,
      rotation: 0,
      fit: "cover" as const,
    })) as FrameManifest["slots"],
  },
  {
    id: "bright",
    label: "밝은 프레임",
    canvas: { width: 100, height: 100 },
    jpegQuality: 0.9,
    thumbnail: "/bright-thumb.png",
    overlay: "/bright-overlay.svg",
    slots: Array.from({ length: 4 }, (_, index) => ({
      x: index,
      y: index,
      width: 10,
      height: 10,
      rotation: 0,
      fit: "cover" as const,
    })) as FrameManifest["slots"],
  },
];

describe("FrameScreen", () => {
  it("shows every frame preview and only confirms after one is selected", async () => {
    const user = userEvent.setup();
    const onFrameSelect = vi.fn();
    const onContinue = vi.fn();
    const { rerender } = render(
      <FrameScreen
        photos={photos}
        selectedIds={["p4", "p1", "p3", "p2"]}
        frames={frames}
        selectedFrameId={null}
        onFrameSelect={onFrameSelect}
        onContinue={onContinue}
      />,
    );

    const continueButton = screen.getByRole("button", { name: "이 프레임으로 사진 만들기" });
    expect(continueButton).toBeDisabled();
    expect(screen.getByAltText("기본 프레임 미리보기")).toHaveAttribute("src", "/basic-thumb.png");
    expect(screen.getByAltText("밝은 프레임 미리보기")).toHaveAttribute("src", "/bright-thumb.png");
    expect(screen.getAllByAltText(/^선택한 사진/).map((photo) => photo.getAttribute("src"))).toEqual([
      "blob:photo-4",
      "blob:photo-1",
      "blob:photo-3",
      "blob:photo-2",
    ]);

    await user.click(screen.getByRole("radio", { name: "기본 프레임" }));
    expect(onFrameSelect).toHaveBeenCalledWith("basic");

    rerender(
      <FrameScreen
        photos={photos}
        selectedIds={["p4", "p1", "p3", "p2"]}
        frames={frames}
        selectedFrameId="basic"
        onFrameSelect={onFrameSelect}
        onContinue={onContinue}
      />,
    );
    expect(continueButton).toBeEnabled();
    await user.click(continueButton);
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("does not confirm an ID that is not one of the displayed frames", () => {
    render(
      <FrameScreen
        photos={photos}
        selectedIds={["p1", "p2", "p3", "p4"]}
        frames={frames}
        selectedFrameId="missing"
        onFrameSelect={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "이 프레임으로 사진 만들기" })).toBeDisabled();
  });
});
