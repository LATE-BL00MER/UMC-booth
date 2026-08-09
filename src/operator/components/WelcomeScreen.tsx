import { useState } from "react";

export interface WelcomeScreenProps {
  onStart(): void;
}

export function WelcomeScreen({ onStart }: WelcomeScreenProps) {
  const [hasConsent, setHasConsent] = useState(false);

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
      <button type="button" disabled={!hasConsent} onClick={onStart}>
        체험 시작
      </button>
    </section>
  );
}
