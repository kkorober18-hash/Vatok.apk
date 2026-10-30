import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeSamples, samplePlan } from "./signals.ts";
import { buildReport, interpretOcr } from "./report.ts";
import type { MeasuredVideo, ModelFacts } from "./types.ts";

function video(patch: Partial<MeasuredVideo> = {}): MeasuredVideo {
  return {
    fileName: "draft.mp4",
    bytes: 8_000_000,
    duration: 18,
    width: 1080,
    height: 1920,
    brightnessStart: 120,
    motionFirst3s: 16,
    stillOpening: false,
    blackOpening: false,
    cutCount: 4,
    cutsPer10s: 2.2,
    deadZones: [],
    loopSimilarity: 0.84,
    audio: {
      decoded: true,
      hasSignal: true,
      silenceStartMs: 40,
      clippedRatio: 0,
      quiet: false,
      flat: false,
      partial: false,
    },
    frameTimes: [0.1, 1.2, 3, 9, 17.5],
    ...patch,
  };
}

describe("sample plan", () => {
  it("keeps a short video inside its duration and uploads at most 8 frames", () => {
    const plan = samplePlan(12);
    assert.ok(plan.length >= 4);
    assert.ok(plan.every((point) => point.t >= 0 && point.t <= 12));
    assert.ok(plan.filter((point) => point.upload).length <= 8);
    assert.equal(plan[0].upload, true);
    assert.equal(plan[plan.length - 1].upload, true);
  });

  it("does not sample a long video forever", () => {
    const plan = samplePlan(180);
    assert.ok(plan.length <= 34);
    assert.ok(plan[plan.length - 1].t > 170);
  });
});

describe("timeline", () => {
  it("flags a frozen stretch and a black open", () => {
    const timeline = analyzeSamples(8, [
      { t: 0.1, brightness: 8, delta: 0 },
      { t: 0.6, brightness: 10, delta: 1 },
      { t: 1.2, brightness: 40, delta: 1 },
      { t: 2.2, brightness: 40, delta: 1 },
      { t: 4.2, brightness: 40, delta: 1.2 },
      { t: 5, brightness: 90, delta: 40 },
    ]);
    assert.equal(timeline.blackOpening, true);
    assert.equal(timeline.deadZones.length, 1);
    assert.ok(timeline.cutCount >= 1);
  });
});

describe("report", () => {
  it("rates a clean vertical clip above a landscape one without inventing a caption", () => {
    const good = buildReport(video(), [], null);
    const wide = buildReport(video({ width: 1920, height: 1080 }), [], null);
    assert.ok(good.passChance > wide.passChance);
    assert.ok(good.passChance >= 55);
    assert.ok(wide.passChance <= 30);
    assert.ok(wide.wideChance <= 7);
    assert.ok(good.views.usual[1] < 8_000);
    assert.ok(good.views.ifWatched[1] >= good.views.usual[1]);
    assert.ok(good.views.ifShared >= good.views.ifWatched[1]);
    assert.equal(good.captions.length, 0);
    assert.ok(good.fixes.some((fix) => /текст/i.test(fix.title + fix.action)) || good.limits.length > 0);
    assert.ok(wide.fixes.some((fix) => /9:16|горизонт/i.test(fix.title + fix.action)));
    assert.match(good.summary + good.limits.join(" "), /не оценивал|только по файлу|сюжет/i);
  });

  it("uses readable on-screen text as the caption and rejects junk tags", () => {
    const read = interpretOcr([
      { t: 0.4, text: "Как", confidence: 90, x: 0.4, y: 0.4 },
      { t: 0.4, text: "собрать", confidence: 88, x: 0.5, y: 0.4 },
      { t: 0.4, text: "шкаф", confidence: 91, x: 0.62, y: 0.4 },
      { t: 0.4, text: "fyp", confidence: 99, x: 0.7, y: 0.4 },
    ]);
    assert.equal(read.readable, true);
    const report = buildReport(video(), [
      { t: 0.4, text: "Как", confidence: 90, x: 0.4, y: 0.4 },
      { t: 0.4, text: "собрать", confidence: 88, x: 0.5, y: 0.4 },
      { t: 0.4, text: "шкаф", confidence: 91, x: 0.62, y: 0.4 },
    ], null);
    assert.ok(report.captions[0]?.text.toLowerCase().includes("шкаф"));
    assert.ok(report.captions.every((caption) => caption.hashtags.every((tag) => tag !== "fyp")));
  });

  it("caps reach when the model sees another platform's watermark", () => {
    const model: ModelFacts = {
      watched: "Человек показывает собранный шкаф на кухне, в углу чужой знак.",
      topic: "сборка шкафа",
      hookScore: 80,
      hookProblem: null,
      payoffScore: 70,
      payoffNote: "шкаф собран к концу",
      loopScore: 40,
      loopNote: "конец не стыкуется",
      clarityScore: 84,
      searchPhrases: ["сборка шкафа"],
      watermark: "other",
      suggestedHookLine: "Собрала шкаф за вечер",
    titles: [],
    strengths: [],
    weaknesses: [],
      fixes: [],
      captions: [
        { label: "для поиска", text: "Как собрать шкаф за один вечер без мастера", hashtags: ["шкаф", "fyp", "сборкамебели"] },
      ],
    };
    const report = buildReport(video(), [], model);
    assert.ok(report.wideChance <= 5);
    assert.ok(report.fixes.some((fix) => /водян|знак/i.test(fix.title + fix.action)));
    assert.equal(report.captions[0]?.hashtags.includes("fyp"), false);
    assert.ok(report.watched?.includes("шкаф"));
  });
});
