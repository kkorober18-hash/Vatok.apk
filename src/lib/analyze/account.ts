import { createServerFn } from "@tanstack/react-start";

export const analyzeAccount = createServerFn({ method: "POST" })
  .validator((data: { image: string; brief: string }) => data)
  .handler(async ({ data }) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { ok: false, error: "unavailable" };

    const prompt = `
      Ты профессиональный SMM-менеджер и эксперт по TikTok.
      Проанализируй скриншот статистики или профиля TikTok аккаунта.
      Твоя задача:
      1. Считать общие характеристики (просмотры, лайки, подписчики), если они видны.
      2. Оценить "процент прогрева" аккаунта (от 0 до 100). 
         - 0-30: Аккаунт "мертвый" или в теневом бане (очень мало просмотров, нулевая вовлеченность).
         - 40-70: Средний аккаунт (просмотры есть, но нестабильные).
         - 80-100: Отлично прогретый аккаунт (стабильные просмотры, высокий охват).
      3. Написать конкретные шаги, как улучшить аккаунт (что нужно делать, чтобы прогреть).
      
      Отвечай только на русском языке. Верни строго JSON без markdown:
      {
        "stats": { "views": "строка (например, 10-50к)", "likes": "строка", "followers": "строка" },
        "warmupScore": 50,
        "warmupNote": "Краткое описание состояния аккаунта.",
        "actionPlan": ["Конкретный шаг 1", "Конкретный шаг 2", "Шаг 3"]
      }
    `;

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            { text: data.brief },
            { inlineData: { mimeType: "image/jpeg", data: data.image } }
          ]
        }],
        generationConfig: { temperature: 0.3, responseMimeType: "application/json" }
      }),
    });

    if (!res.ok) return { ok: false, error: "failed" };
    
    try {
      const json = await res.json();
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      const parsed = JSON.parse(text.replace(/```json/g, "").replace(/```/g, ""));
      return { ok: true, data: parsed };
    } catch {
      return { ok: false, error: "failed" };
    }
  });
