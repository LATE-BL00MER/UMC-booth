import { useCallback, useEffect, useRef, useState } from "react";

import { BrandMark } from "./BrandMark.js";
import { ResetControl } from "./ResetControl.js";

export interface BootstrapShellProps<T> {
  load(): Promise<T>;
  onReady(value: T): void;
}

export function BootstrapShell<T>({ load, onReady }: BootstrapShellProps<T>) {
  const [phase, setPhase] = useState<"loading" | "error">("loading");
  const mounted = useRef(false);
  const attempt = useRef(0);

  const retry = useCallback(() => {
    const currentAttempt = ++attempt.current;
    setPhase("loading");
    void load().then(
      (value) => {
        if (mounted.current && currentAttempt === attempt.current) onReady(value);
      },
      () => {
        if (mounted.current && currentAttempt === attempt.current) setPhase("error");
      },
    );
  }, [load, onReady]);

  useEffect(() => {
    mounted.current = true;
    retry();
    return () => {
      mounted.current = false;
      attempt.current += 1;
    };
  }, [retry]);

  return (
    <>
      <main className="boot-screen">
        <section className="boot-screen__panel glass-panel" aria-label="운영 화면 준비">
          <BrandMark />
          {phase === "loading" ? (
            <>
              <h1>운영 화면을 준비하고 있어요</h1>
              <p aria-live="polite">운영 화면을 준비하는 중입니다</p>
              <div className="loading-dots" aria-hidden="true"><span /><span /><span /></div>
            </>
          ) : (
            <div className="inline-alert" role="alert">
              <h1>운영 화면을 준비하지 못했습니다</h1>
              <p>카메라와 네트워크 상태를 확인한 뒤 다시 시도해 주세요.</p>
              <button className="button button--primary" type="button" onClick={retry}>다시 시도</button>
            </div>
          )}
        </section>
      </main>
      <ResetControl onConfirm={retry} />
    </>
  );
}
