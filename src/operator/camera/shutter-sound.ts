const SHUTTER_SOUND_URL = "/camera-shutter.mp3";

let shutterAudio: HTMLAudioElement | null = null;

function getShutterAudio(): HTMLAudioElement | null {
  if (shutterAudio) return shutterAudio;
  if (typeof Audio === "undefined") return null;

  shutterAudio = new Audio();
  shutterAudio.preload = "auto";
  shutterAudio.src = SHUTTER_SOUND_URL;
  return shutterAudio;
}

/** Preloads the attached shutter recording when the user enters the capture screen. */
export function prepareShutterSound(): void {
  getShutterAudio();
}

export function playShutterSound(): void {
  const audio = getShutterAudio();
  if (!audio) return;

  try {
    audio.currentTime = 0;
  } catch {
    // Some browsers reject seeking until the audio metadata has loaded.
  }

  void audio.play().catch(() => undefined);
}
