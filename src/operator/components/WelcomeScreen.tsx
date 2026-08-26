import { useState } from "react";
import type { IssuedSession } from "../../shared/contracts.js";
import { activeSessionTtlMinutes } from "../../shared/session-policy.js";

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
        <p className="eyebrow">UMCism</p>
        <h1>
          <span>우리의 순간을</span>
          <span>네컷으로.</span>
        </h1>
        <p className="welcome-lead">UNIVERSITY MAKEUS CHALLENGE</p>
      </div>
      <div className="welcome-side">
        <div className="welcome-consent glass-panel">
          <p className="privacy-note">
            QR은 발급 후 {activeSessionTtlMinutes}분 동안 이용할 수 있으며, 만료 후 암호화된 사진은 자동 삭제됩니다
          </p>
          <label className="consent-control">
            <input
              type="checkbox"
              checked={hasConsent}
              onChange={(event) => setHasConsent(event.target.checked)}
            />
            <span>모든 팀원이 촬영에 동의했습니다</span>
          </label>
          <button className="button button--primary" type="button" disabled={!hasConsent || !acceptingCaptures} onClick={onStart}>
            촬영 시작
          </button>
        </div>
        <div className="welcome-previous" aria-label="이전 QR 다시 보기">
          {issuedSessions.length > 1 ? (
            <select className="select-control" aria-label="이전 QR 선택" value={selectedIssuedId} onChange={(event) => setSelectedIssuedId(event.target.value)}>
              {issuedSessions.map((issued, index) => <option key={issued.id} value={issued.id}>발급 QR {index + 1}</option>)}
            </select>
          ) : null}
          <button
            className="button button--secondary welcome-previous__button"
            type="button"
            disabled={!acceptingCaptures || !selectedIssuedId || !onRedisplay}
            onClick={() => onRedisplay?.(selectedIssuedId)}
          >
            이전 QR 다시 보기
          </button>
        </div>
      </div>
    </section>
  );
}
