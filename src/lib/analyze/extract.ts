import { analyzeSamples, meanAbs, samplePlan } from "./signals.ts";
import type { AudioFacts, MeasuredVideo } from "./types.ts";

export type GrabbedFrame = {
  t: number;
  dataUrl: string;
  jpeg: string;
  width: number;
  height: number;
};

export type MeasureProgress = {
  ratio: number;
  label: string;
  frame?: GrabbedFrame;
};

function wait(video: HTMLVideoElement, event: string, ms: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, ms);
    const on = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener(event, on);
    };
    video.addEventListener(event, on);
  });
}

async function seekTo(video: HTMLVideoElement, t: number, signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  const target = Math.min(Math.max(0, t), Math.max(0, video.duration - 0.04));
  if (Math.abs(video.currentTime - target) < 0.04 && video.readyState >= 2) return;
  video.currentTime = target;
  try {
    await wait(video, "seeked", 2500);
  } catch {
    /* some browsers never fire seeked when the frame is already current */
  }
  if ("requestVideoFrameCallback" in video) {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 350);
      video.requestVideoFrameCallback(() => {
        window.clearTimeout(timer);
        resolve();
      });
    });
  }
}

function gridOf(video: HTMLVideoElement) {
  const size = 24;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Не удалось прочитать кадр");
  ctx.drawImage(video, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const grid = new Float32Array(size * size);
  let sum = 0;
  for (let i = 0; i < grid.length; i++) {
    const o = i * 4;
    const y = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
    grid[i] = y;
    sum += y;
  }
  return { grid, brightness: sum / grid.length };
}

function jpegOf(video: HTMLVideoElement) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const maxW = vw >= vh ? 640 : 400;
  const maxH = vw >= vh ? 400 : 680;
  const scale = Math.min(maxW / vw, maxH / vh, 1);
  const width = Math.max(2, Math.round(vw * scale));
  const height = Math.max(2, Math.round(vh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Не удалось прочитать кадр");
  ctx.drawImage(video, 0, 0, width, height);
  let quality = 0.62;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > 110_000 && quality > 0.34) {
    quality -= 0.08;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  const jpeg = dataUrl.split(",")[1] ?? "";
  return { dataUrl, jpeg, width, height };
}

async function readAudio(file: File, duration: number): Promise<AudioFacts> {
  const empty: AudioFacts = {
    decoded: false,
    hasSignal: false,
    silenceStartMs: 0,
    clippedRatio: 0,
    quiet: false,
    flat: false,
    partial: false,
  };
  if (file.size > 1024 * 1024 * 1024) return empty;
  let context: AudioContext | null = null;
  try {
    context = new AudioContext();
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    const channel = decoded.getChannelData(0);
    const rate = decoded.sampleRate;
    const limit = Math.min(channel.length, rate * 60);
    const partial = channel.length > limit + rate;
    const win = Math.max(1, Math.floor(rate * 0.1));
    const rms: number[] = [];
    for (let i = 0; i < limit; i += win) {
      const end = Math.min(limit, i + win);
      let sum = 0;
      for (let j = i; j < end; j += 4) sum += channel[j] * channel[j];
      const count = Math.max(1, Math.ceil((end - i) / 4));
      rms.push(Math.sqrt(sum / count));
    }
    let silence = 0;
    for (const value of rms) {
      if (value < 0.012) silence += 100;
      else break;
    }
    const sorted = [...rms].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    const loud = rms.filter((value) => value >= 0.012);
    const mean = loud.reduce((sum, value) => sum + value, 0) / Math.max(1, loud.length);
    const variance = loud.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, loud.length);
    const step = Math.max(1, Math.floor(limit / 180000));
    let clipped = 0;
    let seen = 0;
    for (let i = 0; i < limit; i += step) {
      seen += 1;
      if (Math.abs(channel[i]) > 0.98) clipped += 1;
    }
    return {
      decoded: true,
      hasSignal: p90 > 0.015,
      silenceStartMs: silence,
      clippedRatio: seen ? clipped / seen : 0,
      quiet: p90 > 0.015 && p50 < 0.02,
      flat: loud.length > 4 && Math.sqrt(variance) / Math.max(mean, 0.0001) < 0.12,
      partial,
    };
  } catch {
    return empty;
  } finally {
    await context?.close().catch(() => undefined);
  }
}

export async function measureVideo(
  video: HTMLVideoElement,
  file: File,
  signal: AbortSignal,
  onProgress: (progress: MeasureProgress) => void,
): Promise<{ measured: MeasuredVideo; frames: GrabbedFrame[] }> {
  if (video.readyState < 1) {
    try {
      await wait(video, "loadedmetadata", 8000);
    } catch {
      throw new Error("Браузер не открыл этот файл. Сохрани ролик как MP4 и вставь ещё раз.");
    }
  }
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  if (!video.videoWidth || !Number.isFinite(video.duration) || video.duration <= 0) {
    throw new Error("В файле нет видеодорожки. Нужен обычный ролик, не ссылка и не картинка.");
  }
  if (video.duration > 600) {
    throw new Error("Ролик длиннее 10 минут. Для ленты обрежь кусок, который собираешься публиковать.");
  }

  try {
    video.muted = true;
    await video.play();
    video.pause();
  } catch {
    /* seeking still works on most desktop browsers */
  }

  const plan = samplePlan(video.duration);
  const raw: { t: number; brightness: number; grid: Float32Array }[] = [];
  const frames: GrabbedFrame[] = [];

  for (let i = 0; i < plan.length; i++) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const point = plan[i];
    onProgress({
      ratio: (i / plan.length) * 0.72,
      label: `Смотрю ${formatMinute(point.t)}`,
    });
    await seekTo(video, point.t, signal);
    const shot = gridOf(video);
    raw.push({ t: point.t, brightness: shot.brightness, grid: shot.grid });
    if (point.upload) {
      const jpeg = jpegOf(video);
      if (jpeg.jpeg.length >= 100) {
        const frame = { t: point.t, ...jpeg };
        frames.push(frame);
        onProgress({
          ratio: (i / plan.length) * 0.72,
          label: `Смотрю ${formatMinute(point.t)}`,
          frame,
        });
      }
    }
  }

  onProgress({ ratio: 0.78, label: "Слушаю дорожку" });
  const audio = await readAudio(file, video.duration);
  if (signal.aborted) throw new DOMException("aborted", "AbortError");

  const samples = raw.map((sample, index) => ({
    t: sample.t,
    brightness: sample.brightness,
    delta: index === 0 ? 0 : meanAbs(raw[index - 1].grid, sample.grid),
  }));
  const loopSimilarity =
    raw.length >= 2 ? 1 - meanAbs(raw[0].grid, raw[raw.length - 1].grid) / 255 : 0;
  const timeline = analyzeSamples(video.duration, samples);

  return {
    frames,
    measured: {
      fileName: file.name || "ролик",
      bytes: file.size,
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
      loopSimilarity,
      audio,
      frameTimes: frames.map((frame) => frame.t),
      ...timeline,
    },
  };
}

function formatMinute(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}
