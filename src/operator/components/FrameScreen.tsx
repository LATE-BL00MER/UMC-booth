import { useEffect, useMemo, useRef, useState } from "react";

import type { CapturedPhoto } from "../booth-machine.js";
import type { BrowserCompositor } from "../frames/browser-compositor.js";
import type { FrameManifest } from "../frames/frame-contract.js";

export interface FrameScreenProps {
  photos: readonly CapturedPhoto[];
  selectedIds: readonly string[];
  frames: readonly FrameManifest[];
  selectedFrameId: string | null;
  compositor: Pick<BrowserCompositor, "compose">;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  onFrameSelect(id: string): void;
  onContinue(frameId: string): void;
}

export function FrameScreen({
  photos,
  selectedIds,
  frames,
  selectedFrameId,
  compositor,
  createObjectURL,
  revokeObjectURL,
  onFrameSelect,
  onContinue,
}: FrameScreenProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewUrlRef = useRef<string | null>(null);
  const makeObjectUrl = createObjectURL ?? defaultCreateObjectURL;
  const revokePreviewUrl = revokeObjectURL ?? defaultRevokeObjectURL;
  const photosById = useMemo(() => new Map(photos.map((photo) => [photo.id, photo])), [photos]);
  const hasSelectedFrame = frames.some((frame) => frame.id === selectedFrameId);
  const selectedPhotos = useMemo(() => selectedIds
    .map((id) => photosById.get(id))
    .filter((photo): photo is CapturedPhoto => photo !== undefined), [photosById, selectedIds]);
  const continueWithSelectedFrame = () => {
    if (hasSelectedFrame && selectedFrameId !== null) {
      onContinue(selectedFrameId);
    }
  };

  useEffect(() => {
    const frame = frames.find((candidate) => candidate.id === selectedFrameId);
    if (!frame || selectedPhotos.length !== 4) {
      releasePreview(previewUrlRef, revokePreviewUrl);
      setPreviewUrl(null);
      setPreviewFailed(false);
      return;
    }
    let stale = false;
    let createdUrl: string | null = null;
    let installed = false;
    releasePreview(previewUrlRef, revokePreviewUrl);
    setPreviewUrl(null);
    setPreviewFailed(false);
    void compositor.compose({ photos: selectedPhotos.map((photo) => photo.blob), frame })
      .then((jpeg) => {
        createdUrl = makeObjectUrl(jpeg);
        if (stale) {
          revokePreviewUrl(createdUrl);
          return;
        }
        releasePreview(previewUrlRef, revokePreviewUrl);
        installed = true;
        previewUrlRef.current = createdUrl;
        setPreviewUrl(createdUrl);
      })
      .catch(() => {
        if (!stale) setPreviewFailed(true);
      });
    return () => {
      stale = true;
      if (createdUrl && !installed) revokePreviewUrl(createdUrl);
    };
  }, [compositor, frames, makeObjectUrl, revokePreviewUrl, selectedFrameId, selectedPhotos]);

  useEffect(() => () => releasePreview(previewUrlRef, revokePreviewUrl), [revokePreviewUrl]);

  return (
    <section className="frame-screen" aria-label="프레임 선택">
      <div className="frame-preview-panel">
        {previewUrl ? (
          <img className="composed-preview" src={previewUrl} alt="선택한 프레임 합성 미리보기" />
        ) : null}
        <div className="selected-photo-strip" aria-label="선택한 사진">
          {selectedPhotos.map((photo, index) => (
            <img key={photo.id} src={photo.previewUrl} alt={`선택한 사진 ${index + 1}`} />
          ))}
        </div>
      </div>
      <div className="frame-sidebar">
        <div>
          <p className="eyebrow">CHOOSE A FRAME</p>
          <h1>마지막으로 프레임을 골라주세요</h1>
        </div>
        {previewFailed ? <p className="inline-alert" role="alert">미리보기를 만들지 못했습니다</p> : null}
        <div className="frame-options" role="radiogroup" aria-label="프레임 목록">
          {frames.map((frame) => (
            <label className="frame-option" data-selected={selectedFrameId === frame.id} key={frame.id}>
              <input
                type="radio"
                name="frame"
                value={frame.id}
                aria-label={frame.label}
                checked={selectedFrameId === frame.id}
                onChange={() => onFrameSelect(frame.id)}
              />
              <img src={frame.thumbnail} alt={`${frame.label} 미리보기`} />
              <span>{frame.label}</span>
            </label>
          ))}
        </div>
        <div className="screen-actions">
          <button className="button button--primary" type="button" onClick={continueWithSelectedFrame} disabled={!hasSelectedFrame}>
            이 프레임으로 사진 만들기
          </button>
        </div>
      </div>
    </section>
  );
}

const defaultCreateObjectURL = (blob: Blob): string => URL.createObjectURL(blob);
const defaultRevokeObjectURL = (url: string): void => URL.revokeObjectURL(url);

function releasePreview(ref: { current: string | null }, revokeObjectURL: (url: string) => void): void {
  if (ref.current === null) return;
  revokeObjectURL(ref.current);
  ref.current = null;
}
