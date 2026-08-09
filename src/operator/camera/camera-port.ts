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
    const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints);
    this.stream = stream;
    this.video = video;
    video.srcObject = stream;

    try {
      await waitForLoadedMetadata(video);
    } catch (error) {
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

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create a 2D canvas context");
    }

    // The preview is mirrored for the front-facing camera, so persist that same orientation.
    context.translate(width, 0);
    context.scale(-1, 1);
    context.drawImage(this.video, 0, 0, width, height);

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
    stopTracks(this.stream);
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
    }
    this.video = null;
  }
}

function stopTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
}

function waitForLoadedMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onLoadedMetadata = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Could not load camera metadata"));
    };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("error", onError);
    };

    video.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}
