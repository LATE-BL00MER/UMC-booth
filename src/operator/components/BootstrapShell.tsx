import { useCallback, useEffect, useRef, useState } from "react";

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
      <main>
        <section aria-label="운영 화면 준비">
          {phase === "loading" ? (
            <p aria-live="polite">운영 화면을 준비하는 중입니다</p>
          ) : (
            <div role="alert">
              <p>운영 화면을 준비하지 못했습니다</p>
              <button type="button" onClick={retry}>다시 시도</button>
            </div>
          )}
        </section>
      </main>
      <ResetControl onConfirm={retry} />
    </>
  );
}
