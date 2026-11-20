import { z } from "zod";

export function zodMessage(e: unknown): string {
  return e instanceof z.ZodError ? z.prettifyError(e) : (e as Error).message;
}
