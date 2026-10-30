export type AudioFacts = {
  decoded: boolean;
  hasSignal: boolean;
  silenceStartMs: number;
  clippedRatio: number;
  quiet: boolean;
  flat: boolean;
  partial: boolean;
};

export type DeadZone = { start: number; end: number };

export type MeasuredVideo = {
  fileName: string;
  bytes: number;
  duration: number;
  width: number;
  height: number;
  brightnessStart: number;
  motionFirst3s: number;
  stillOpening: boolean;
  blackOpening: boolean;
  cutCount: number;
  cutsPer10s: number;
  deadZones: DeadZone[];
  loopSimilarity: number;
  audio: AudioFacts;
  frameTimes: number[];
};

export type OcrWord = {
  t: number;
  text: string;
  confidence: number;
  x: number;
  y: number;
};

export type ModelFix = {
  priority: "high" | "medium" | "low";
  at: number | null;
  title: string;
  action: string;
};

export type ModelCaption = {
  label: string;
  text: string;
  hashtags: string[];
};

export type ModelFacts = {
  watched: string;
  topic: string;
  hookScore: number;
  hookProblem: string | null;
  payoffScore: number;
  payoffNote: string;
  loopScore: number;
  loopNote: string;
  clarityScore: number;
  storyScore: number;
  storyNote: string;
  originalityScore: number;
  originalityNote: string;
  shadowbanScore: number;
  shadowbanReasons: string[];
  retentionNotes: string[];
  searchPhrases: string[];
  watermark: "none" | "tiktok" | "other" | "unsure";
  suggestedHookLine: string;
  titles: string[];
  strengths: string[];
  weaknesses: string[];
  fixes: ModelFix[];
  captions: ModelCaption[];
};

export type WatchResult =
  | { ok: true; model: ModelFacts }
  | { ok: false; error: "unavailable" | "credits" | "failed" };

export type Fix = {
  id: string;
  priority: "high" | "medium" | "low";
  at: number | null;
  title: string;
  action: string;
};

export type Caption = {
  label: string;
  text: string;
  hashtags: string[];
};

export type ScoreRow = {
  id: string;
  label: string;
  value: number;
  note: string;
};

export type Report = {
  passChance: number;
  wideChance: number;
  scope: "file" | "full";
  views: {
    usual: [number, number];
    ifWatched: [number, number];
    ifShared: number;
  };
  scores: ScoreRow[];
  fixes: Fix[];
  captions: Caption[];
  watched: string | null;
  hookLine: string | null;
  titles: string[];
  strengths: string[];
  weaknesses: string[];
  storyScore: number;
  storyNote: string;
  originalityScore: number;
  originalityNote: string;
  shadowbanScore: number;
  shadowbanReasons: string[];
  retentionNotes: string[];
  readOnFrame: { t: number; text: string }[];
  frameTimes: number[];
  summary: string;
  limits: string[];
  tech: {
    width: number;
    height: number;
    duration: number;
    bytes: number;
    orientation: string;
    fileName: string;
  };
};

export type ShadowbanRisk = {
  score: number;
  reasons: string[];
};
