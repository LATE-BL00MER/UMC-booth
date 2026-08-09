import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { CapturedPhoto } from "../../../src/operator/booth-machine.js";
import { SelectionScreen } from "../../../src/operator/components/SelectionScreen.js";

const sixPhotos: CapturedPhoto[] = Array.from({ length: 6 }, (_, index) => ({
  id: `p${index + 1}`,
  blob: new Blob([`photo ${index + 1}`], { type: "image/jpeg" }),
  previewUrl: `blob:photo-${index + 1}`,
}));

function SelectionHarness({ onToggle = vi.fn() }: { onToggle?: (id: string) => void }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const toggle = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((selectedId) => selectedId !== id)
        : current.length < 4
          ? [...current, id]
          : current,
    );
    onToggle(id);
  };

  return (
    <SelectionScreen
      photos={sixPhotos}
      selectedIds={selectedIds}
      onToggle={toggle}
      onClear={() => setSelectedIds([])}
      onContinue={() => undefined}
    />
  );
}

describe("SelectionScreen", () => {
  it("enables continuation only after four ordered selections", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<SelectionHarness onToggle={onToggle} />);

    const continueButton = screen.getByRole("button", { name: "프레임 선택하기" });
    expect(continueButton).toBeDisabled();

    await user.click(screen.getByAltText("촬영 사진 4"));
    await user.click(screen.getByAltText("촬영 사진 1"));
    await user.click(screen.getByAltText("촬영 사진 6"));
    expect(continueButton).toBeDisabled();
    await user.click(screen.getByAltText("촬영 사진 3"));

    expect(onToggle.mock.calls.map(([id]) => id)).toEqual(["p4", "p1", "p6", "p3"]);
    expect(continueButton).toBeEnabled();
    expect(screen.getByText("1")).toBeVisible();
    expect(screen.getByText("2")).toBeVisible();
    expect(screen.getByText("3")).toBeVisible();
    expect(screen.getByText("4")).toBeVisible();
  });

  it("does not request a fifth selection and lets keyboard users clear selections", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<SelectionHarness onToggle={onToggle} />);

    for (const photoNumber of [1, 2, 3, 4]) {
      await user.click(screen.getByAltText(`촬영 사진 ${photoNumber}`));
    }
    await user.click(screen.getByAltText("촬영 사진 5"));
    expect(onToggle.mock.calls.map(([id]) => id)).toEqual(["p1", "p2", "p3", "p4"]);

    screen.getByRole("button", { name: "촬영 사진 2" }).focus();
    await user.keyboard("{Enter}");
    expect(onToggle.mock.calls.map(([id]) => id)).toEqual(["p1", "p2", "p3", "p4", "p2"]);

    await user.click(screen.getByRole("button", { name: "선택 초기화" }));
    expect(screen.getByRole("button", { name: "프레임 선택하기" })).toBeDisabled();
  });
});
