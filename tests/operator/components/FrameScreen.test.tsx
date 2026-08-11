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
        compositor={{ compose: vi.fn() }}
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
        compositor={{ compose: vi.fn(async () => new Blob(["preview"], { type: "image/jpeg" })) }}
        onFrameSelect={onFrameSelect}
        onContinue={onContinue}
      />,
    );
    expect(continueButton).toBeEnabled();
    await user.click(continueButton);
    expect(onContinue).toHaveBeenCalledExactlyOnceWith("basic");
  });

  it("does not confirm an ID that is not one of the displayed frames", () => {
    render(
      <FrameScreen
        photos={photos}
        selectedIds={["p1", "p2", "p3", "p4"]}
        frames={frames}
        selectedFrameId="missing"
        compositor={{ compose: vi.fn() }}
        onFrameSelect={() => undefined}
        onContinue={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "이 프레임으로 사진 만들기" })).toBeDisabled();
  });

  it("composes the selected four photos in selection order and disposes a replaced preview", async () => {
    const user = userEvent.setup();
    const compose = vi.fn(async (_input: { photos: readonly Blob[]; frame: FrameManifest }) => new Blob(["preview"], { type: "image/jpeg" }));
    const createObjectURL = vi.fn(() => "blob:composed-preview");
    const revokeObjectURL = vi.fn();
    const { rerender, unmount } = render(
      <FrameScreen
        photos={photos}
        selectedIds={["p4", "p1", "p3", "p2"]}
        frames={frames}
        selectedFrameId={null}
        compositor={{ compose }}
        createObjectURL={createObjectURL}
        revokeObjectURL={revokeObjectURL}
        onFrameSelect={() => undefined}
        onContinue={() => undefined}
      />,
    );

    rerender(
      <FrameScreen
        photos={photos}
        selectedIds={["p4", "p1", "p3", "p2"]}
        frames={frames}
        selectedFrameId="basic"
        compositor={{ compose }}
        createObjectURL={createObjectURL}
        revokeObjectURL={revokeObjectURL}
        onFrameSelect={() => undefined}
        onContinue={() => undefined}
      />,
    );
    expect(await screen.findByAltText("선택한 프레임 합성 미리보기")).toHaveAttribute("src", "blob:composed-preview");
    expect(screen.queryByLabelText("선택한 사진")).not.toBeInTheDocument();
    expect((await compose.mock.results[0]!.value).type).toBe("image/jpeg");
    const [input] = compose.mock.calls[0]!;
    expect(await Promise.all(input.photos.map((photo) => photo.text()))).toEqual(["photo 4", "photo 1", "photo 3", "photo 2"]);

    await user.click(screen.getByRole("radio", { name: "밝은 프레임" }));
    rerender(
      <FrameScreen
        photos={photos}
        selectedIds={["p4", "p1", "p3", "p2"]}
        frames={frames}
        selectedFrameId="bright"
        compositor={{ compose }}
        createObjectURL={createObjectURL}
        revokeObjectURL={revokeObjectURL}
        onFrameSelect={() => undefined}
        onContinue={() => undefined}
      />,
    );
    await screen.findByAltText("선택한 프레임 합성 미리보기");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:composed-preview");
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("clears the prior preview and reports a safe state when replacement composition fails", async () => {
    let calls = 0;
    const compose = vi.fn(async (_input: { photos: readonly Blob[]; frame: FrameManifest }) => {
      calls += 1;
      if (calls === 1) return new Blob(["preview"], { type: "image/jpeg" });
      throw new Error("overlay unavailable");
    });
    const createObjectURL = vi.fn(() => "blob:first-preview");
    const revokeObjectURL = vi.fn();
    const { rerender } = render(
      <FrameScreen
        photos={photos}
        selectedIds={["p1", "p2", "p3", "p4"]}
        frames={frames}
        selectedFrameId="basic"
        compositor={{ compose }}
        createObjectURL={createObjectURL}
        revokeObjectURL={revokeObjectURL}
        onFrameSelect={() => undefined}
        onContinue={() => undefined}
      />,
    );
    await screen.findByAltText("선택한 프레임 합성 미리보기");

    rerender(
      <FrameScreen
        photos={photos}
        selectedIds={["p1", "p2", "p3", "p4"]}
        frames={frames}
        selectedFrameId="bright"
        compositor={{ compose }}
        createObjectURL={createObjectURL}
        revokeObjectURL={revokeObjectURL}
        onFrameSelect={() => undefined}
        onContinue={() => undefined}
      />,
    );
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first-preview");
    expect(screen.queryByAltText("선택한 프레임 합성 미리보기")).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("미리보기를 만들지 못했습니다");
  });
});
