import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { OperatorShell } from "../../../src/operator/components/OperatorShell.js";

describe("OperatorShell", () => {
  it("places the back button immediately after QR and invokes it", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(
      <OperatorShell phase="framing" status={null} onBack={onBack} onReset={() => undefined}>
        <div>frame screen</div>
      </OperatorShell>,
    );

    const navigation = screen.getByRole("navigation", { name: "체험 진행 단계" });
    expect(Array.from(navigation.children).map((item) => item.textContent)).toEqual([
      "촬영",
      "사진 선택",
      "프레임",
      "QR",
      "이전",
    ]);

    await user.click(within(navigation).getByRole("button", { name: "이전" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("does not offer backward navigation after QR delivery is complete", () => {
    render(
      <OperatorShell phase="qr" status={null} onBack={() => undefined} onReset={() => undefined}>
        <div>QR screen</div>
      </OperatorShell>,
    );

    expect(screen.queryByRole("button", { name: "이전" })).not.toBeInTheDocument();
  });
});
