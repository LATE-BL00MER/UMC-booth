import { useEffect, useRef, useState } from "react";

export interface ResetControlProps {
  onConfirm(): void;
}

export function ResetControl({ onConfirm }: ResetControlProps) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const resetButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (isDialogOpen) {
      dialogRef.current?.focus();
      return;
    }

    if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      resetButtonRef.current?.focus();
    }
  }, [isDialogOpen]);

  useEffect(() => {
    if (!isDialogOpen) return;

    const cancelWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        restoreFocusRef.current = true;
        setIsDialogOpen(false);
      }
    };

    window.addEventListener("keydown", cancelWithEscape);
    return () => window.removeEventListener("keydown", cancelWithEscape);
  }, [isDialogOpen]);

  const cancel = () => {
    restoreFocusRef.current = true;
    setIsDialogOpen(false);
  };

  const confirm = () => {
    setIsDialogOpen(false);
    onConfirm();
  };

  return (
    <div style={{ position: "fixed", top: 16, right: 16 }}>
      <button ref={resetButtonRef} type="button" onClick={() => setIsDialogOpen(true)}>
        처음으로
      </button>
      {isDialogOpen ? (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-dialog-title"
          tabIndex={-1}
        >
          <p id="reset-dialog-title">처음 화면으로 돌아갈까요?</p>
          <button type="button" onClick={cancel}>
            취소
          </button>
          <button type="button" onClick={confirm}>
            확인
          </button>
        </div>
      ) : null}
    </div>
  );
}
