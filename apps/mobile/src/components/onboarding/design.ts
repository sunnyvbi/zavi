
export const layout = {
  navHeight: 57,
  navPaddingH: 16,
  backSize: 44,
  trackPaddingH: 16,
  trackGap: 5,
  trackHeight: 3,
  bodyPaddingH: 16,
  bodyPaddingTop: 20,
  bodyPaddingBottom: 20,
  footerPaddingH: 16,
  footerPaddingTop: 12,
  footerPaddingBottom: 8,
} as const;

export const type = {
  h1Size: 31,
  h1Line: 35,
  h1Spacing: -1.2,
  subSize: 14,
  subLine: 21,
  labelSize: 12,
  inputSize: 16,
  buttonSize: 15,
  hintSize: 11,
  hintLine: 17,
  textButtonSize: 13,
} as const;

export const control = {
  inputHeight: 48,
  inputRadius: 15,
  textareaHeight: 95,
  buttonHeight: 53,
  buttonRadius: 30,
} as const;

export const PHASES = [
  "Your workspace",
  "Business details",
  "Your priority",
  "Competitors",
  "Notifications",
] as const;

export const TOTAL_STEPS = PHASES.length;
