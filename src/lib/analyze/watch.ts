import { createServerFn } from "@tanstack/react-start";
import type { ModelFacts, WatchResult } from "./types.ts";

type Payload = {
  frames: { t: number; jpeg: string }[];
  brief: string;
};

const SYSTEM = `Ты смотришь отдельные кадры одного ролика, который человек хочет выложить в TikTok. Звук тебе не дан. Не выдумывай предметы, людей, надписи и сюжет, которых нет в кадрах. Если кадр неясный — так и скажи.
Отвечай только JSON без markdown. Язык полей с текстом — русский.
Не пиши прогнозы просмотров и проценты.
Хэштеги описывают только то, что видно. Запрещены: fyp, foryou, viral, рекомендации, рек.
Правки — конкретные действия в монтажке, с привязкой ко времени, а не общие советы «сделай динамичнее».`;

function payload(input: unknown): Payload {
  if (!input || typeof input !== "object") throw new Error("Пустой запрос");
  const frames = (input as { frames?: unknown }).frames;
  const brief = (input as { brief?: unknown }).brief;
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 8) {
    throw new Error("Нужны кадры ролика");
  }
  const clean = frames.map((frame) => {
    if (!frame || typeof frame !== "object") throw new Error("Плохой кадр");
    const t = Number((frame as { t?: unknown }).t);
    const jpeg = (frame as { jpeg?: unknown }).jpeg;
    if (!Number.isFinite(t) || typeof jpeg !== "string" || jpeg.length < 80 || jpeg.length > 120_000) {
      throw new Error("Кадр слишком большой или пустой");
    }
    if (!/^[A-Za-z0-9+/=\s]+$/.test(jpeg)) throw new Error("Кадр повреждён");
    return { t, jpeg: jpeg.replace(/\s/g, "") };
  });
  if (typeof brief !== "string") throw new Error("Нет описания файла");
  return { frames: clean, brief: brief.slice(0, 2500) };
}

function clampScore(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

function extractJson(text: string): unknown {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new Error("not json");
  }
}

function asText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseModel(text: string): ModelFacts {
  const raw = extractJson(text) as Record<string, unknown>;
  const watched = asText(raw.watched);
  if (watched.length < 20) throw new Error("empty watch");
  const hook = (raw.hook ?? {}) as Record<string, unknown>;
  const payoff = (raw.payoff ?? {}) as Record<string, unknown>;
  const loop = (raw.loop ?? {}) as Record<string, unknown>;
  const clarity = (raw.clarity ?? {}) as Record<string, unknown>;
  const watermarkRaw = asText(raw.watermark);
  const watermark = (["none", "tiktok", "other", "unsure"] as const).includes(
    watermarkRaw as "none",
  )
    ? (watermarkRaw as ModelFacts["watermark"])
    : "unsure";
  const fixesIn = Array.isArray(raw.fixes) ? raw.fixes : [];
  const captionsIn = Array.isArray(raw.captions) ? raw.captions : [];
  return {
    watched,
    topic: asText(raw.topic).slice(0, 80),
    hookScore: clampScore(hook.score),
    hookProblem: asText(hook.problem) || null,
    payoffScore: clampScore(payoff.score),
    payoffNote: asText(payoff.note).slice(0, 240),
    loopScore: clampScore(loop.score),
    loopNote: asText(loop.note).slice(0, 240),
    clarityScore: clampScore(clarity.score),
    searchPhrases: Array.isArray(clarity.searchPhrases)
      ? clarity.searchPhrases.map(asText).filter(Boolean).slice(0, 5)
      : [],
    watermark,
    suggestedHookLine: asText(raw.suggestedHookLine).slice(0, 90),
    fixes: fixesIn.slice(0, 6).map((item) => {
      const fix = (item ?? {}) as Record<string, unknown>;
      const priority = asText(fix.priority);
      const at = fix.at === null || fix.at === undefined ? null : Number(fix.at);
      return {
        priority: priority === "high" || priority === "low" ? priority : "medium",
        at: at !== null && Number.isFinite(at) ? at : null,
        title: asText(fix.title),
        action: asText(fix.action),
      };
    }),
    captions: captionsIn.slice(0, 3).map((item) => {
      const caption = (item ?? {}) as Record<string, unknown>;
      return {
        label: asText(caption.label),
        text: asText(caption.text),
        hashtags: Array.isArray(caption.hashtags) ? caption.hashtags.map(asText) : [],
      };
    }),
  };
}

async function complete(apiKey: string, data: Payload, jsonMode: boolean) {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail: "low" } }
  > = [];
  for (const frame of data.frames) {
    content.push({ type: "text", text: `Кадр на ${frame.t.toFixed(2)} с.` });
    content.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${frame.jpeg}`, detail: "low" },
    });
  }
  content.push({
    type: "text",
    text: `${data.brief}

Верни JSON:
{
  "watched": "2-4 предложения, что происходит на кадрах по времени. Назови то, что реально видно.",
  "topic": "тема в 2-4 словах",
  "hook": { "score": 0, "problem": "что не так в первых кадрах или пустая строка" },
  "payoff": { "score": 0, "note": "есть ли причина досмотреть до конца" },
  "loop": { "score": 0, "note": "стыкуется ли последний кадр с первым" },
  "clarity": { "score": 0, "searchPhrases": ["фраза, которую вбили бы в поиск"] },
  "watermark": "none|tiktok|other|unsure",
  "suggestedHookLine": "4-8 слов на экран в 0:00, суть, не «смотри до конца»",
  "fixes": [{ "priority": "high|medium|low", "at": 0.0, "title": "коротко", "action": "что вырезать или передвинуть" }],
  "captions": [
    { "label": "для поиска", "text": "40-90 знаков, слова по которым ищут, без кликбейта", "hashtags": ["3 или 4"] },
    { "label": "коротко", "text": "до 50 знаков", "hashtags": ["3"] },
    { "label": "вопрос", "text": "вопрос по делу ролика", "hashtags": ["3"] }
  ]
}`,
  });

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(50_000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "grok-4.5",
      temperature: 0.2,
      max_tokens: 1600,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    return { ok: false as const, status: res.status, body: body.slice(0, 400) };
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return { ok: true as const, text: json.choices?.[0]?.message?.content ?? "" };
}

function mapFailure(status: number, body: string): WatchResult {
  if (status === 401 || status === 402 || status === 403 || /credit|spending|quota/i.test(body)) {
    return { ok: false, error: status === 401 ? "unavailable" : "credits" };
  }
  return { ok: false, error: "failed" };
}

export const watchFrames = createServerFn({ method: "POST" })
  .validator(payload)
  .handler(async ({ data }): Promise<WatchResult> => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false, error: "unavailable" };
    try {
      let attempt = await complete(apiKey, data, true);
      if (!attempt.ok && (attempt.status === 400 || attempt.status >= 500)) {
        attempt = await complete(apiKey, data, false);
      }
      if (!attempt.ok) return mapFailure(attempt.status, attempt.body);
      return { ok: true, model: parseModel(attempt.text) };
    } catch {
      return { ok: false, error: "failed" };
    }
  });
