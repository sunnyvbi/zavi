export const PAST_WORK_DEMO_SEQUENCE = [
  { phase: "prompt", duration: 1800 },
  { phase: "copied", duration: 1000 },
  { phase: "generating", duration: 1400 },
  { phase: "generated", duration: 2200 },
  { phase: "downloaded", duration: 1400 },
  { phase: "upload", duration: 1400 },
  { phase: "dropping", duration: 1200 },
  { phase: "ready", duration: 1800 },
  { phase: "adding", duration: 1400 },
  { phase: "saved", duration: 2800 },
] as const;

export type PastWorkDemoPhase = (typeof PAST_WORK_DEMO_SEQUENCE)[number]["phase"];
