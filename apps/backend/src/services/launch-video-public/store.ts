
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { serviceClient } from "@/services/supabase";

const TABLE = "launch_video_public_jobs";

export type JobStatus = "queued" | "rendering" | "ready" | "failed" | "claimed";

export type LaunchVideoJob = {
  id: string;
  tenant_id: string;
  status: JobStatus;
  client_secret_hash: string;
  email: string | null;
  email_domain: string | null;
  ip_hash: string | null;
  form_input: unknown;
  intake: unknown;
  preview_artifact_id: string | null;
  hd_artifact_id: string | null;
  parent_job_id: string | null;
  claimed_by_user_id: string | null;
  claimed_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export function generateClientSecret(): string {
  return randomBytes(32).toString("hex");
}

export function hashSecret(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function safeHashEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export function hashIp(ip: string): string {
  return createHash("sha256").update(ip, "utf8").digest("hex").slice(0, 32);
}

export type CreateJobInput = {
  tenant_id: string;
  ip_hash: string | null;
  client_secret_hash: string;
  email?: string | null;
  form_input?: unknown;
  intake?: unknown;
  parent_job_id?: string | null;
};

export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : null;
}

export async function createJob(input: CreateJobInput): Promise<string> {
  const sb = serviceClient();
  const email = input.email ? input.email.trim().toLowerCase() : null;
  const { data, error } = await sb
    .from(TABLE)
    .insert({
      tenant_id: input.tenant_id,
      ip_hash: input.ip_hash,
      client_secret_hash: input.client_secret_hash,
      email,
      email_domain: emailDomain(email),
      form_input: input.form_input ?? null,
      intake: input.intake ?? null,
      parent_job_id: input.parent_job_id ?? null,
      status: "queued",
    })
    .select("id")
    .single<{ id: string }>();
  if (error) throw new Error(`launch_video job insert failed: ${error.message}`);
  return data.id;
}

export async function getJobById(id: string): Promise<LaunchVideoJob | null> {
  const sb = serviceClient();
  const { data, error } = await sb.from(TABLE).select("*").eq("id", id).maybeSingle<LaunchVideoJob>();
  if (error) throw new Error(`launch_video job read failed: ${error.message}`);
  return data ?? null;
}

export async function updateJob(id: string, patch: Partial<LaunchVideoJob>): Promise<void> {
  const sb = serviceClient();
  const { error } = await sb
    .from(TABLE)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`launch_video job update failed: ${error.message}`);
}

export async function countJobsSince(scope: { ip_hash?: string }, sinceIso: string): Promise<number> {
  const sb = serviceClient();
  let q = sb.from(TABLE).select("id", { count: "exact", head: true }).gte("created_at", sinceIso);
  if (scope.ip_hash) q = q.eq("ip_hash", scope.ip_hash);
  const { count, error } = await q;
  if (error) throw new Error(`launch_video job count failed: ${error.message}`);
  return count ?? 0;
}

export async function tickAttemptBucket(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const { data, error } = await serviceClient().rpc("tick_enrichment_rate_limit", {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) throw new Error(error.message);
  return data === true;
}
