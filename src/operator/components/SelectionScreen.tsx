import type { CapturedPhoto } from "../booth-machine.js";

const REQUIRED_SELECTION_COUNT = 4;

export interface SelectionScreenProps {
  photos: readonly CapturedPhoto[];
  selectedIds: readonly string[];
  onToggle(id: string): void;
  onClear(): void;
  onContinue(): void;
}

export function SelectionScreen({
  photos,
  selectedIds,
  onToggle,
  onClear,
  onContinue,
}: SelectionScreenProps) {
  const canContinue = selectedIds.length === REQUIRED_SELECTION_COUNT;

  return (
    <section aria-label="사진 선택">
      <div aria-label="촬영 사진 목록">
        {photos.map((photo, index) => {
          const selectionIndex = selectedIds.indexOf(photo.id);
          const selected = selectionIndex !== -1;
          const selectionIsFull = selectedIds.length >= REQUIRED_SELECTION_COUNT;

          return (
            <button
              key={photo.id}
              type="button"
              aria-label={`촬영 사진 ${index + 1}`}
              aria-pressed={selected}
              disabled={!selected && selectionIsFull}
              onClick={() => onToggle(photo.id)}
            >
              <img src={photo.previewUrl} alt={`촬영 사진 ${index + 1}`} />
              {selected ? <span aria-label={`선택 순서 ${selectionIndex + 1}`}>{selectionIndex + 1}</span> : null}
            </button>
          );
        })}
      </div>
      <button type="button" onClick={onClear} disabled={selectedIds.length === 0}>
        선택 초기화
      </button>
      <button type="button" onClick={onContinue} disabled={!canContinue}>
        프레임 선택하기
      </button>
    </section>
  );
}
