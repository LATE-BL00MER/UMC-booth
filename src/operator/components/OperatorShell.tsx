import type { ReactNode } from "react";

import type { BoothState } from "../booth-machine.js";
import { BrandMark } from "./BrandMark.js";
import { getPreflightReadiness, type PreflightStatus } from "./PreflightBar.js";
import { ResetControl } from "./ResetControl.js";

export interface OperatorShellProps {
  phase: BoothState["phase"];
  status: PreflightStatus | null;
  onReset(): void;
  children: ReactNode;
}

const steps = [
  ["capturing", "촬영"],
  ["selecting", "사진 선택"],
  ["framing", "프레임"],
  ["qr", "QR"],
] as const;

function visualStep(phase: BoothState["phase"]): string | null {
  if (phase === "delivering") return "qr";
  return steps.some(([step]) => step === phase) ? phase : null;
}

function isComplete(step: string, current: string | null): boolean {
  if (current === null) return false;
  return steps.findIndex(([value]) => value === step) < steps.findIndex(([value]) => value === current);
}

export function OperatorShell({ phase, status, onReset, children }: OperatorShellProps) {
  const current = visualStep(phase);
  const ready = status === null ? null : getPreflightReadiness(status, Date.now());

  return (
    <div className="operator-shell" data-phase={phase}>
      <header className="operator-header">
        <BrandMark compact />
        <nav className="operator-steps" aria-label="체험 진행 단계">
          {steps.map(([step, label]) => (
            <span
              key={step}
              aria-current={current === step ? "step" : undefined}
              data-complete={isComplete(step, current)}
            >
              {label}
            </span>
          ))}
        </nav>
        <div className="operator-tools">
          <span
            className="status-chip"
            data-tone={ready === false ? "danger" : ready === true ? "success" : "neutral"}
          >
            {ready === false ? "확인 필요" : ready === true ? "운영 정상" : "상태 확인 중"}
          </span>
          <ResetControl onConfirm={onReset} />
        </div>
      </header>
      <main className="operator-main">{children}</main>
    </div>
  );
}
