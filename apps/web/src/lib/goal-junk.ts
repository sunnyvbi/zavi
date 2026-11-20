
const VOWEL_RE = /[aeiou]/i;

function isAllSameChar(s: string): boolean {
  const squashed = s.toLowerCase().replace(/\s+/g, "");
  return squashed.length >= 2 && new Set(squashed).size === 1;
}

export function detectGoalJunk(input: {
  objective?: string;
  target_metric?: string;
  target_value?: number;
}): string | null {
  if (input.objective !== undefined) {
    const obj = input.objective.trim();
    if (obj.length < 8) {
      return 'Objective is too short. Describe a real goal, e.g. "Grow MRR to $50k by Q3".';
    }
    if (isAllSameChar(obj)) {
      return "Objective looks like placeholder text. Write a real goal your team can work toward.";
    }
    const letters = obj.replace(/[^a-z]/gi, "");
    const hasDigits = /\d/.test(obj);
    if (!hasDigits && letters.length >= 3 && !VOWEL_RE.test(letters)) {
      return "Objective doesn't look like real words. Write a real goal your team can work toward.";
    }
  }

  if (input.target_metric !== undefined) {
    const metric = input.target_metric.trim();
    if (metric.length < 2) {
      return 'Target metric is too short. Name a measurable metric, e.g. "mrr" or "signups".';
    }
    if (isAllSameChar(metric)) {
      return 'Target metric looks like placeholder text. Name a measurable metric, e.g. "mrr" or "signups".';
    }
  }

  if (input.target_value !== undefined) {
    if (!Number.isFinite(input.target_value) || input.target_value <= 0) {
      return "Target value must be a number greater than zero.";
    }
  }

  return null;
}
