import { createServerFn } from "@tanstack/react-start";
import type { ModelFacts, WatchResult } from "./types.ts";

type Payload = {
  frames: { t: number; jpeg: string }[];
  brief: string;
};

const SYSTEM = `Ты профессиональный режиссер TikTok и эксперт по вирусному контенту. Ты смотришь отдельные кадры одного ролика.
Твоя задача — оценить ВИЗУАЛЬНУЮ составляющую и риск ТЕНЕВОГО БАНА (shadowban).
ЗВУК ТЕБЕ НЕ ДАН. 
ОБРАТИ ВНИМАНИЕ: Если в кадре нет текста, это НЕ значит, что видео плохое. Оценивай картинку, действие и визуальные образы.
Отвечай только на русском языке. Отвечай только JSON без markdown.
Все оценки score возвращай целыми числами от 1 до 100. Если данных мало, ставь 40-50. ЗАПРЕЩЕНО возвращать 0.`;

function payload(input: unknown): Payload {
  if (!input || typeof input !== "object") throw new Error("Пустой запрос");
  const frames = (input as { frames?: unknown }).frames;
  const brief = (input as { brief?: unknown }).brief;
  if (!Array.isArray(frames) || frames.length < 1) throw new Error("Нужны кадры ролика");
  const clean = frames.map((frame) => {
    const t = Number((frame as { t?: unknown }).t);
    const jpeg = (frame as { jpeg?: unknown }).jpeg as string;
    return { t, jpeg: jpeg.replace(/\s/g, "") };
  });
  return { frames: clean, brief: String(brief).slice(0, 2500) };
}

function clampScore(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : 50;
}

function extractJson(text: string): any {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(unfenced); } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new Error("not json");
  }
}

function parseModel(text: string): ModelFacts {
  const raw = extractJson(text);
  return {
    watched: String(raw.watched || ""),
    topic: String(raw.topic || ""),
    hookScore: clampScore(raw.hook?.score),
    hookProblem: String(raw.hook?.problem || ""),
    payoffScore: clampScore(raw.payoff?.score),
    payoffNote: String(raw.payoff?.note || ""),
    loopScore: clampScore(raw.loop?.score),
    loopNote: String(raw.loop?.note || ""),
    clarityScore: clampScore(raw.clarity?.score),
    storyScore: clampScore(raw.story?.score),
    storyNote: String(raw.story?.note || ""),
    originalityScore: clampScore(raw.originality?.score),
    originalityNote: String(raw.originality?.note || ""),
    retentionNotes: Array.isArray(raw.retentionNotes) ? raw.retentionNotes.map(String) : [],
    watermark: raw.watermark || "unsure",
    suggestedHookLine: String(raw.suggestedHookLine || ""),
    titles: Array.isArray(raw.titles) ? raw.titles.map(String) : [],
    strengths: Array.isArray(raw.strengths) ? raw.strengths.map(String) : [],
    weaknesses: Array.isArray(raw.weaknesses) ? raw.weaknesses.map(String) : [],
    fixes: Array.isArray(raw.fixes) ? raw.fixes : [],
    captions: Array.isArray(raw.captions) ? raw.captions : [],
    // НОВЫЕ ПОЛЯ ДЛЯ ТЕНЕВОГО БАНА
    shadowbanScore: clampScore(raw.shadowban?.score),
    shadowbanReasons: Array.isArray(raw.shadowban?.reasons) ? raw.shadowban.reasons.map(String) : []
  } as ModelFacts;
}

async function complete(apiKey: string, data: Payload) {
  const parts: any[] = [];
  for (const frame of data.frames) {
    parts.push({ text: `Кадр на ${frame.t.toFixed(2)} с.` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: frame.jpeg } });
  }
  const prompt = `${data.brief}
Верни JSON:
{
  "watched": "2-4 предложения, что происходит на кадрах.",
  "topic": "тема",
  "hook": { "score": 50, "problem": "проблема" },
  "payoff": { "score": 50, "note": "причина" },
  "loop": { "score": 50, "note": "стыковка" },
  "clarity": { "score": 50 },
  "story": { "score": 50, "note": "оценка сюжета" },
  "originality": { "score": 50, "note": "оценка оригинальности" },
  "shadowban": {
    "score": 50,
    "reasons": ["Причина 1 (например, чужой водяной знак)", "Причина 2 (например, плохое качество)"]
  },
  "retentionNotes": ["удержание"],
  "watermark": "none|tiktok|other|unsure",
  "suggestedHookLine": "4-8 слов",
  "titles": ["заголовок"],
  "strengths": ["плюс"],
  "weaknesses": ["минус"],
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

  if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
  const json = await res.json();
  return json.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

export const watchFrames = createServerFn({ method: "POST" })
  .validator(payload)
  .handler(async ({ data }): Promise<WatchResult> => {
    const apiKey = process.env.GEMINI_API_KEY; 
    if (!apiKey) return { ok: false, error: "unavailable" };
    try {
      const text = await complete(apiKey, data);
      return { ok: true, model: parseModel(text) };
    } catch (e) {
      return { ok: false, error: "failed" };
    }
  });
