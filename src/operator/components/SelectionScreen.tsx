import type { CSSProperties } from "react";

import type { CapturedPhoto } from "../booth-machine.js";

const REQUIRED_SELECTION_COUNT = 4;

export interface SelectionScreenProps {
  photos: readonly CapturedPhoto[];
  photoAspectRatio: number;
  selectedIds: readonly string[];
  onToggle(id: string): void;
  onClear(): void;
  onContinue(): void;
}

export function SelectionScreen({
  photos,
  photoAspectRatio,
  selectedIds,
  onToggle,
  onClear,
  onContinue,
}: SelectionScreenProps) {
  const canContinue = selectedIds.length === REQUIRED_SELECTION_COUNT;
  const selectionScreenStyle = {
    "--selection-photo-aspect-ratio": photoAspectRatio,
  } as CSSProperties;

  return (
    <section className="selection-screen" style={selectionScreenStyle} aria-label="사진 선택">
      <header className="screen-heading">
        <div>
          <p className="eyebrow">SELECT FOUR</p>
          <h1>마음에 드는 사진 4장을 순서대로 골라주세요</h1>
        </div>
        <output className="selection-progress" aria-live="polite">
          {selectedIds.length} / 4 선택
        </output>
      </header>
      <div className="photo-grid" aria-label="촬영 사진 목록">
        {photos.map((photo, index) => {
          const selectionIndex = selectedIds.indexOf(photo.id);
          const selected = selectionIndex !== -1;
          const selectionIsFull = selectedIds.length >= REQUIRED_SELECTION_COUNT;

          return (
            <button
              className="photo-card"
              key={photo.id}
              type="button"
              data-selected={selected}
              aria-label={`촬영 사진 ${index + 1}`}
              aria-pressed={selected}
              disabled={!selected && selectionIsFull}
              onClick={() => onToggle(photo.id)}
            >
              <img className="photo-card__image" src={photo.previewUrl} alt={`촬영 사진 ${index + 1}`} />
              {selected ? (
                <span className="selection-badge" aria-label={`선택 순서 ${selectionIndex + 1}`}>
                  {selectionIndex + 1}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="screen-actions">
        <button className="button button--ghost" type="button" onClick={onClear} disabled={selectedIds.length === 0}>
          선택 초기화
        </button>
        <span className="screen-actions__spacer" />
        <button className="button button--primary" type="button" onClick={onContinue} disabled={!canContinue}>
          프레임 선택하기
        </button>
      </div>
    </section>
  );
}
