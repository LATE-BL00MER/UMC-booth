import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserCameraPort } from "../../../src/operator/camera/camera-port.js";

interface FakeTrack {
  readyState: MediaStreamTrackState;
  stop: ReturnType<typeof vi.fn>;
}

interface FakeStream {
  getTracks(): FakeTrack[];
  getVideoTracks(): FakeTrack[];
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

let originalMediaDevices: PropertyDescriptor | undefined;

beforeEach(() => {
  originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalMediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  } else {
    delete (navigator as { mediaDevices?: MediaDevices }).mediaDevices;
  }
});

function createStream({ live = true } = {}): { stream: MediaStream; tracks: FakeTrack[] } {
  const tracks: FakeTrack[] = [
    { readyState: live ? "live" : "ended", stop: vi.fn() },
    { readyState: live ? "live" : "ended", stop: vi.fn() },
  ];
  const stream: FakeStream = {
    getTracks: () => tracks,
    getVideoTracks: () => [tracks[0]!],
  };
  return { stream: stream as unknown as MediaStream, tracks };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((settle) => {
      resolve = settle;
    }),
    resolve,
  };
}

function installMediaDevices(getUserMedia: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
}

function readyVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "readyState", {
    configurable: true,
    value: HTMLMediaElement.HAVE_METADATA,
  });
  return video;
}

describe("BrowserCameraPort", () => {
  it("requests a front 1920 by 1080 video stream without audio", async () => {
    const { stream } = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    installMediaDevices(getUserMedia);
    const port = new BrowserCameraPort();

    await port.start(readyVideo());

    expect(getUserMedia).toHaveBeenCalledWith({
      video: {
        facingMode: "user",
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
  });

  it("stops every temporary probe track after confirming a live video track", async () => {
    const { stream, tracks } = createStream();
    installMediaDevices(vi.fn().mockResolvedValue(stream));

    await expect(new BrowserCameraPort().probe()).resolves.toBe(true);

    expect(tracks.map((track) => track.stop)).toEqual([expect.any(Function), expect.any(Function)]);
    expect(tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
  });

  it("stops a stream that resolves after its pending start has been stopped", async () => {
    const pending = deferred<MediaStream>();
    installMediaDevices(vi.fn().mockReturnValue(pending.promise));
    const port = new BrowserCameraPort();
    const start = port.start(readyVideo());
    const { stream, tracks } = createStream();

    port.stop();
    pending.resolve(stream);
    await start;

    expect(tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
  });

  it("keeps a newer start active when an earlier pending start resolves later", async () => {
    const first = deferred<MediaStream>();
    const second = deferred<MediaStream>();
    installMediaDevices(vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    const port = new BrowserCameraPort();
    const firstVideo = readyVideo();
    const secondVideo = readyVideo();
    const firstStart = port.start(firstVideo);
    const secondStart = port.start(secondVideo);
    const firstStream = createStream();
    const secondStream = createStream();

    second.resolve(secondStream.stream);
    await secondStart;
    first.resolve(firstStream.stream);
    await firstStart;

    expect(secondVideo.srcObject).toBe(secondStream.stream);
    expect(firstStream.tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
  });

  it("releases the active stream when metadata reports an error", async () => {
    const { stream, tracks } = createStream();
    installMediaDevices(vi.fn().mockResolvedValue(stream));
    const video = document.createElement("video");
    const port = new BrowserCameraPort();
    const start = port.start(video);

    await Promise.resolve();
    video.dispatchEvent(new Event("error"));

    await expect(start).rejects.toThrow("Could not load camera metadata");
    expect(video.srcObject).toBeNull();
    expect(tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
  });

  it("captures a mirrored JPEG at quality 0.92", async () => {
    const { stream } = createStream();
    installMediaDevices(vi.fn().mockResolvedValue(stream));
    const video = readyVideo();
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 1280 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 720 });
    const context = {
      translate: vi.fn(),
      scale: vi.fn(),
      drawImage: vi.fn(),
    };
    const canvas = document.createElement("canvas");
    const photo = new Blob(["jpeg"], { type: "image/jpeg" });
    const toBlob = vi.fn((callback: BlobCallback) => callback(photo));
    Object.defineProperty(canvas, "getContext", {
      configurable: true,
      value: vi.fn(() => context),
    });
    Object.defineProperty(canvas, "toBlob", { configurable: true, value: toBlob });
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(
      ((tagName: string, options?: ElementCreationOptions) =>
        tagName === "canvas" ? canvas : originalCreateElement(tagName, options)) as typeof document.createElement,
    );
    const port = new BrowserCameraPort();
    await port.start(video);

    await expect(port.capture()).resolves.toBe(photo);

    expect(context.translate).toHaveBeenCalledWith(1280, 0);
    expect(context.scale).toHaveBeenCalledWith(-1, 1);
    expect(context.drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.92);
  });

  it("stops all active tracks and clears the preview source", async () => {
    const { stream, tracks } = createStream();
    installMediaDevices(vi.fn().mockResolvedValue(stream));
    const video = readyVideo();
    const port = new BrowserCameraPort();
    await port.start(video);

    port.stop();

    expect(video.srcObject).toBeNull();
    expect(tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
  });
});
