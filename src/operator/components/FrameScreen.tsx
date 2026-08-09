import type { CapturedPhoto } from "../booth-machine.js";
import type { FrameManifest } from "../frames/frame-contract.js";

export interface FrameScreenProps {
  photos: readonly CapturedPhoto[];
  selectedIds: readonly string[];
  frames: readonly FrameManifest[];
  selectedFrameId: string | null;
  onFrameSelect(id: string): void;
  onContinue(frameId: string): void;
}

export function FrameScreen({
  photos,
  selectedIds,
  frames,
  selectedFrameId,
  onFrameSelect,
  onContinue,
}: FrameScreenProps) {
  const photosById = new Map(photos.map((photo) => [photo.id, photo]));
  const hasSelectedFrame = frames.some((frame) => frame.id === selectedFrameId);
  const selectedPhotos = selectedIds
    .map((id) => photosById.get(id))
    .filter((photo): photo is CapturedPhoto => photo !== undefined);
  const continueWithSelectedFrame = () => {
    if (hasSelectedFrame && selectedFrameId !== null) {
      onContinue(selectedFrameId);
    }
  };

  return (
    <section aria-label="프레임 선택">
      <div aria-label="선택한 사진">
        {selectedPhotos.map((photo, index) => (
          <img key={photo.id} src={photo.previewUrl} alt={`선택한 사진 ${index + 1}`} />
        ))}
      </div>
      <div role="radiogroup" aria-label="프레임 목록">
        {frames.map((frame) => (
          <label key={frame.id}>
            <input
              type="radio"
              name="frame"
              value={frame.id}
              aria-label={frame.label}
              checked={selectedFrameId === frame.id}
              onChange={() => onFrameSelect(frame.id)}
            />
            {frame.label}
            <img src={frame.thumbnail} alt={`${frame.label} 미리보기`} />
          </label>
        ))}
      </div>
      <button type="button" onClick={continueWithSelectedFrame} disabled={!hasSelectedFrame}>
        이 프레임으로 사진 만들기
      </button>
    </section>
  );
}
