
import {
  COMPANY_SHAPES,
  type CompanyShape,
} from "@/services/onboarding/enrichment/classify-shape-stage";

const SHAPE_SET = new Set<string>(COMPANY_SHAPES);

export const SHAPE_VISIBILITY_FLAG_KEY = "shape_based_visibility";

export function coerceCompanyShape(raw: unknown): CompanyShape | null {
  const s = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  return SHAPE_SET.has(s) ? (s as CompanyShape) : null;
}

export type ShapeConstraints = {
  recommended_for_shapes?: string[];
  hidden_for_shapes?: string[];
};

export function hasShapeConstraints(c: ShapeConstraints | null | undefined): boolean {
  if (!c) return false;
  return (
    (Array.isArray(c.hidden_for_shapes) && c.hidden_for_shapes.length > 0) ||
    (Array.isArray(c.recommended_for_shapes) && c.recommended_for_shapes.length > 0)
  );
}

export function shapeMismatchHidesAgent(
  shape: CompanyShape | null,
  constraints: ShapeConstraints | null | undefined,
): boolean {
  if (!shape) return false;
  if (!constraints) return false;

  const denied = (constraints.hidden_for_shapes ?? []).map((s) =>
    s.toLowerCase().trim(),
  );
  if (denied.includes(shape)) return true;

  const rec = (constraints.recommended_for_shapes ?? []).map((s) =>
    s.toLowerCase().trim(),
  );
  if (rec.length > 0 && !rec.includes(shape)) return true;

  return false;
}
