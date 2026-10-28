import type { OcrWord } from "./types.ts";
import type { GrabbedFrame } from "./extract.ts";

function assetUrl(file: string) {
  const url = new URL(window.location.href);
  const prefix = url.pathname.match(/^\/hds-[a-z0-9]+-\d+-[a-z0-9]+/i)?.[0] ?? "";
  url.pathname = `${prefix}/${file}`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function pick(frames: GrabbedFrame[]) {
  const early = frames.filter((frame) => frame.t <= 4).slice(0, 2);
  const mid = frames[Math.min(frames.length - 1, Math.floor(frames.length / 2))];
  const chosen = [...early];
  if (mid && !chosen.some((frame) => frame.t === mid.t)) chosen.push(mid);
  return chosen.slice(0, 3);
}

export async function readOnScreenText(
  frames: GrabbedFrame[],
  signal: AbortSignal,
  onStatus: (label: string) => void,
): Promise<OcrWord[]> {
  const chosen = pick(frames);
  if (!chosen.length || signal.aborted) return [];
  onStatus("Читаю текст на кадрах");
  const { createWorker, PSM } = await import("tesseract.js");
  const worker = await createWorker("rus+eng", 1, {
    langPath: assetUrl("tessdata"),
    gzip: true,
    workerBlobURL: true,
    errorHandler: () => undefined,
  });
  if (signal.aborted) {
    await worker.terminate().catch(() => undefined);
    return [];
  }
  const words: OcrWord[] = [];
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    for (const frame of chosen) {
      if (signal.aborted) break;
      const result = await worker.recognize(frame.dataUrl);
      const blocks = result.data.blocks;
      if (blocks) {
        for (const block of blocks) {
          for (const paragraph of block.paragraphs ?? []) {
            for (const line of paragraph.lines ?? []) {
              for (const word of line.words ?? []) {
                const text = word.text?.trim();
                if (!text) continue;
                words.push({
                  t: frame.t,
                  text,
                  confidence: word.confidence,
                  x: ((word.bbox.x0 + word.bbox.x1) / 2) / frame.width,
                  y: ((word.bbox.y0 + word.bbox.y1) / 2) / frame.height,
                });
              }
            }
          }
        }
      } else if (result.data.text?.trim()) {
        words.push({
          t: frame.t,
          text: result.data.text.trim(),
          confidence: result.data.confidence,
          x: 0.5,
          y: 0.45,
        });
      }
    }
  } finally {
    await worker.terminate().catch(() => undefined);
  }
  return words;
}
