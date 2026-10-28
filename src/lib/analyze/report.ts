import type {
  Caption,
  Fix,
  MeasuredVideo,
  ModelFacts,
  OcrWord,
  Report,
  ScoreRow,
} from "./types.ts";

const BANNED_TAGS = new Set([
  "fyp",
  "foryou",
  "foryoupage",
  "viral",
  "xyzbca",
  "tiktok",
  "trending",
  "тренд",
  "рек",
  "реки",
  "рекомендации",
  "длятебя",
  "врек",
]);

const STOP = new Set(
  "и в во не что это как на но а то с по из у за от до для о об при же ли бы уже ещё вот там тут мой моя моё твой твои его ее её их мы вы они ты я быть был была есть нет да или если когда где кто чем под над без между через про все всё свой своя свои этот эта эти тот та те так очень просто можно нужно надо видео ролик смотри смотрите конец the a an of to and for in on with your you this that how what why".split(
    " ",
  ),
);

export type OcrRead = {
  readable: boolean;
  lines: { t: number; text: string; confidence: number; danger: boolean }[];
  danger: boolean;
};

export function interpretOcr(words: OcrWord[]): OcrRead {
  const good = words.filter((word) => {
    const text = word.text.trim();
    return word.confidence >= 64 && /^[\p{L}\p{N}][\p{L}\p{N}'’-]{1,}$/u.test(text);
  });

  type Line = {
    t: number;
    y: number;
    words: OcrWord[];
    text: string;
    confidence: number;
    danger: boolean;
  };
  const lines: Line[] = [];
  for (const word of [...good].sort((a, b) => a.t - b.t || a.y - b.y || a.x - b.x)) {
    const line = lines.find((item) => item.t === word.t && Math.abs(item.y - word.y) < 0.05);
    if (line) line.words.push(word);
    else lines.push({ t: word.t, y: word.y, words: [word], text: "", confidence: 0, danger: false });
  }

  const usable: OcrRead["lines"] = [];
  for (const line of lines) {
    line.words.sort((a, b) => a.x - b.x);
    line.text = line.words.map((word) => word.text.trim()).join(" ");
    line.confidence = line.words.reduce((sum, word) => sum + word.confidence, 0) / line.words.length;
    const tokens = line.text.split(/\s+/).filter(Boolean);
    const longEnough =
      (tokens.length >= 2 && line.text.length >= 8 && line.confidence >= 68) ||
      (tokens.length === 1 && tokens[0].length >= 5 && line.confidence >= 80);
    if (!longEnough) continue;
    const covered = line.words.filter((word) => word.y > 0.78 || word.y < 0.08 || word.x > 0.84).length;
    line.danger = covered >= Math.ceil(line.words.length * 0.6);
    usable.push({
      t: line.t,
      text: line.text,
      confidence: line.confidence,
      danger: line.danger,
    });
  }

  return {
    readable: usable.length > 0,
    lines: usable.slice(0, 4),
    danger: usable.some((line) => line.danger),
  };
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function logistic(x: number, mid: number, k: number) {
  return 1 / (1 + Math.exp(-k * (x - mid)));
}

function nice(n: number): number {
  const x = Math.max(0, n);
  const step = x < 400 ? 10 : x < 2000 ? 50 : x < 10_000 ? 100 : x < 100_000 ? 500 : x < 1_000_000 ? 5000 : 50_000;
  return Math.round(x / step) * step;
}

function orientation(width: number, height: number) {
  const ratio = width / Math.max(1, height);
  if (ratio >= 0.5 && ratio <= 0.66) return "вертикаль 9:16";
  if (ratio <= 0.92) return "вертикаль не 9:16";
  if (ratio <= 1.12) return "квадрат";
  return "горизонталь";
}

function formatScore(width: number, height: number) {
  const ratio = width / Math.max(1, height);
  let score = 20;
  if (ratio >= 0.5 && ratio <= 0.66) score = 96;
  else if (ratio <= 0.78) score = 78;
  else if (ratio <= 0.92) score = 64;
  else if (ratio <= 1.12) score = 52;
  const short = Math.min(width, height);
  if (short < 480) score -= 26;
  else if (short < 720) score -= 12;
  return clamp(score, 6, 98);
}

function durationScore(duration: number, loop: number) {
  if (duration < 2) return 28;
  if (duration < 5) return loop > 0.75 ? 70 : 46;
  if (duration <= 25) return 88;
  if (duration <= 45) return 80;
  if (duration <= 90) return 72;
  if (duration <= 180) return 64;
  return 54;
}

function measuredHook(video: MeasuredVideo) {
  let score = 62;
  if (video.motionFirst3s >= 14) score += 16;
  else if (video.motionFirst3s >= 6) score += 6;
  else score -= 12;
  if (video.stillOpening) score -= 14;
  if (video.blackOpening) score -= 28;
  if (video.brightnessStart < 28) score -= 8;
  if (video.audio.decoded) {
    if (!video.audio.hasSignal) score -= 8;
    else if (video.audio.silenceStartMs <= 160) score += 6;
    else if (video.audio.silenceStartMs > 600) score -= 12;
  }
  return clamp(score, 8, 93);
}

function pacingScore(video: MeasuredVideo) {
  let score = 76;
  const dead = video.deadZones.filter((zone) => zone.end - zone.start >= 2.8);
  score -= Math.min(28, dead.length * 12);
  if (video.duration >= 15 && video.cutsPer10s < 0.35 && video.motionFirst3s < 5) score -= 14;
  if (video.duration > 55 && video.cutsPer10s < 0.7) score -= 10;
  if (video.duration <= 40 && video.cutsPer10s > 8) score -= 6;
  return clamp(score, 10, 96);
}

function audioScore(video: MeasuredVideo) {
  const audio = video.audio;
  if (!audio.decoded) return 56;
  if (!audio.hasSignal) return 30;
  let score = 80;
  if (audio.silenceStartMs > 700) score -= 20;
  else if (audio.silenceStartMs > 350) score -= 10;
  if (audio.quiet) score -= 10;
  if (audio.flat) score -= 6;
  if (audio.clippedRatio > 0.008) score -= 12;
  return clamp(score, 8, 95);
}

function loopScore(similarity: number, duration: number) {
  if (duration <= 22) {
    if (similarity > 0.82) return 90;
    if (similarity > 0.68) return 74;
    return 48;
  }
  if (similarity > 0.9) return 70;
  return 58;
}

function clock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function hashtagsFrom(raw: string[], max = 4) {
  const out: string[] = [];
  for (const item of raw) {
    const tag = item.replace(/^#+/u, "").replace(/[^\p{L}\p{N}_]/gu, "");
    const key = tag.toLocaleLowerCase("ru");
    if (tag.length < 3 || tag.length > 28 || BANNED_TAGS.has(key)) continue;
    if (out.some((have) => have.toLocaleLowerCase("ru") === key)) continue;
    out.push(tag.toLocaleLowerCase("ru"));
    if (out.length >= max) break;
  }
  return out;
}

function stripEmoji(text: string) {
  return text.replace(/\p{Extended_Pictographic}/gu, "").replace(/\s+/g, " ").trim();
}

function kbps(video: MeasuredVideo) {
  if (video.duration <= 0) return 0;
  return (video.bytes * 8) / video.duration / 1000;
}

function fileFixes(video: MeasuredVideo): Fix[] {
  const fixes: Fix[] = [];
  const ratio = video.width / Math.max(1, video.height);
  const push = (fix: Omit<Fix, "id">) => fixes.push({ ...fix, id: `file-${fixes.length}` });

  if (ratio > 1.12) {
    push({
      priority: "high",
      at: 0,
      title: "Кадр горизонтальный",
      action: `Сейчас ${video.width}×${video.height}. Обрежь до 9:16, например 1080×1920. В ленте горизонтальный ролик выходит с полями, и его чаще пролистывают на первом же показе.`,
    });
  } else if (ratio > 0.7) {
    push({
      priority: "medium",
      at: 0,
      title: "Не полный вертикальный кадр",
      action: `Сейчас ${video.width}×${video.height}. Для ленты нужен 9:16: иначе сверху и снизу будут полосы или кадр обрежется сам.`,
    });
  }

  const short = Math.min(video.width, video.height);
  if (short < 720) {
    push({
      priority: "medium",
      at: 0,
      title: "Мало деталей в кадре",
      action: `Короткая сторона ${short}px. Пересохрани хотя бы в 720px по короткой стороне, лучше 1080×1920. На телефоне мыло выглядит как чужой перезалив.`,
    });
  }

  const rate = kbps(video);
  if (short >= 720 && rate > 0 && rate < 900) {
    push({
      priority: "low",
      at: null,
      title: "Сильное сжатие",
      action: `Поток около ${Math.round(rate)} кбит/с. Картинка будет мыльной. Экспортируй заново в 1080×1920, не через «переслать в мессенджер».`,
    });
  }

  if (video.blackOpening) {
    push({
      priority: "high",
      at: 0,
      title: "Чёрное начало",
      action:
        "Первые кадры почти чёрные. Вырежи заставку и логотип: человек решает остаться меньше чем за секунду и не дождётся, пока появится картинка.",
    });
  } else if (video.stillOpening) {
    push({
      priority: "high",
      at: 0,
      title: "Первая секунда стоит",
      action:
        "В первую секунду кадр почти не меняется. Начни с уже идущего действия или сразу поставь короткую строку, о чём ролик. Пустой первый кадр на тестовом показе пролистывают.",
    });
  }

  if (video.audio.decoded && video.audio.hasSignal && video.audio.silenceStartMs > 400) {
    const sec = (video.audio.silenceStartMs / 1000).toFixed(1).replace(".", ",");
    push({
      priority: "high",
      at: 0,
      title: "Тишина в начале",
      action: `Первые ${sec} с без звука. Запусти голос или музыку с первого кадра: тишину на тесте часто принимают за зависшее видео.`,
    });
  }

  if (video.audio.decoded && !video.audio.hasSignal) {
    push({
      priority: "medium",
      at: 0,
      title: "Нет слышимого звука",
      action:
        "В файле тишина. Если так задумано, на кадре с первой секунды должен быть текст. Иначе добавь голос или музыку: без звука и без текста ролик не за что зацепиться.",
    });
  } else if (video.audio.decoded && video.audio.quiet) {
    push({
      priority: "low",
      at: null,
      title: "Слишком тихо",
      action: "Дорожка тихая. Подними голос: ленту часто смотрят с телефона на улице, и тихую речь перелистывают.",
    });
  }

  if (video.audio.decoded && video.audio.clippedRatio > 0.008) {
    push({
      priority: "low",
      at: null,
      title: "Звук перегружен",
      action: "Дорожка клиппует и хрипит. Убавь громкость примерно на 3 дБ и экспортируй ещё раз.",
    });
  }

  for (const zone of video.deadZones.slice(0, 2)) {
    const span = zone.end - zone.start;
    push({
      priority: span >= 4 ? "high" : "medium",
      at: zone.start,
      title: "Кадр замирает",
      action: `С ${clock(zone.start)} по ${clock(zone.end)} картинка почти не меняется. Если там нет новой мысли — вырежи. Если человек говорит, добавь склейку, медленный зум или строку текста, чтобы этот кусок не выглядел застывшим.`,
    });
  }

  if (video.duration < 4 && video.loopSimilarity < 0.7) {
    push({
      priority: "medium",
      at: Math.max(0, video.duration - 0.3),
      title: "Слишком короткий обрыв",
      action:
        "Ролик короче 4 секунд и не зациклен. Его успевают досмотреть, но смотреть почти нечего. Либо доведи мысль хотя бы до 7–15 секунд, либо склей конец с началом.",
    });
  } else if (video.duration <= 20 && video.loopSimilarity < 0.55) {
    push({
      priority: "low",
      at: Math.max(0, video.duration - 0.4),
      title: "Конец не стыкуется с началом",
      action:
        "Для ролика короче 20 секунд петля даёт повторные просмотры, а повтор весит больше лайка. Обрежь так, чтобы последнее движение продолжалось первым кадром.",
    });
  }

  if (video.duration > 70 && video.cutsPer10s < 1) {
    push({
      priority: "medium",
      at: null,
      title: "Длинно и без смены кадра",
      action: `Ролик ${clock(video.duration)}, склеек мало. Длина сама по себе не мешает, но недосмотр на длинном ролике останавливает раздачу. Оставь только то, без чего мысль разваливается.`,
    });
  }

  return fixes;
}

function textFixes(video: MeasuredVideo, ocr: OcrRead): Fix[] {
  if (!ocr.readable) {
    if (video.duration < 6 && video.motionFirst3s >= 14) return [];
    return [
      {
        id: "text-missing",
        priority: "medium",
        at: 0,
        title: "Нет строки в кадре",
        action:
          "На просмотренных кадрах нет уверенно читаемого текста. Добавь на 0:00 одну короткую фразу, по которой ролик ищут, и поставь её между верхней и нижней четвертью — не на низ и не к правым кнопкам.",
      },
    ];
  }
  if (!ocr.danger) return [];
  const line = ocr.lines.find((item) => item.danger) ?? ocr.lines[0];
  return [
    {
      id: "text-zone",
      priority: "high",
      at: line.t,
      title: "Текст закроет интерфейс",
      action: `Строка «${line.text}» попадает в зону описания, шапки или кнопок. Подними её ближе к центру: снизу лента закрывает примерно пятую часть кадра, справа — колонку лайков.`,
    },
  ];
}

function captionsFromOcr(ocr: OcrRead): Caption[] {
  if (!ocr.readable) return [];
  const line = [...ocr.lines].sort((a, b) => b.confidence * Math.min(b.text.length, 42) - a.confidence * Math.min(a.text.length, 42))[0];
  const text = stripEmoji(line.text);
  if (text.length < 8) return [];
  const tags = hashtagsFrom(
    text
      .split(/\s+/)
      .map((token) => token.toLocaleLowerCase("ru"))
      .filter((token) => token.length >= 4 && !STOP.has(token)),
    3,
  );
  return [
    {
      label: "текст с кадра",
      text: text.length > 90 ? `${text.slice(0, 87).trim()}…` : text,
      hashtags: tags.length >= 2 ? tags : [],
    },
  ];
}

function captionsFromModel(model: ModelFacts): Caption[] {
  const out: Caption[] = [];
  for (const caption of model.captions) {
    const text = stripEmoji(caption.text);
    if (text.length < 8) continue;
    out.push({
      label: caption.label.trim() || "описание",
      text: text.slice(0, 180),
      hashtags: hashtagsFrom(caption.hashtags, 4),
    });
    if (out.length >= 3) break;
  }
  return out;
}

function overlaps(action: string, existing: Fix[]) {
  const keys = ["9:16", "горизонт", "водян", "тишин", "чёрн", "черн", "замира", "пауз"];
  const hay = action.toLowerCase();
  return existing.some((fix) => {
    const have = `${fix.title} ${fix.action}`.toLowerCase();
    return keys.some((key) => hay.includes(key) && have.includes(key));
  });
}

function summaryOf(video: MeasuredVideo, pass: number, contentKnown: boolean, fixes: Fix[]) {
  const ratio = video.width / Math.max(1, video.height);
  if (ratio > 1.12) {
    return "Ролик горизонтальный. В ленте он выйдет с полями, и первый тест обычно на этом заканчивается.";
  }
  if (video.blackOpening) {
    return "Начало почти чёрное. До картины человек уже решит листать дальше.";
  }
  if (video.stillOpening) {
    return "Первые секунды стоят на месте. На тестовом показе такое чаще пролистывают, чем досматривают.";
  }
  const top = fixes.find((fix) => fix.priority === "high");
  if (top) return top.action.split(". ")[0] + ".";
  if (pass >= 68 && !contentKnown) {
    return "По технике ролик можно отдавать на первый тест. Идею мы не оценивали — от неё зависит, пойдёт ли он дальше нескольких сотен просмотров.";
  }
  if (pass >= 68) {
    return "Формат и начало в порядке. Дальше решают досмотры живых людей, не этот разбор.";
  }
  if (pass >= 45) {
    return "Первый показ, скорее всего, будет. Широкая лента маловероятна, пока не закрыты замечания.";
  }
  return "В текущем виде ролик, скорее всего, останется на первом тесте. Сначала правки, потом публикация.";
}

export function buildReport(
  video: MeasuredVideo,
  words: OcrWord[],
  model: ModelFacts | null,
): Report {
  const ocr = interpretOcr(words);
  const format = formatScore(video.width, video.height);
  const duration = durationScore(video.duration, video.loopSimilarity);
  const pacing = pacingScore(video);
  const audio = audioScore(video);
  const loopMeasured = loopScore(video.loopSimilarity, video.duration);
  let hookMeasured = measuredHook(video);
  if (!model) {
    const early = ocr.lines.some((line) => line.t <= 2.8);
    if (early && !ocr.danger) hookMeasured += 6;
    else if (early && ocr.danger) hookMeasured -= 4;
    else if (!ocr.readable && video.duration >= 10) hookMeasured -= 3;
  }
  hookMeasured = clamp(hookMeasured, 5, 96);

  const hook = model ? clamp(0.4 * hookMeasured + 0.6 * model.hookScore, 5, 96) : hookMeasured;
  const payoff = model ? model.payoffScore : 50;
  const clarity = model ? model.clarityScore : ocr.readable ? 62 : 48;
  const loop = model ? clamp(0.45 * loopMeasured + 0.55 * model.loopScore, 0, 100) : loopMeasured;
  const contentKnown = model !== null;
  const landscape = video.width / Math.max(1, video.height) > 1.12;
  const watermarkOther = model?.watermark === "other";

  const retention = clamp(0.46 * hook + 0.24 * pacing + 0.14 * duration + 0.16 * audio, 0, 100);
  const quality = clamp(
    0.3 * hook + 0.16 * pacing + 0.08 * duration + 0.1 * audio + 0.14 * format + 0.12 * payoff + 0.1 * clarity,
    0,
    100,
  );

  let pass = clamp(logistic(retention, 56, 0.085), 0.08, 0.84);
  let wide = logistic(quality, 71, 0.09) * pass;
  if (!contentKnown) wide *= 0.7;
  if (landscape) {
    pass = Math.min(pass, 0.3);
    wide = Math.min(wide, 0.07);
  }
  if (watermarkOther) {
    pass = Math.min(pass, 0.34);
    wide = Math.min(wide, 0.05);
  }
  if (video.duration < 3.2) pass = Math.min(pass, 0.42);
  wide = clamp(wide, 0.02, 0.48);

  const testMid = 260 + pass * 520;
  const usualLow = nice(testMid * 0.55);
  const usualHigh = Math.max(usualLow + 50, nice(testMid * (1.15 + retention / 180)));
  const lift = Math.pow(10, clamp((retention - 58) / 26, -0.45, 1.15));
  const watchedLow = Math.max(usualHigh, nice(Math.max(usualHigh * 1.15, usualHigh * lift * 0.45)));
  const watchedHigh = Math.max(watchedLow + 100, nice(Math.max(usualHigh * 1.8, usualHigh * lift * 1.35)));
  let shared = nice(watchedHigh * (2.2 + clarity / 70));
  const exceptional = quality > 86 && retention > 84 && contentKnown && !landscape && !watermarkOther;
  shared = Math.min(shared, exceptional ? 900_000 : 180_000);
  if (landscape || watermarkOther) shared = Math.min(shared, nice(watchedHigh * 1.5));
  shared = Math.max(watchedHigh, shared);

  const fixes = [...fileFixes(video), ...textFixes(video, ocr)];
  if (model) {
    if (watermarkOther && !fixes.some((fix) => /водян|знак/i.test(`${fix.title} ${fix.action}`))) {
      fixes.unshift({
        id: "watermark",
        priority: "high",
        at: 0,
        title: "Чужой водяной знак",
        action:
          "На кадрах знак другой площадки. Такие ролики TikTok часто не берёт в рекомендации. Убери знак и оставь свою склейку, а не чужой перезалив.",
      });
    }
    for (const fix of model.fixes) {
      const action = stripEmoji(fix.action);
      const title = stripEmoji(fix.title);
      if (action.length < 12 || title.length < 3) continue;
      if (overlaps(action, fixes)) continue;
      const at = fix.at === null || !Number.isFinite(fix.at) ? null : clamp(fix.at, 0, video.duration);
      fixes.push({
        id: `model-${fixes.length}`,
        priority: fix.priority,
        at,
        title: title.slice(0, 80),
        action: action.slice(0, 320),
      });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  fixes.sort((a, b) => rank[a.priority] - rank[b.priority]);
  const kept = fixes.slice(0, 7);

  const captions = model ? captionsFromModel(model) : captionsFromOcr(ocr);
  if (model && captions.length === 0) captions.push(...captionsFromOcr(ocr));

  const scores: ScoreRow[] = [
    {
      id: "hook",
      label: "Первые 3 секунды",
      value: Math.round(hook),
      note: video.blackOpening
        ? "Начало слишком тёмное."
        : video.stillOpening
          ? "Первая секунда почти без изменений."
          : video.motionFirst3s >= 10
            ? "В начале есть движение."
            : "Движения в начале мало.",
    },
    {
      id: "format",
      label: "Формат",
      value: Math.round(format),
      note: `${video.width}×${video.height}, ${orientation(video.width, video.height)}.`,
    },
    {
      id: "pacing",
      label: "Темп",
      value: Math.round(pacing),
      note: video.deadZones.length
        ? `Есть замирание около ${clock(video.deadZones[0].start)}.`
        : video.cutCount
          ? `Смен кадра: ${video.cutCount}.`
          : "Резких склеек мало — это нормально, если в кадре есть движение.",
    },
    {
      id: "audio",
      label: "Звук",
      value: Math.round(audio),
      note: !video.audio.decoded
        ? "Дорожку целиком прочитать не удалось."
        : !video.audio.hasSignal
          ? "Слышимого звука нет."
          : video.audio.silenceStartMs > 350
            ? `Тишина в начале ${Math.round(video.audio.silenceStartMs)} мс.`
            : "Звук начинается вместе с кадром.",
    },
    {
      id: "loop",
      label: "Петля и финал",
      value: Math.round(loop),
      note: model?.loopNote || (video.loopSimilarity > 0.8 && video.duration <= 22
        ? "Конец похож на начало — повторы вероятнее."
        : "Похожесть первого и последнего кадра слабая."),
    },
  ];

  const limits = [
    "Это не доступ к алгоритму TikTok и не обещание просмотров. Платформа решает по тому, как ролик досматривают живые люди.",
    "«Обычно» — первый тестовый показ. TikTok описывает его как небольшую стартовую аудиторию и не публикует точное число. Ориентир, которым пользуются авторы, — несколько сотен.",
    "«Если досматривают» — вилка на случай, если удержание совпадёт с оценкой начала. «Если пересылают» — редкий хвост, не прогноз.",
    "Число подписчиков TikTok прямо не учитывает. Одна и та же вилка для нового и большого аккаунта: дальше её двигает поведение зрителей.",
    "Трендовость звука по файлу не видна. Её показывает только TikTok в момент загрузки.",
  ];
  if (!contentKnown) {
    limits.unshift(
      "Сюжет, лица и шутка не оценивались. Число ниже — только техника файла и текст, который удалось прочитать. Описание не выдумано.",
    );
  } else {
    limits.push("Сюжет описан по отдельным кадрам, не по сплошному видео. Речь, если её не написали на экране, не слышна.");
  }
  if (ocr.readable) {
    limits.push("Текст снят с кадров распознаванием. На пёстром фоне цитата может ошибаться — сверь её с роликом.");
  }
  if (video.audio.partial) limits.push("Громкость оценена по первой минуте.");

  return {
    passChance: Math.round(pass * 100),
    wideChance: Math.round(wide * 100),
    scope: contentKnown ? "full" : "file",
    views: {
      usual: [usualLow, usualHigh],
      ifWatched: [watchedLow, watchedHigh],
      ifShared: shared,
    },
    scores,
    fixes: kept,
    captions,
    watched: model?.watched ?? null,
    hookLine: model?.suggestedHookLine || null,
    readOnFrame: ocr.lines.map((line) => ({ t: line.t, text: line.text })),
    frameTimes: video.frameTimes,
    summary: summaryOf(video, Math.round(pass * 100), contentKnown, kept),
    limits,
    tech: {
      width: video.width,
      height: video.height,
      duration: video.duration,
      bytes: video.bytes,
      orientation: orientation(video.width, video.height),
      fileName: video.fileName,
    },
  };
}

export function formatClock(seconds: number) {
  return clock(seconds);
}

export function formatCount(n: number) {
  if (n >= 1_000_000) {
    const value = n / 1_000_000;
    const digits = value >= 10 ? 0 : 1;
    return `${value.toLocaleString("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: digits })} млн`;
  }
  if (n >= 10_000) return `${Math.round(n / 1000).toLocaleString("ru-RU")} тыс.`;
  if (n >= 1000) {
    const value = n / 1000;
    return `${value.toLocaleString("ru-RU", { maximumFractionDigits: 1, minimumFractionDigits: value < 10 ? 1 : 0 })} тыс.`;
  }
  return Math.round(n).toLocaleString("ru-RU");
}
