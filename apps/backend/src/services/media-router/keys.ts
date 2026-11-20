import { createHash } from "node:crypto";

export function mediaSlotHash(...parts: Array<string | undefined>): string {
  return createHash("sha256")
    .update(parts.map((p) => p ?? "").join("|"))
    .digest("hex")
    .slice(0, 10);
}
