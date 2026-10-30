import { useState } from "react";
import { Button } from "@/components/ui/button";
import { analyzeAccount } from "@/lib/analyze/account";
import { UploadCloud } from "lucide-react";

export function AccountAnalyzer() {
  const [image, setImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = (event.target?.result as string).split(",")[1];
      setImage(base64);
      setResult(null);
      setError(null);
    };
    reader.readAsDataURL(file);
  }

  async function analyze() {
    if (!image) return;
    setLoading(true);
    setError(null);
    try {
      const res = await analyzeAccount({ data: { image, brief: "Скриншот статистики TikTok" } });
      if (res.ok && res.data) setResult(res.data);
      else setError("Не удалось проанализировать. Попробуй другой скриншот.");
    } catch {
      setError("Ошибка соединения.");
    }
    setLoading(false);
  }

  return (
    <div className="mt-8 flex flex-col gap-6">
      <div className="rounded-2xl border border-line bg-card p-5">
        <h2 className="font-display text-2xl tracking-tight">Анализ аккаунта</h2>
        <p className="mt-2 text-sm text-muted">Загрузи скриншот статистики из TikTok (просмотры, лайки) или свой профиль. Нейросеть оценит «прогрев» и скажет, что делать дальше.</p>
        
        <label className="mt-4 flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-line bg-elevated px-4 py-8 hover:bg-ink/50 transition">
          <UploadCloud className="mr-2 size-5 text-muted" />
          <span>{image ? "Скриншот загружен (нажми для замены)" : "Выбрать скриншот"}</span>
          <input type="file" accept="image/*" className="sr-only" onChange={handleFile} />
        </label>

        {image && (
          <Button className="mt-4 w-full" onClick={analyze} disabled={loading}>
            {loading ? "Сканирую профиль..." : "Узнать процент прогрева"}
          </Button>
        )}
        {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      </div>

      {result && (
        <div className="rise flex flex-col gap-4">
          <div className="rounded-2xl border border-line bg-card p-5 text-center">
            <p className="text-sm text-muted">Процент прогрева</p>
            <p className="mt-2 font-display text-6xl tabular-nums text-foreground">{result.warmupScore}%</p>
            <p className="mt-3 text-sm">{result.warmupNote}</p>
            <div className="mt-4 grid grid-cols-3 gap-2">
              <div className="rounded-lg bg-elevated p-2"><p className="text-xs text-muted">Просмотры</p><p className="font-mono text-sm">{result.stats?.views || "-"}</p></div>
              <div className="rounded-lg bg-elevated p-2"><p className="text-xs text-muted">Лайки</p><p className="font-mono text-sm">{result.stats?.likes || "-"}</p></div>
              <div className="rounded-lg bg-elevated p-2"><p className="text-xs text-muted">Подписчики</p><p className="font-mono text-sm">{result.stats?.followers || "-"}</p></div>
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-card p-5">
            <h3 className="font-display text-xl tracking-tight">Как прогреть аккаунт</h3>
            <ul className="mt-3 flex flex-col gap-2">
              {result.actionPlan?.map((step: string, i: number) => (
                <li key={i} className="text-sm"><span className="font-bold text-violet-400">{i + 1}.</span> {step}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
