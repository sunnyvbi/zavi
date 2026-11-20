
import { ExpectedToolError } from "@/services/tools/types";

export class EmitNoWriteError extends Error {
  readonly noWrite = true as const;
  constructor(message: string) {
    super(message);
    this.name = "EmitNoWriteError";
  }
}

export function isNoWriteEmitError(e: unknown): boolean {
  return e instanceof ExpectedToolError || e instanceof EmitNoWriteError || (!!e && typeof e === "object" && (e as { noWrite?: unknown }).noWrite === true);
}
