import { useEffect, useState } from "react";
import { toDataURL } from "qrcode";

import type { IssuedSession } from "../../shared/contracts.js";

export interface QrScreenProps {
  issued: IssuedSession;
  exposeDeliveryUrl?: boolean;
}

export function QrScreen({ issued, exposeDeliveryUrl = false }: QrScreenProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);
  const [renderAttempt, setRenderAttempt] = useState(0);
  const [remaining, setRemaining] = useState(() => remainingMilliseconds(issued.expiresAt));

  useEffect(() => {
    let cancelled = false;
    setQrDataUrl(null);
    setQrError(false);
    void toDataURL(issued.deliveryUrl, { errorCorrectionLevel: "M" })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [issued.deliveryUrl, renderAttempt]);

  useEffect(() => {
    setRemaining(remainingMilliseconds(issued.expiresAt));
    const timer = setInterval(() => setRemaining(remainingMilliseconds(issued.expiresAt)), 1_000);
    return () => clearInterval(timer);
  }, [issued.expiresAt]);

  return (
    <section className="qr-screen" aria-label="QR 코드">
      <div className="qr-copy">
        <p className="eyebrow">TAKE IT WITH YOU</p>
        <h1>QR을 스캔해 사진을 받아가세요</h1>
        <p className="qr-instruction">팀원 모두 각자 스캔할 수 있습니다</p>
      </div>
      <div className="qr-card">
        {qrError ? (
          <div className="inline-alert" role="alert">
            <p>QR 코드를 만들지 못했습니다</p>
            <button className="button button--primary button--small" type="button" onClick={() => setRenderAttempt((attempt) => attempt + 1)}>
              다시 시도
            </button>
          </div>
        ) : qrDataUrl === null ? (
          <p className="loading-copy" aria-live="polite">QR 코드를 만드는 중입니다</p>
        ) : (
          <img className="qr-image" src={qrDataUrl} alt="사진 받기 QR 코드" />
        )}
      </div>
      {exposeDeliveryUrl ? <span data-testid="delivery-url" data-url={issued.deliveryUrl} hidden /> : null}
      <output className="qr-timer" data-tone={timerTone(remaining)} aria-live="polite">
        {formatRemaining(remaining)}
      </output>
      <p className="qr-privacy">사진은 10분 후 자동으로 삭제됩니다</p>
    </section>
  );
}

function remainingMilliseconds(expiresAt: number): number {
  return Math.max(0, expiresAt - Date.now());
}

function formatRemaining(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function timerTone(milliseconds: number): "neutral" | "warning" | "danger" {
  if (milliseconds <= 30_000) return "danger";
  if (milliseconds <= 120_000) return "warning";
  return "neutral";
}
