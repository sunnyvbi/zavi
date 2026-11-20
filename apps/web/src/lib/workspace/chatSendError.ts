
export function parseSendError(text: string): {
  code: string | null;
  message: string | null;
  required_tier: string | null;
} {
  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: string; message?: string; required_tier?: unknown };
    };
    return {
      code: parsed?.error?.code ?? null,
      message: typeof parsed?.error?.message === "string" ? parsed.error.message : null,
      required_tier:
        typeof parsed?.error?.required_tier === "string" ? parsed.error.required_tier : null,
    };
  } catch {
    return { code: null, message: null, required_tier: null };
  }
}
