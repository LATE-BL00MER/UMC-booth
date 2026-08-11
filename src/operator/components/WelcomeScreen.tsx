import { useState } from "react";
import type { IssuedSession } from "../../shared/contracts.js";

export interface WelcomeScreenProps {
  onStart(): void;
  acceptingCaptures: boolean;
  issuedSessions?: readonly IssuedSession[];
  onRedisplay?(id: string): void;
}

export function WelcomeScreen({ onStart, acceptingCaptures, issuedSessions = [], onRedisplay }: WelcomeScreenProps) {
  const [hasConsent, setHasConsent] = useState(false);
  const [selectedIssuedId, setSelectedIssuedId] = useState(issuedSessions[0]?.id ?? "");

  return (
    <section className="welcome-screen" aria-label="시작 안내">
      <div className="welcome-hero">
        <p className="eyebrow">UNIVERSITY MAKEUS CHALLENGE</p>
        <h1>
          <span>우리의 순간을</span>
          <span>네컷으로.</span>
        </h1>
        <p className="welcome-lead">UMC와 함께 만들어 가는 순간</p>
      </div>
      <div className="welcome-consent glass-panel">
        <p className="privacy-note">사진은 암호화되어 QR 발급 5분 후 삭제됩니다</p>
        <label className="consent-control">
          <input
            type="checkbox"
            checked={hasConsent}
            onChange={(event) => setHasConsent(event.target.checked)}
          />
          <span>모든 팀원이 촬영에 동의했습니다</span>
        </label>
        <button className="button button--primary" type="button" disabled={!hasConsent || !acceptingCaptures} onClick={onStart}>
          체험 시작
        </button>
        {issuedSessions.length > 0 && onRedisplay ? (
          <div className="welcome-previous" aria-label="이전 QR 재표시">
            <select className="select-control" aria-label="이전 QR 선택" value={selectedIssuedId} onChange={(event) => setSelectedIssuedId(event.target.value)}>
              {issuedSessions.map((issued, index) => <option key={issued.id} value={issued.id}>발급 QR {index + 1}</option>)}
            </select>
            <button className="button button--secondary button--small" type="button" disabled={!acceptingCaptures || !selectedIssuedId} onClick={() => onRedisplay(selectedIssuedId)}>
              이전 QR 다시 표시
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
