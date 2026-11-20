
import { serviceClient } from "@/services/supabase";

export type ActivityActorType = "operator" | "staff" | "agent" | "system";
export type ActivitySource = "web" | "server" | "agent" | "slack" | "sdk" | "system";
export type ActivityConfidence = "exact" | "inferred" | "narrow_artifact_only";

export type RecordActivityInput = {
  tenant_id: string;
  verb: string;
  actor_type: ActivityActorType;
  actor_id?: string | null;
  object_type?: string | null;
  object_id?: string | null;
  source?: ActivitySource;
  props?: Record<string, unknown>;
  confidence?: ActivityConfidence;
  dedupe_key?: string | null;
  run_id?: string | null;
  occurred_at?: string;
};

const MAX_PROP_STR = 256;
const MAX_PROPS = 24;

function sanitizeProps(props?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!props) return out;
  let n = 0;
  for (const [k, v] of Object.entries(props)) {
    if (n >= MAX_PROPS) break;
    if (typeof v === "string") {
      out[k] = v.slice(0, MAX_PROP_STR);
      n++;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
      n++;
    } else if (typeof v === "boolean") {
      out[k] = v;
      n++;
    }
  }
  return out;
}

export type RecordActivityResult = "inserted" | "duplicate" | "failed";

export async function recordActivity(input: RecordActivityInput): Promise<RecordActivityResult> {
  try {
    let client;
    try {
      client = serviceClient();
    } catch (clientErr) {
      console.warn(
        `[recordActivity] serviceClient unavailable for ${input.verb}: ${(clientErr as Error).message}`,
      );
      return "failed";
    }

    const row = {
      tenant_id: input.tenant_id,
      verb: input.verb.slice(0, 80),
      actor_type: input.actor_type,
      actor_id: input.actor_id ?? null,
      object_type: input.object_type ?? null,
      object_id: input.object_id ? String(input.object_id).slice(0, 256) : null,
      source: input.source ?? "server",
      props: sanitizeProps(input.props),
      confidence: input.confidence ?? "exact",
      dedupe_key: input.dedupe_key ?? null,
      run_id: input.run_id ?? null,
      ...(input.occurred_at ? { occurred_at: input.occurred_at } : {}),
    };

    const { error } = await client.from("activity_events").insert(row);
    if (error) {
      if ((error as { code?: string }).code === "23505" && row.dedupe_key) return "duplicate";
      console.warn(`[recordActivity] insert failed for ${input.verb}: ${error.message}`);
      return "failed";
    }
    return "inserted";
  } catch (e) {
    console.warn(`[recordActivity] unexpected error: ${(e as Error).message}`);
    return "failed";
  }
}
