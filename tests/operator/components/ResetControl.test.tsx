import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ResetControl } from "../../../src/operator/components/ResetControl.js";

describe("ResetControl", () => {
  it("renders the reset trigger in the shell control container", () => {
    render(<ResetControl onConfirm={() => undefined} />);

    const container = screen.getByRole("button", { name: "처음으로" }).parentElement;
    expect(container).toHaveClass("reset-control");
  });

  it("renders only the approved reset question and buttons", async () => {
    const user = userEvent.setup();
    render(<ResetControl onConfirm={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "처음으로" }));

    expect(screen.getByText("처음 화면으로 돌아갈까요?")).toBeVisible();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "처음으로",
      "취소",
      "확인",
    ]);
    expect(screen.queryByText(/삭제|되돌릴 수/)).not.toBeInTheDocument();
  });

  it("focuses the dialog and returns focus to reset when cancelled with Escape", async () => {
    const user = userEvent.setup();
    render(<ResetControl onConfirm={() => undefined} />);

    const resetButton = screen.getByRole("button", { name: "처음으로" });
    await user.click(resetButton);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(resetButton).toHaveFocus();
  });

  it("closes and confirms once", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ResetControl onConfirm={onConfirm} />);

    await user.click(screen.getByRole("button", { name: "처음으로" }));
    await user.click(screen.getByRole("button", { name: "확인" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
