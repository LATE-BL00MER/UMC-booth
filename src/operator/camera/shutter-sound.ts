let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (audioContext) return audioContext;
  if (typeof window === "undefined" || typeof window.AudioContext === "undefined") return null;

  try {
    audioContext = new window.AudioContext();
  } catch {
    return null;
  }
  return audioContext;
}

function scheduleClick(context: AudioContext, startAt: number, frequency: number, volume: number): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "square";
  oscillator.frequency.setValueAtTime(frequency, startAt);
  oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.45, startAt + 0.045);
  gain.gain.setValueAtTime(volume, startAt);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.05);

  oscillator.connect(gain).connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + 0.05);
}

function scheduleShutterSound(context: AudioContext): void {
  const startAt = context.currentTime + 0.005;
  scheduleClick(context, startAt, 1_800, 0.12);
  scheduleClick(context, startAt + 0.075, 1_250, 0.1);
}

/** Prepares audio while the capture screen is entered from the user's start action. */
export function prepareShutterSound(): void {
  const context = getAudioContext();
  if (context?.state === "suspended") void context.resume().catch(() => undefined);
}

export function playShutterSound(): void {
  const context = getAudioContext();
  if (!context) return;

  if (context.state === "running") {
    scheduleShutterSound(context);
    return;
  }

  void context.resume()
    .then(() => scheduleShutterSound(context))
    .catch(() => undefined);
}
