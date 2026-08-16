import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { OperatorLogin } from "../../../src/operator/components/OperatorLogin.js";

describe("OperatorLogin", () => {
  it("accepts a four digit PIN and opens the operator screen with the returned key", async () => {
    const user = userEvent.setup();
    const authenticate = vi.fn(async () => "a".repeat(48));
    const onAuthenticated = vi.fn();
    render(<OperatorLogin authenticate={authenticate} onAuthenticated={onAuthenticated} />);

    await user.type(screen.getByLabelText("운영자 PIN"), "12a345");
    expect(screen.getByLabelText("운영자 PIN")).toHaveValue("1234");
    await user.click(screen.getByRole("button", { name: "운영 화면 열기" }));

    expect(authenticate).toHaveBeenCalledExactlyOnceWith("1234");
    expect(onAuthenticated).toHaveBeenCalledExactlyOnceWith("a".repeat(48));
  });

  it("keeps the form available and shows a safe error when authentication fails", async () => {
    const user = userEvent.setup();
    render(
      <OperatorLogin
        authenticate={vi.fn(async () => { throw new Error("rejected"); })}
        onAuthenticated={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("운영자 PIN"), "8765");
    await user.click(screen.getByRole("button", { name: "운영 화면 열기" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("PIN이 올바르지 않습니다");
    expect(screen.getByRole("button", { name: "운영 화면 열기" })).toBeEnabled();
  });
});
