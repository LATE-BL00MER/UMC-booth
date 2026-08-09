import { useEffect, useState } from "react";
import { toDataURL } from "qrcode";

import type { IssuedSession } from "../../shared/contracts.js";

export interface QrScreenProps {
  issued: IssuedSession;
}

export function QrScreen({ issued }: QrScreenProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(() => remainingMilliseconds(issued.expiresAt));

  useEffect(() => {
    let cancelled = false;
    setQrDataUrl(null);
    void toDataURL(issued.deliveryUrl, { errorCorrectionLevel: "M" }).then((dataUrl) => {
      if (!cancelled) setQrDataUrl(dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [issued.deliveryUrl]);

  useEffect(() => {
    setRemaining(remainingMilliseconds(issued.expiresAt));
    const timer = setInterval(() => setRemaining(remainingMilliseconds(issued.expiresAt)), 1_000);
    return () => clearInterval(timer);
  }, [issued.expiresAt]);

  return (
    <section aria-label="QR 코드">
      {qrDataUrl === null ? (
        <p aria-live="polite">QR 코드를 만드는 중입니다</p>
      ) : (
        <img src={qrDataUrl} alt="사진 받기 QR 코드" />
      )}
      <output aria-live="polite">{formatRemaining(remaining)}</output>
      <p>팀원 모두 각자 스캔할 수 있습니다</p>
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
