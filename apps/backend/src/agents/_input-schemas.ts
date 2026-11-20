
import type { ZodTypeAny } from "zod";
import { ctoShipPrPayloadSchema } from "./engineer/input-contract";
import { productPmInputSchema } from "./pm/input-contract";

export const inputSchemas: Record<string, ZodTypeAny> = {
  "engineer": ctoShipPrPayloadSchema,
  "pm": productPmInputSchema,
};

export type InputValidationResult =
  | { ok: true; payload: unknown }
  | { ok: false; error: { code: string; message: string; path?: (string | number)[] } };

export function validateAgentPayload(slug: string, payload: unknown): InputValidationResult {
  const schema = inputSchemas[slug];
  if (!schema) {
    return { ok: true, payload: payload ?? {} };
  }
  const parsed = schema.safeParse(payload ?? {});
  if (parsed.success) {
    return { ok: true, payload: parsed.data };
  }
  const first = parsed.error.issues[0];
  const path = first?.path?.map((seg) =>
    typeof seg === "symbol" ? seg.toString() : seg,
  );
  return {
    ok: false,
    error: {
      code: "input_invalid",
      message: first?.message ?? "input failed validation",
      path,
    },
  };
}
