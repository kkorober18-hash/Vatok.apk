import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Film, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { measureVideo, type GrabbedFrame } from "@/lib/analyze/extract";
import { readOnScreenText } from "@/lib/analyze/ocr";
import { buildReport, formatClock, formatCount } from "@/lib/analyze/report";
import type { ModelFacts, OcrWord, Report } from "@/lib/analyze/types";
import { watchFrames } from "@/lib/analyze/watch";

const MAX_BYTES = 1024 * 1024 * 1024;

function isVideo(file: File) {
  return file.type.startsWith("video/") || /\.(mp4|mov|webm|m4v|mkv|avi)$/i.test(file.name);
}

function captionText(text: string, hashtags: string[]) {
  const tags = hashtags.map((tag) => `#${tag}`).join(" ");
  return tags ? `${text}\n\n${tags}` : text;
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
  }
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("ru-RU")} КБ`;
}

export function Studio() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<{ label: string; ratio: number } | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [filmstrip, setFilmstrip] = useState<GrabbedFrame[]>([]);
  const [safeZone, setSafeZone] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text") ?? "";
      if (/tiktok\.com|vm\.tiktok/i.test(text)) {
        setError("Ссылку TikTok отсюда не скачать. Сохрани ролик на устройство и вставь файл.");
        return;
      }
      const next = Array.from(event.clipboardData?.files ?? []).find(isVideo);
      if (!next) return;
      event.preventDefault();
      take(next);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // take() only uses stable setters and refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function take(next: File) {
    if (!isVideo(next)) {
      setError("Нужен видеофайл. Картинки и ссылки не разбираются.");
      return;
    }
    if (next.size > MAX_BYTES) {
      setError("Файл больше 1 ГБ. Сожми ролик — для проверки хватит обычного MP4.");
      return;
    }
    abortRef.current?.abort();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const nextUrl = URL.createObjectURL(next);
    urlRef.current = nextUrl;
    setError(null);
    setReport(null);
    setFilmstrip([]);
    setCopied(null);
    setRun({ label: "Открываю файл", ratio: 0.04 });
    setFile(next);
    setUrl(nextUrl);
  }

  useEffect(() => {
    if (!file || !url) return;
    const video = videoRef.current;
    if (!video) return;
    const ac = new AbortController();
    abortRef.current = ac;
    let dead = false;
    const local: GrabbedFrame[] = [];

    void (async () => {
      try {
        const { measured, frames } = await measureVideo(video, file, ac.signal, (progress) => {
          if (dead) return;
          if (progress.frame) local.push(progress.frame);
          setFilmstrip([...local]);
          setRun({ label: progress.label, ratio: progress.ratio });
        });
        if (ac.signal.aborted || dead) return;

        setRun({ label: "Читаю текст на кадрах", ratio: 0.86 });
        let words: OcrWord[] = [];
        const ocrAc = new AbortController();
        const stopOcr = () => ocrAc.abort();
        ac.signal.addEventListener("abort", stopOcr);
        const ocrTimer = window.setTimeout(stopOcr, 20000);
        try {
          words = await Promise.race([
            readOnScreenText(frames, ocrAc.signal, (label) => {
              if (!dead) setRun({ label, ratio: 0.9 });
            }).catch(() => [] as OcrWord[]),
            new Promise<OcrWord[]>((resolve) => window.setTimeout(() => resolve([]), 20000)),
          ]);
        } finally {
          window.clearTimeout(ocrTimer);
          ac.signal.removeEventListener("abort", stopOcr);
        }
        if (ac.signal.aborted || dead) return;

        let model: ModelFacts | null = null;
        let modelError: "unavailable" | "credits" | "failed" | null = null;
        if (frames.length) {
          setRun({ label: "Сверяю сюжет по кадрам", ratio: 0.94 });
          try {
            const watched = await watchFrames({
              data: {
                frames: frames.map((frame) => ({ t: Number(frame.t.toFixed(2)), jpeg: frame.jpeg })),
                brief: `Длительность ${measured.duration.toFixed(1)} с. Кадр ${measured.width}×${measured.height}. Кадры по времени. Звук не приложен, не описывай его.`,
              },
            });
            if (watched.ok) model = watched.model;
            else modelError = watched.error;
          } catch {
            modelError = "failed";
          }
        }
        if (ac.signal.aborted || dead) return;

        const built = buildReport(measured, words, model);
        if (modelError === "credits") {
          built.limits.unshift(
            "Разбор сюжета сейчас недоступен: закончился лимит модели. Цифры ниже — только по файлу и тексту на кадре, без догадок о смысле.",
          );
        } else if (modelError) {
          built.limits.unshift("Сюжет по кадрам сейчас не разобран. Оценка за модель не додумана.");
        }
        video.pause();
        video.currentTime = 0;
        video.muted = false;
        setFilmstrip(frames);
        setReport(built);
        setRun(null);
      } catch (err) {
        if (ac.signal.aborted || dead) return;
        const message = err instanceof Error ? err.message : "Не удалось разобрать ролик";
        setError(message);
        setRun(null);
      }
    })();

    return () => {
      dead = true;
      ac.abort();
    };
  }, [file, url]);

  function reset() {
    abortRef.current?.abort();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setFile(null);
    setUrl(null);
    setReport(null);
    setRun(null);
    setFilmstrip([]);
    setError(null);
    setCopied(null);
  }

  function jump(t: number) {
    const node = videoRef.current;
    if (!node) return;
    const end = Number.isFinite(node.duration) ? Math.max(0, node.duration - 0.05) : t;
    node.currentTime = Math.min(Math.max(0, t), end);
    void node.play().catch(() => undefined);
  }

  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600);
    } catch {
      setError("Не удалось скопировать. Выдели текст описания вручную.");
    }
  }

  const busy = run !== null;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 py-6 sm:px-6 sm:py-10">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="relative size-14 shrink-0 overflow-hidden rounded-2xl border border-white/10 shadow-lg shadow-violet-950/30 sm:size-16">
            <img src="/app-icon.png" alt="" className="size-full object-cover" />
            <span className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/10" />
          </div>
          <div>
            <p className="font-display text-3xl leading-none tracking-tight">Vatok</p>
            <p className="mt-1 text-sm text-muted">Умный разбор TikTok-видео</p>
          </div>
        </div>
        {url ? (
          <Button type="button" variant="outline" size="sm" onClick={reset}>
            <RotateCcw className="size-4" aria-hidden="true" />
            Другой ролик
          </Button>
        ) : null}
      </header>

      {!url ? <Intro drag={drag} error={error} onFile={take} onDrag={setDrag} /> : null}

      {url ? (
        <div className="mt-8 grid gap-6 lg:grid-cols-4 lg:items-start">
          <section className={report ? "order-2 lg:order-1 lg:sticky lg:top-4" : "order-1 lg:sticky lg:top-4"}>
            <div className="mx-auto w-full max-w-xs overflow-hidden rounded-2xl border border-line bg-ink">
              <div className="relative bg-ink" style={{ aspectRatio: "9 / 16" }}>
                <video
                  ref={videoRef}
                  src={url}
                  playsInline
                  muted={busy}
                  controls={!busy}
                  className="h-full w-full bg-ink object-contain"
                />
                {safeZone ? <SafeZone /> : null}
                {busy ? <div className="scan-line pointer-events-none absolute inset-x-0 top-0 h-px bg-paper" /> : null}
              </div>
            </div>
            <div className="mx-auto mt-3 flex w-full max-w-xs items-center justify-between gap-3">
              <p className="truncate text-sm text-muted">{file?.name}</p>
              <button
                type="button"
                className="shrink-0 text-sm text-foreground underline-offset-4 hover:underline"
                onClick={() => setSafeZone((value) => !value)}
                aria-pressed={safeZone}
              >
                {safeZone ? "Зона кнопок" : "Показать зону"}
              </button>
            </div>
            {filmstrip.length ? (
              <ul className="mx-auto mt-3 flex w-full max-w-xs gap-2 overflow-x-auto pb-1">
                {filmstrip.map((frame) => (
                  <li key={`${frame.t}-${frame.jpeg.length}`}>
                    <button
                      type="button"
                      onClick={() => jump(frame.t)}
                      className="block overflow-hidden rounded-md border border-line"
                      aria-label={`Кадр ${formatClock(frame.t)}`}
                    >
                      <img src={frame.dataUrl} alt="" className="h-16 w-10 object-cover" />
                    </button>
                    <span className="mt-1 block text-center font-mono text-sm tabular-nums text-muted">
                      {formatClock(frame.t)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className={report ? "order-1 min-w-0 lg:order-2 lg:col-span-3" : "order-2 min-w-0 lg:col-span-3"} aria-live="polite">
            {error ? <p className="mb-4 text-sm text-bad">{error}</p> : null}
            {busy && run ? (
              <div className="rise rounded-2xl border border-line bg-card p-5">
                <p className="font-medium">{run.label}</p>
                <p className="mt-2 text-sm text-muted">
                  Ролик не оценивается наугад: сначала кадры и звук, потом текст на экране, затем сюжет.
                </p>
                <div className="meter mt-4 h-1 overflow-hidden rounded-sm bg-elevated">
                  <div className="h-full bg-paper" style={{ width: `${Math.round(run.ratio * 100)}%` }} />
                </div>
              </div>
            ) : null}
            {report ? <Verdict report={report} copied={copied} onJump={jump} onCopy={copy} /> : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}

function Intro({
  drag,
  error,
  onFile,
  onDrag,
}: {
  drag: boolean;
  error: string | null;
  onFile: (file: File) => void;
  onDrag: (value: boolean) => void;
}) {
  return (
    <div className="mt-10">
      <h1 className="max-w-xl font-display text-4xl leading-tight tracking-tight sm:text-5xl">
        Вставь ролик. Посмотрим его до публикации.
      </h1>
      <p className="mt-4 max-w-xl text-muted">
        Больше ничего не нужно. Лента сама прокрутит кадры, послушает звук и прочитает текст. На выходе — шанс
        пройти первый тест рекомендаций, честная вилка просмотров, описание и правки по таймкоду.
      </p>
      {error ? <p className="mt-4 max-w-xl text-sm text-bad">{error}</p> : null}
      <label
        className={
          "mt-8 flex min-h-52 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-10 text-center " +
          (drag ? "border-paper bg-elevated" : "border-line bg-card")
        }
        onDragOver={(event) => {
          event.preventDefault();
          onDrag(true);
        }}
        onDragLeave={() => onDrag(false)}
        onDrop={(event) => {
          event.preventDefault();
          onDrag(false);
          const next = Array.from(event.dataTransfer.files).find(isVideo) ?? event.dataTransfer.files[0];
          if (next) onFile(next);
        }}
      >
        <Film className="size-6 text-muted" aria-hidden="true" />
        <span className="mt-4 font-medium">Выбрать, перетащить или вставить</span>
        <span className="mt-2 max-w-sm text-sm text-muted">
          MP4, MOV или WebM. Ссылку на TikTok вставить нельзя — только сам файл.
        </span>
        <input
          type="file"
          accept="video/mp4,video/quicktime,video/webm,video/*"
          className="sr-only"
          onChange={(event) => {
            const next = event.target.files?.[0];
            event.target.value = "";
            if (next) onFile(next);
          }}
        />
      </label>
      <ul className="mt-8 grid gap-3 sm:grid-cols-3">
        <Point title="Первые 3 секунды" text="Тёмный кадр, тишина и заставка останавливают ролик ещё на тестовых сотнях." />
        <Point title="Досмотр, не лайки" text="Дальше лента смотрит, досмотрели ли. Длина сама по себе почти ничего не решает." />
        <Point title="Слова для поиска" text="Описание собирается из того, что видно. Пустые хэштеги вроде «рек» не ставятся." />
      </ul>
    </div>
  );
}

function Point({ title, text }: { title: string; text: string }) {
  return (
    <li className="rounded-2xl border border-line bg-card p-4">
      <p className="font-medium">{title}</p>
      <p className="mt-2 text-sm text-muted">{text}</p>
    </li>
  );
}

function SafeZone() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      <div className="absolute inset-x-0 top-0 bg-ink/55" style={{ height: "9%" }} />
      <div className="absolute inset-x-0 bottom-0 bg-ink/55" style={{ height: "20%" }} />
      <div className="absolute right-0 bg-ink/55" style={{ top: "9%", bottom: "20%", width: "14%" }} />
    </div>
  );
}

function Verdict({
  report,
  copied,
  onJump,
  onCopy,
}: {
  report: Report;
  copied: string | null;
  onJump: (t: number) => void;
  onCopy: (id: string, text: string) => void;
}) {
  return (
    <div className="rise flex flex-col gap-4">
      <div className="rounded-2xl border border-line bg-card p-5">
        <p className="text-sm text-muted">
          {report.scope === "full" ? "Первый тест ленты" : "Первый тест — только по файлу"}
        </p>
        <p className="mt-2 font-display text-5xl tabular-nums leading-none tracking-tight sm:text-6xl">
          {report.passChance}%
        </p>
        <p className="mt-3 max-w-xl">{report.summary}</p>
        <p className="mt-3 text-sm text-muted">
          Шанс выйти дальше первого показа:{" "}
          <span className="font-mono tabular-nums text-foreground">{report.wideChance}%</span>
          {report.scope === "file" ? ". Сюжет не входил в оценку, поэтому потолок занижен." : "."}
        </p>
        <dl className="mt-5 grid gap-3 sm:grid-cols-3">
          <Band label="Обычно" value={`${formatCount(report.views.usual[0])}–${formatCount(report.views.usual[1])}`} />
          <Band
            label="Если досматривают"
            value={`${formatCount(report.views.ifWatched[0])}–${formatCount(report.views.ifWatched[1])}`}
          />
          <Band label="Если пересылают" value={`до ${formatCount(report.views.ifShared)}`} />
        </dl>
        <p className="mt-4 text-sm text-muted">
          Вилка, не обещание. «Обычно» — стартовый показ в несколько сотен. Дальше число растёт, только если
          люди и правда остаются.
        </p>
        <ul className="mt-4 flex flex-wrap gap-2">
          <Chip>{report.tech.orientation}</Chip>
          <Chip>
            {report.tech.width}×{report.tech.height}
          </Chip>
          <Chip>{formatClock(report.tech.duration)}</Chip>
          <Chip>{formatBytes(report.tech.bytes)}</Chip>
        </ul>
      </div>

      <div className="rounded-2xl border border-line bg-card p-5">
        <h2 className="font-display text-2xl tracking-tight">Что поправить</h2>
        {report.fixes.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            По измеренным признакам ломать ролик не нужно. Решают досмотры после публикации.
          </p>
        ) : (
          <ol className="mt-4 flex flex-col gap-4">
            {report.fixes.map((fix) => (
              <li key={fix.id} className="border-l border-line pl-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={priorityClass(fix.priority)}>{priorityLabel(fix.priority)}</span>
                  {fix.at !== null ? (
                    <button
                      type="button"
                      onClick={() => onJump(fix.at ?? 0)}
                      className="font-mono text-sm tabular-nums text-foreground underline-offset-4 hover:underline"
                    >
                      {formatClock(fix.at)}
                    </button>
                  ) : null}
                </div>
                <p className="mt-1 font-medium">{fix.title}</p>
                <p className="mt-1 text-sm text-muted">{fix.action}</p>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="rounded-2xl border border-line bg-card p-5">
        <h2 className="font-display text-2xl tracking-tight">Описание</h2>
        {report.hookLine ? (
          <p className="mt-3 text-sm text-muted">
            Строка на экран в 0:00: <span className="text-foreground">{report.hookLine}</span>
          </p>
        ) : null}
        {report.captions.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            Описание не собрано. На кадрах нет уверенного текста, а сюжет не разобран — выдумывать подпись нельзя.
            Первой строкой напиши то, что человек вбил бы в поиск.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {report.captions.map((caption) => {
              const full = captionText(caption.text, caption.hashtags);
              const id = caption.label + caption.text;
              return (
                <li key={id} className="rounded-lg bg-elevated p-4">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm text-muted">{caption.label}</p>
                    <Button type="button" variant="outline" size="sm" onClick={() => onCopy(id, full)}>
                      {copied === id ? (
                        <Check className="size-4" aria-hidden="true" />
                      ) : (
                        <Copy className="size-4" aria-hidden="true" />
                      )}
                      {copied === id ? "Скопировано" : "Копировать"}
                    </Button>
                  </div>
                  <p className="mt-2">{caption.text}</p>
                  {caption.hashtags.length ? (
                    <p className="mt-2 font-mono text-sm text-muted">
                      {caption.hashtags.map((tag) => `#${tag}`).join(" ")}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {true ? (
        <div className="rounded-2xl border border-line bg-card p-5">
          <h2 className="font-display text-2xl tracking-tight">Анализ и продвижение</h2>
          {report.titles.length > 0 ? (
            <div className="mt-4">
              <h3 className="font-medium">Варианты названия</h3>
              <ul className="mt-2 flex flex-col gap-2">
                {report.titles.map((title, index) => (
                  <li key={index} className="flex items-center justify-between gap-3 rounded-lg bg-elevated p-3">
                    <span>{title}</span>
                    <Button type="button" variant="outline" size="sm" onClick={() => onCopy("title-" + index, title)}>
                      {copied === "title-" + index ? "Скопировано" : "Копировать"}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {report.strengths.length > 0 ? (
            <div className="mt-5">
              <h3 className="font-medium">Сильные стороны</h3>
              <ul className="mt-2 flex flex-col gap-2">
                {report.strengths.map((item, index) => (
                  <li key={index} className="text-sm text-muted">✓ {item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {report.weaknesses.length > 0 ? (
            <div className="mt-5">
              <h3 className="font-medium">Слабые стороны</h3>
              <ul className="mt-2 flex flex-col gap-2">
                {report.weaknesses.map((item, index) => (
                  <li key={index} className="text-sm text-muted">• {item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl bg-elevated p-4">
              <h3 className="font-medium">Сюжет и история · {report.storyScore}/100</h3>
              <p className="mt-2 text-sm text-muted">{report.storyNote || "Недостаточно данных для оценки сюжета."}</p>
            </div>
            <div className="rounded-xl bg-elevated p-4">
              <h3 className="font-medium">Визуальная оригинальность · {report.originalityScore}/100</h3>
              <p className="mt-2 text-sm text-muted">{report.originalityNote || "Недостаточно данных для оценки оригинальности."}</p>
            </div>
          </div>
          {report.retentionNotes.length > 0 ? (
            <div className="mt-5">
              <h3 className="font-medium">Где зритель может потерять интерес</h3>
              <ul className="mt-2 flex flex-col gap-2">
                {report.retentionNotes.map((item, index) => (
                  <li key={index} className="text-sm text-muted">• {item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {report.fixes && report.fixes.length > 0 ? (
            <div className="mt-5">
              <h3 className="font-medium">Что исправить</h3>
              <ul className="mt-2 flex flex-col gap-2">
                {report.fixes.map((item) => (
                  <li key={item.id} className="text-sm">
                    <span className="font-medium">{item.title}</span>
                    <span className="text-muted"> — {item.action}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {report.watched ? (
        <div className="rounded-2xl border border-line bg-card p-5">
          <h2 className="font-display text-2xl tracking-tight">Что видно на кадрах</h2>
          <p className="mt-3 text-sm text-muted">{report.watched}</p>
        </div>
      ) : null}

      {report.readOnFrame.length ? (
        <div className="rounded-2xl border border-line bg-card p-5">
          <h2 className="font-display text-2xl tracking-tight">Текст с кадра</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {report.readOnFrame.map((line) => (
              <li key={`${line.t}-${line.text}`} className="text-sm">
                <button
                  type="button"
                  className="font-mono tabular-nums text-muted underline-offset-4 hover:underline"
                  onClick={() => onJump(line.t)}
                >
                  {formatClock(line.t)}
                </button>
                <span className="text-foreground"> — {line.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rounded-2xl border border-line bg-card p-5">
        <h2 className="font-display text-2xl tracking-tight">Из чего оценка</h2>
        <ul className="mt-4 flex flex-col gap-3">
          {report.scores.map((score) => (
            <li key={score.id}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm">{score.label}</span>
                <span className="font-mono text-sm tabular-nums text-muted">{score.value}</span>
              </div>
              <div className="meter mt-2 h-1 overflow-hidden rounded-sm bg-elevated">
                <div className="h-full bg-paper" style={{ width: `${score.value}%` }} />
              </div>
              <p className="mt-1 text-sm text-muted">{score.note}</p>
            </li>
          ))}
        </ul>
      </div>

      <details className="rounded-2xl border border-line bg-card p-5">
        <summary className="font-medium">Как получились цифры</summary>
        <ul className="mt-3 flex flex-col gap-2">
          {report.limits.map((limit) => (
            <li key={limit} className="text-sm text-muted">
              {limit}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-muted">
          Кадры: {report.frameTimes.map((t) => formatClock(t)).join(", ") || "нет"}.
        </p>
      </details>
    </div>
  );
}

function Band({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-elevated p-3">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-1 font-mono text-sm tabular-nums">{value}</dd>
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <li className="rounded-md border border-line px-2 py-1 font-mono text-sm tabular-nums text-muted">{children}</li>
  );
}

function priorityLabel(priority: "high" | "medium" | "low") {
  if (priority === "high") return "сначала";
  if (priority === "medium") return "затем";
  return "если останется время";
}

function priorityClass(priority: "high" | "medium" | "low") {
  if (priority === "high") return "text-sm text-bad";
  if (priority === "medium") return "text-sm text-warn";
  return "text-sm text-muted";
}
