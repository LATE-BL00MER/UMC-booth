import { act, render, screen } from "@testing-library/react";
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
    toDataURL.mockClear();
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
  });

  it("counts down to zero", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_800_000_059_000));
    render(<QrScreen issued={issued} />);

    expect(screen.getByText("00:01")).toBeVisible();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText("00:00")).toBeVisible();
  });
});
