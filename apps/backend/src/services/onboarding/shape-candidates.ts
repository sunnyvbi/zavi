export type ShapeCandidate =
  | { kind: "operator"; shape: unknown }
  | { kind: "inferred"; shape: unknown; confidence: unknown };

export function metaShapeCandidates(onboardingMeta: unknown): ShapeCandidate[] {
  const meta = (onboardingMeta ?? {}) as Record<string, unknown>;
  const scan = meta.scan;
  if (scan && typeof scan === "object") {
    const s = scan as Record<string, unknown>;
    return s.inferredShape === undefined || s.inferredShape === null
      ? []
      : [{ kind: "inferred", shape: s.inferredShape, confidence: s.shapeConfidence }];
  }
  const metaWizard = (meta.wizard ?? {}) as Record<string, unknown>;
  return metaWizard.marketplaceShape !== undefined
    ? [{ kind: "operator", shape: metaWizard.marketplaceShape }]
    : [];
}
