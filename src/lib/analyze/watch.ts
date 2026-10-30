import { createServerFn } from "@tanstack/react-start";
import type { ModelFacts, WatchResult } from "./types.ts";

type Payload = {
  frames: { t: number; jpeg: string }[];
  brief: string;
};

const SYSTEM = `Ты профессиональный режиссер TikTok и эксперт по вирусному контенту. Ты смотришь отдельные кадры одного ролика.
Твоя задача — оценить ВИЗУАЛЬНУЮ составляющую: композицию, динамику, движение в кадре, смену планов и то, как выстроена визуальная история. 
ЗВУК ТЕБЕ НЕ ДАН. 
ОБРАТИ ВНИМАНИЕ: Если в кадре нет текста, это НЕ значит, что видео плохое. Оценивай картинку, действие и визуальные образы на всех кадрах в совокупности. Если первые кадры темные, но дальше что-то происходит — оценивай по тому, что происходит.
Отвечай только на русском языке.
Отвечай только JSON без markdown.
Все оценки score возвращай целыми числами от 1 до 100, не используй 0. Если данных мало, поставь 40-50 и объясни в note. ЗАПРЕЩЕНО возвращать 0 для story и originality, минимальная оценка 20. 
Заполни все поля структуры.`;

function payload(input: unknown): Payload {
  if (!input || typeof input !== "object") throw new Error("Пустой запрос");
  const frames = (input as { frames?: unknown }).frames;
  const brief = (input as { brief?: unknown }).brief;
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 8) throw new Error("Нужны кадры ролика");
  const clean = frames.map((frame) => {
    if (!frame || typeof frame !== "object") throw new Error("Плохой кадр");
    const t = Number((frame as { t?: unknown }).t);
    const jpeg = (frame as { jpeg?: unknown }).jpeg;
    if (!Number.isFinite(t) || typeof jpeg !== "string" || jpeg.length < 80 || jpeg.length > 120_000) throw new Error("Кадр слишком большой или пустой");
    return { t, jpeg: jpeg.replace(/\s/g, "") };
  });
  if (typeof brief !== "string") throw new Error("Нет описания файла");
  return { frames: clean, brief: brief.slice(0, 2500) };
}

function clampScore(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(1, n));
}

function extractJson(text: string): unknown {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(unfenced); } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new Error("not json");
  }
}

function asText(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

function parseModel(text: string): ModelFacts {
  const raw = extractJson(text) as Record<string, unknown>;
  const watched = asText(raw.watched);
  if (watched.length < 10) throw new Error("empty watch");
  const hook = (raw.hook ?? {}) as Record<string, unknown>;
  const payoff = (raw.payoff ?? {}) as Record<string, unknown>;
  const loop = (raw.loop ?? {}) as Record<string, unknown>;
  const clarity = (raw.clarity ?? {}) as Record<string, unknown>;
  const watermarkRaw = asText(raw.watermark);
  const watermark = (["none", "tiktok", "other", "unsure"] as const).includes(watermarkRaw as "none") ? (watermarkRaw as ModelFacts["watermark"]) : "unsure";
  const fixesIn = Array.isArray(raw.fixes) ? raw.fixes : [];
  const captionsIn = Array.isArray(raw.captions) ? raw.captions : [];
  return {
    watched, topic: asText(raw.topic).slice(0, 80), hookScore: clampScore(hook.score), hookProblem: asText(hook.problem) || null,
    payoffScore: clampScore(payoff.score), payoffNote: asText(payoff.note).slice(0, 240), loopScore: clampScore(loop.score), loopNote: asText(loop.note).slice(0, 240),
    clarityScore: clampScore(clarity.score), storyScore: clampScore((raw.story as Record<string, unknown> | undefined)?.score),
    storyNote: asText((raw.story as Record<string, unknown> | undefined)?.note).slice(0, 300),
    originalityScore: clampScore((raw.originality as Record<string, unknown> | undefined)?.score),
    originalityNote: asText((raw.originality as Record<string, unknown> | undefined)?.note).slice(0, 300),
    retentionNotes: Array.isArray(raw.retentionNotes) ? raw.retentionNotes.map(asText).filter(Boolean).slice(0, 5) : [],
    searchPhrases: Array.isArray(clarity.searchPhrases) ? clarity.searchPhrases.map(asText).filter(Boolean).slice(0, 5) : [],
    watermark, suggestedHookLine: asText(raw.suggestedHookLine).slice(0, 90),
    titles: Array.isArray(raw.titles) ? raw.titles.map(asText).filter(Boolean).slice(0, 5) : [],
    strengths: Array.isArray(raw.strengths) ? raw.strengths.map(asText).filter(Boolean).slice(0, 5) : [],
    weaknesses: Array.isArray(raw.weaknesses) ? raw.weaknesses.map(asText).filter(Boolean).slice(0, 5) : [],
    fixes: fixesIn.slice(0, 6).map((item) => {
      const fix = (item ?? {}) as Record<string, unknown>;
      const priority = asText(fix.priority);
      const at = fix.at === null || fix.at === undefined ? null : Number(fix.at);
      return { priority: priority === "high" || priority === "low" ? priority : "medium", at: at !== null && Number.isFinite(at) ? at : null, title: asText(fix.title), action: asText(fix.action) };
    }),
    captions: captionsIn.slice(0, 3).map((item) => {
      const caption = (item ?? {}) as Record<string, unknown>;
      return { label: asText(caption.label), text: asText(caption.text), hashtags: Array.isArray(caption.hashtags) ? caption.hashtags.map(asText) : [] };
    }),
  };
}

async function complete(apiKey: string, data: Payload) {
  const parts: any[] = [];
  for (const frame of data.frames) {
    parts.push({ text: `Кадр на ${frame.t.toFixed(2)} с.` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: frame.jpeg } });
  }
  const prompt = `${data.brief}
Верни JSON (строго без markdown, только { ... }):
{
  "watched": "2-4 предложения, что происходит на кадрах.",
  "topic": "тема",
  "hook": { "score": 50, "problem": "проблема" },
  "payoff": { "score": 50, "note": "причина" },
  "loop": { "score": 50, "note": "стыковка" },
  "clarity": { "score": 50, "searchPhrases": ["фраза"] },
  "story": { "score": 50, "note": "оценка сюжета" },
  "originality": { "score": 50, "note": "оценка оригинальности" },
  "retentionNotes": ["удержание"],
  "watermark": "none|tiktok|other|unsure",
  "suggestedHookLine": "4-8 слов",
  "titles": ["заголовок 1", "заголовок 2"],
  "strengths": ["плюс 1", "плюс 2"],
  "weaknesses": ["минус 1"],
  "fixes": [{ "priority": "high", "at": 0.0, "title": "правка", "action": "действие" }],
  "captions": [{ "label": "текст", "text": "описание", "hashtags": ["#tag"] }]
}`;
  parts.push({ text: prompt });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0.4, responseMimeType: "application/json" }
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    return { ok: false as const, status: res.status, body: body.slice(0, 400) };
  }
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return { ok: true as const, text };
}

export const watchFrames = createServerFn({ method: "POST" })
  .validator(payload)
  .handler(async ({ data }): Promise<WatchResult> => {
    const apiKey = process.env.GEMINI_API_KEY; 
    if (!apiKey) return { ok: false, error: "unavailable" };

    try {
      const attempt = await complete(apiKey, data);
      if (!attempt.ok) return { ok: false, error: "failed" };
      return { ok: true, model: parseModel(attempt.text) };
    } catch (e) {
      return { ok: false, error: "failed" };
    }
  });
