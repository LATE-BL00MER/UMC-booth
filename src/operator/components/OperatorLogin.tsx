import { FormEvent, useState } from "react";

import { BrandMark } from "./BrandMark.js";

export interface OperatorLoginProps {
  authenticate(pin: string): Promise<string>;
  onAuthenticated(operatorKey: string): void;
}

export function OperatorLogin({ authenticate, onAuthenticated }: OperatorLoginProps) {
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!/^\d{4}$/.test(pin) || submitting) return;
    setSubmitting(true);
    setFailed(false);
    try {
      onAuthenticated(await authenticate(pin));
    } catch {
      setFailed(true);
      setSubmitting(false);
    }
  }

  return (
    <main className="boot-screen">
      <section className="boot-screen__panel glass-panel" aria-label="운영자 로그인">
        <BrandMark />
        <h1>운영자 PIN을 입력해 주세요</h1>
        <p>사진부스 담당자만 운영 화면을 시작할 수 있습니다</p>
        <form className="operator-login" onSubmit={(event) => void submit(event)}>
          <label htmlFor="operator-pin">운영자 PIN</label>
          <input
            id="operator-pin"
            type="password"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={4}
            value={pin}
            onChange={(event) => {
              setPin(event.target.value.replace(/\D/g, "").slice(0, 4));
              setFailed(false);
            }}
            autoFocus
          />
          {failed ? <p className="operator-login__error" role="alert">PIN이 올바르지 않습니다</p> : null}
          <button className="button button--primary" type="submit" disabled={pin.length !== 4 || submitting}>
            {submitting ? "확인 중" : "운영 화면 열기"}
          </button>
        </form>
      </section>
    </main>
  );
}
