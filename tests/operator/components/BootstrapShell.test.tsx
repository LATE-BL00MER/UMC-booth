import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BootstrapShell } from "../../../src/operator/components/BootstrapShell.js";

describe("BootstrapShell", () => {
  it("keeps the reset confirmation available during boot failure and safely retries loading", async () => {
    const user = userEvent.setup();
    const firstLoad = deferred<{ version: string }>();
    const secondLoad = deferred<{ version: string }>();
    const load = vi.fn()
      .mockReturnValueOnce(firstLoad.promise)
      .mockReturnValueOnce(secondLoad.promise);
    const onReady = vi.fn();
    render(<BootstrapShell load={load} onReady={onReady} />);

    expect(screen.getByLabelText("운영 화면 준비")).toBeVisible();
    expect(screen.getByRole("button", { name: "처음으로" })).toBeVisible();
    firstLoad.reject(new Error("asset load failed"));
    await act(async () => undefined);

    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "다시 시도",
      "처음으로",
    ]);
    await user.click(screen.getByRole("button", { name: "처음으로" }));
    await user.click(screen.getByRole("button", { name: "확인" }));
    expect(screen.getByText("운영 화면을 준비하는 중입니다")).toBeVisible();

    secondLoad.resolve({ version: "fresh" });
    await act(async () => undefined);
    expect(onReady).toHaveBeenCalledExactlyOnceWith({ version: "fresh" });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
