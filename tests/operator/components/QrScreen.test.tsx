import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { toDataURL } = vi.hoisted(() => ({
  toDataURL: vi.fn(async () => "data:image/png;base64,qr-code"),
}));

vi.mock("qrcode", () => ({ toDataURL }));

import { QrScreen } from "../../../src/operator/components/QrScreen.js";
import type { IssuedSession } from "../../../src/shared/contracts.js";

const issued: IssuedSession = {
  id: "session-1",
  publicToken: "public-token",
  deliveryUrl: "https://booth.example/d/public-token#key=secret-fragment",
  expiresAt: 1_800_000_060_000,
};

describe("QrScreen", () => {
  afterEach(() => {
    vi.useRealTimers();
    toDataURL.mockReset();
    toDataURL.mockResolvedValue("data:image/png;base64,qr-code");
  });

  it("renders a medium-correction QR image, remaining time, and multi-device guidance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_800_000_000_000));
    render(<QrScreen issued={issued} />);
    await act(async () => undefined);

    expect(screen.getByRole("img", { name: "사진 받기 QR 코드" })).toHaveAttribute(
      "src",
      "data:image/png;base64,qr-code",
    );
    expect(toDataURL).toHaveBeenCalledWith(issued.deliveryUrl, { errorCorrectionLevel: "M" });
    expect(screen.getByText("01:00")).toBeVisible();
    expect(screen.getByText("팀원 모두 각자 스캔할 수 있습니다")).toBeVisible();
    expect(screen.getByText("QR은 10분 동안 이용할 수 있으며, 만료 후 암호화된 사진은 자동 삭제됩니다")).toBeVisible();
  });

  it("keeps the delivery URL out of the production QR screen", async () => {
    render(<QrScreen issued={issued} />);
    await act(async () => undefined);

    expect(screen.queryByTestId("delivery-url")).not.toBeInTheDocument();
  });

  it("counts down to zero", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_800_000_059_000));
    render(<QrScreen issued={issued} />);

    expect(screen.getByText("00:01")).toBeVisible();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText("00:00")).toBeVisible();
  });

  it("shows a recoverable error and retries QR rendering without reissuing the session", async () => {
    const user = userEvent.setup();
    toDataURL
      .mockRejectedValueOnce(new Error("QR rendering failed"))
      .mockResolvedValueOnce("data:image/png;base64,retried-qr-code");

    render(<QrScreen issued={issued} />);
    await act(async () => undefined);

    expect(screen.getByText("QR 코드를 만들지 못했습니다")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "다시 시도" }));

    expect(await screen.findByRole("img", { name: "사진 받기 QR 코드" })).toHaveAttribute(
      "src",
      "data:image/png;base64,retried-qr-code",
    );
    expect(toDataURL).toHaveBeenNthCalledWith(1, issued.deliveryUrl, { errorCorrectionLevel: "M" });
    expect(toDataURL).toHaveBeenNthCalledWith(2, issued.deliveryUrl, { errorCorrectionLevel: "M" });
  });

  it("absorbs a stale QR rendering rejection after the active QR render changes", async () => {
    let rejectRendering!: (reason?: unknown) => void;
    toDataURL
      .mockImplementationOnce(
        () => new Promise<string>((_resolve, reject) => {
          rejectRendering = reject;
        }),
      )
      .mockResolvedValueOnce("data:image/png;base64,current-qr-code");

    const { rerender } = render(<QrScreen issued={issued} />);
    await act(async () => undefined);
    rerender(
      <QrScreen
        issued={{
          ...issued,
          deliveryUrl: "https://new-booth.example/d/public-token#key=secret-fragment",
        }}
      />,
    );
    expect(await screen.findByRole("img", { name: "사진 받기 QR 코드" })).toHaveAttribute(
      "src",
      "data:image/png;base64,current-qr-code",
    );
    await act(async () => {
      rejectRendering(new Error("late QR failure"));
      await Promise.resolve();
    });

    expect(screen.getByRole("img", { name: "사진 받기 QR 코드" })).toHaveAttribute(
      "src",
      "data:image/png;base64,current-qr-code",
    );
  });
});
