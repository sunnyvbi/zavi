import { attachSession } from "../../session-attach";
import { openMongoSession } from "@/services/data-gateway/direct/mongo";
import type { SchemaMap } from "../../types";

export async function attachMongoSession<T extends object = SchemaMap>(cfg: T, uri: string): Promise<T> {
  return attachSession(cfg, await openMongoSession(uri));
}
