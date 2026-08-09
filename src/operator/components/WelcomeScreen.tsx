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
    <section aria-label="시작 안내">
      <p>사진은 암호화되어 QR 발급 10분 후 삭제됩니다</p>
      <label>
        <input
          type="checkbox"
          checked={hasConsent}
          onChange={(event) => setHasConsent(event.target.checked)}
        />
        모든 팀원이 촬영에 동의했습니다
      </label>
      <button type="button" disabled={!hasConsent || !acceptingCaptures} onClick={onStart}>
        체험 시작
      </button>
      {issuedSessions.length > 0 && onRedisplay ? (
        <div aria-label="이전 QR 재표시">
          <select aria-label="이전 QR 선택" value={selectedIssuedId} onChange={(event) => setSelectedIssuedId(event.target.value)}>
            {issuedSessions.map((issued, index) => <option key={issued.id} value={issued.id}>발급 QR {index + 1}</option>)}
          </select>
          <button type="button" disabled={!acceptingCaptures || !selectedIssuedId} onClick={() => onRedisplay(selectedIssuedId)}>
            이전 QR 다시 표시
          </button>
        </div>
      ) : null}
    </section>
  );
}
