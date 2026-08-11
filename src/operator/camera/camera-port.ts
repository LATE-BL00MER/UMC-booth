export interface CameraPort {
  probe(): Promise<boolean>;
  start(video: HTMLVideoElement): Promise<void>;
  capture(): Promise<Blob>;
  stop(): void;
}

const cameraConstraints: MediaStreamConstraints = {
  video: {
    facingMode: "user",
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
};

export class BrowserCameraPort implements CameraPort {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private startGeneration = 0;
  private cancelMetadataWait: (() => void) | null = null;

  constructor(private readonly captureAspectRatio: number | null = null) {
    if (captureAspectRatio !== null && (!Number.isFinite(captureAspectRatio) || captureAspectRatio <= 0)) {
      throw new TypeError("captureAspectRatio must be a positive finite number");
    }
  }

  async probe(): Promise<boolean> {
    let probeStream: MediaStream | null = null;
    try {
      probeStream = await navigator.mediaDevices.getUserMedia(cameraConstraints);
      return probeStream.getVideoTracks().some((track) => track.readyState === "live");
    } catch {
      return false;
    } finally {
      stopTracks(probeStream);
    }
  }

  async start(video: HTMLVideoElement): Promise<void> {
    this.stop();
    const generation = ++this.startGeneration;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(cameraConstraints);
    } catch (error) {
      if (!this.isCurrentStart(generation)) return;
      throw error;
    }

    if (!this.isCurrentStart(generation)) {
      stopTracks(stream);
      return;
    }

    this.stream = stream;
    this.video = video;
    video.srcObject = stream;

    try {
      const metadataLoaded = await this.waitForLoadedMetadata(video, generation);
      if (!metadataLoaded || !this.isCurrentStart(generation)) return;
    } catch (error) {
      if (!this.isCurrentStart(generation)) return;
      this.stop();
      throw error;
    }
  }

  async capture(): Promise<Blob> {
    if (!this.video) {
      throw new Error("Camera has not been started");
    }

    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (width <= 0 || height <= 0) {
      throw new Error("Camera video is not ready");
    }

    const crop = centeredCrop(width, height, this.captureAspectRatio);
    const canvas = document.createElement("canvas");
    canvas.width = crop.width;
    canvas.height = crop.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create a 2D canvas context");
    }

    // The preview is mirrored for the front-facing camera, so persist that same orientation.
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    if (this.captureAspectRatio === null) {
      context.drawImage(this.video, 0, 0, width, height);
    } else {
      context.drawImage(
        this.video,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    }

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (photo) => {
          if (photo) resolve(photo);
          else reject(new Error("Could not encode camera photo"));
        },
        "image/jpeg",
        0.92,
      );
    });
  }

  stop(): void {
    this.startGeneration += 1;
    this.cancelMetadataWait?.();
    this.cancelMetadataWait = null;
    stopTracks(this.stream);
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
    }
    this.video = null;
  }

  private isCurrentStart(generation: number): boolean {
    return this.startGeneration === generation;
  }

  private waitForLoadedMetadata(video: HTMLVideoElement, generation: number): Promise<boolean> {
    if (!this.isCurrentStart(generation)) return Promise.resolve(false);
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve(true);

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("error", onError);
        if (this.cancelMetadataWait === cancel) {
          this.cancelMetadataWait = null;
        }
      };
      const complete = (metadataLoaded: boolean) => {
        cleanup();
        resolve(metadataLoaded);
      };
      const onLoadedMetadata = () => complete(true);
      const onError = () => {
        cleanup();
        reject(new Error("Could not load camera metadata"));
      };
      const cancel = () => complete(false);

      this.cancelMetadataWait = cancel;
      video.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
      video.addEventListener("error", onError, { once: true });
      if (!this.isCurrentStart(generation)) cancel();
    });
  }
}

function centeredCrop(width: number, height: number, targetAspectRatio: number | null) {
  if (targetAspectRatio === null) return { x: 0, y: 0, width, height };

  const sourceAspectRatio = width / height;
  if (sourceAspectRatio > targetAspectRatio) {
    const cropWidth = Math.max(1, Math.floor(height * targetAspectRatio));
    return { x: (width - cropWidth) / 2, y: 0, width: cropWidth, height };
  }
  if (sourceAspectRatio < targetAspectRatio) {
    const cropHeight = Math.max(1, Math.floor(width / targetAspectRatio));
    return { x: 0, y: (height - cropHeight) / 2, width, height: cropHeight };
  }
  return { x: 0, y: 0, width, height };
}

function stopTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
}
