export type Sample = { t: number; brightness: number; delta: number };

export type Timeline = {
  brightnessStart: number;
  motionFirst3s: number;
  stillOpening: boolean;
  blackOpening: boolean;
  cutCount: number;
  cutsPer10s: number;
  deadZones: { start: number; end: number }[];
};

const CUT = 26;
const STILL = 3.2;

export function samplePlan(duration: number): { t: number; upload: boolean }[] {
  const safe = Number.isFinite(duration) && duration > 0 ? duration : 0.2;
  const end = Math.max(0.05, Math.round((safe - 0.08) * 100) / 100);
  const step = safe <= 12 ? 0.4 : safe <= 30 ? 0.65 : safe <= 75 ? 1 : 1.8;
  const times: number[] = [];
  const start = Math.min(0.08, end);
  for (let t = start; t <= end + 0.001; t += step) {
    times.push(Math.round(Math.min(t, end) * 100) / 100);
  }
  if (times.length === 0 || times[times.length - 1] < end - 0.15) {
    times.push(end);
  }

  const uniq: number[] = [];
  for (const t of times) {
    if (!uniq.length || Math.abs(uniq[uniq.length - 1] - t) > 0.05) uniq.push(t);
  }

  let picked = uniq;
  if (uniq.length > 34) {
    picked = [];
    for (let i = 0; i < 34; i++) {
      picked.push(uniq[Math.round((i * (uniq.length - 1)) / 33)]);
    }
    picked = picked.filter((t, i) => i === 0 || t !== picked[i - 1]);
  }

  const upload = new Set<number>([0, picked.length - 1]);
  const anchors = [0.45, 1.1, 2.2, 3.1, safe * 0.45, safe * 0.7];
  for (const anchor of anchors) {
    if (upload.size >= 8) break;
    let best = 0;
    let bestD = Infinity;
    picked.forEach((t, i) => {
      const d = Math.abs(t - anchor);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    upload.add(best);
  }

  let guard = 0;
  while (upload.size < Math.min(8, picked.length) && guard < 24) {
    guard += 1;
    let best = -1;
    let bestGap = -1;
    for (let i = 0; i < picked.length; i++) {
      if (upload.has(i)) continue;
      let gap = Infinity;
      for (const u of upload) gap = Math.min(gap, Math.abs(i - u));
      if (gap > bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    if (best < 0) break;
    upload.add(best);
  }

  return picked.map((t, i) => ({ t, upload: upload.has(i) }));
}

export function analyzeSamples(duration: number, samples: Sample[]): Timeline {
  const brightnessStart = samples[0]?.brightness ?? 0;
  const early = samples.filter((s) => s.t > 0.05 && s.t <= 3.05);
  const motionFirst3s = early.length
    ? early.reduce((sum, s) => sum + s.delta, 0) / early.length
    : 0;
  const opening = samples.filter((s) => s.t <= 1.35);
  const openingMotion = opening.length
    ? opening.reduce((sum, s) => sum + s.delta, 0) / opening.length
    : 0;
  const stillOpening = opening.length >= 2 && openingMotion < STILL;
  const second = samples[1];
  const blackOpening =
    brightnessStart < 18 && (!second || second.t > 1 || second.brightness < 30);

  let cutCount = 0;
  for (const sample of samples) {
    if (sample.delta >= CUT) cutCount += 1;
  }

  const deadZones: { start: number; end: number }[] = [];
  let start: number | null = null;
  let last = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (cur.delta < 2.8) {
      if (start === null) start = prev.t;
      last = cur.t;
    } else if (start !== null) {
      if (last - start >= 2.8) deadZones.push({ start, end: last });
      start = null;
    }
  }
  if (start !== null && last - start >= 2.8) deadZones.push({ start, end: last });

  const span = duration > 0 ? duration : samples[samples.length - 1]?.t || 1;
  return {
    brightnessStart,
    motionFirst3s,
    stillOpening,
    blackOpening,
    cutCount,
    cutsPer10s: (cutCount / span) * 10,
    deadZones,
  };
}

export function meanAbs(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}
