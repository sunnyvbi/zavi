
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import { setCompanyFact, getCompanyFacts } from "@/services/company/facts";
import { seedTenantBootstrap } from "@/services/tenants/bootstrap";
import { getJobById, updateJob } from "@/services/launch-video-public/store";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";
import { parseSignupAttribution, persistSignupAttribution } from "@/services/tenants/signup-attribution";

const HD_TTL_SECONDS = 600;
const LAUNCH_VIDEO_BUCKET = "launch-video-artifacts";

const NOT_YOUR_VIDEO = {
  error: {
    code: "not_your_video",
    message:
      "This video was requested with a different email address. Sign in with the address you entered on the form to claim it.",
  },
} as const;

async function signArtifact(artifactId: string): Promise<string | null> {
  const sb = serviceClient();
  const { data: row } = await sb
    .from("run_artifacts")
    .select("storage_path, bucket")
    .eq("id", artifactId)
    .maybeSingle<{ storage_path: string; bucket: string }>();
  if (!row?.storage_path) return null;
  const { data, error } = await sb.storage
    .from(row.bucket || LAUNCH_VIDEO_BUCKET)
    .createSignedUrl(row.storage_path, HD_TTL_SECONDS);
  return error ? null : (data?.signedUrl ?? null);
}

async function userOwnsTenant(
  sb: ReturnType<typeof serviceClient>,
  user_id: string,
  tenant_id: string,
): Promise<boolean> {
  const { data, error } = await sb
    .from("tenant_users")
    .select("user_id")
    .eq("tenant_id", tenant_id)
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) {
    // eslint-disable-next-line no-console
    console.warn(`[launch-video/claim] ownership probe failed for ${tenant_id}: ${error.message}`);
    return false;
  }
  return !!data;
}

async function seedClaimedTenant(
  tenant_id: string,
  user_id: string,
  formInput: unknown,
): Promise<boolean> {
  const fi = (formInput ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

  const company = str(fi.company) || str(fi.product_name);
  const oneLiner = str(fi.one_liner);
  const audience = str(fi.audience);
  const features = str(fi.features);
  const ref = `launch-video form — typed by the visitor (user ${user_id})`;

  const story = [oneLiner, features && `Key features:\n${features}`].filter(Boolean).join("\n\n");

  const writes: Array<[string, string]> = [];
  if (company) writes.push(["company_name", company]);
  if (oneLiner) writes.push(["what_we_sell", oneLiner]);
  if (audience) writes.push(["who_we_serve", audience]);
  if (story) writes.push(["company_story", story]);

  let existingKeys = new Set<string>();
  try {
    const current = await getCompanyFacts(tenant_id);
    existingKeys = new Set(Object.keys(current.facts ?? {}));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[launch-video/claim] fact read failed for ${tenant_id}, skipping seed: ${(e as Error).message}`);
    await seedTenantBootstrap(tenant_id);
    return false;
  }

  let wrote = false;
  for (const [key, value] of writes) {
    if (existingKeys.has(key)) continue;
    const { ok, error } = await setCompanyFact(tenant_id, key as "company_name", value, ref);
    if (ok) wrote = true;
    else {
      // eslint-disable-next-line no-console
      console.warn(`[launch-video/claim] fact ${key} not written for ${tenant_id}: ${error}`);
    }
  }

  const boot = await seedTenantBootstrap(tenant_id);
  const bootErrors = (boot as { errors?: unknown[] } | undefined)?.errors;
  if (Array.isArray(bootErrors) && bootErrors.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[launch-video/claim] bootstrap seeded with errors for ${tenant_id}: ${JSON.stringify(bootErrors).slice(0, 400)}`);
  }

  return wrote;
}

export async function launchVideoClaim(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const jobId = typeof req.body?.job_id === "string" ? req.body.job_id.trim() : "";
  if (!jobId) {
    res.status(400).json({ error: { code: "missing_job_id", message: "job_id is required." } });
    return;
  }

  const job = await getJobById(jobId);
  if (!job) {
    res.status(404).json({ error: { code: "not_found", message: "That video couldn't be found." } });
    return;
  }

  const sb = serviceClient();

  const { data: userData, error: userErr } = await sb.auth.admin.getUserById(auth.user_id);
  const sessionEmail = userData?.user?.email?.trim().toLowerCase() ?? null;
  const jobEmail = job.email?.trim().toLowerCase() ?? null;
  if (userErr || !sessionEmail || !jobEmail || sessionEmail !== jobEmail) {
    res.status(403).json(NOT_YOUR_VIDEO);
    return;
  }
  const { data: outcome, error: rpcErr } = await sb.rpc("claim_launch_video_tenant", {
    p_user_id: auth.user_id,
    p_tenant_id: job.tenant_id,
  });
  if (rpcErr) {
    // eslint-disable-next-line no-console
    console.error("[launch-video/claim] rpc failed", { msg: rpcErr.message });
    res.status(500).json({ error: { code: "claim_failed", message: "Something went wrong. Please try again." } });
    return;
  }

  if (outcome === "claimed" && job.status !== "claimed") {
    try {
      await updateJob(job.id, {
        status: "claimed",
        claimed_by_user_id: auth.user_id,
        claimed_at: new Date().toISOString(),
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[launch-video/claim] job stamp failed (non-fatal)", { msg: (e as Error).message });
    }
  }
  if (outcome === "claimed") {
    const form = job.form_input && typeof job.form_input === "object" && !Array.isArray(job.form_input)
      ? job.form_input as Record<string, unknown> : {};
    const original = parseSignupAttribution(form.signup_attribution);
    await persistSignupAttribution(job.tenant_id, auth.user_id, original ?? req.body?.attribution, req.query);
  }

  let profile_seeded = false;
  const canSeed =
    outcome === "claimed" ||
    (outcome === "not_shell" && (await userOwnsTenant(sb, auth.user_id, job.tenant_id)));

  if (canSeed) {
    try {
      profile_seeded = await seedClaimedTenant(job.tenant_id, auth.user_id, job.form_input);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[launch-video/claim] seed failed (non-fatal)", { msg: (e as Error).message });
    }
  }

  if (outcome === "claimed") {
    void notifyFounderActivity({
      event: "launch_video_claimed",
      tenant_id: job.tenant_id,
      user_id: auth.user_id,
      email: sessionEmail,
      details: { job_id: job.id },
    });
  }

  const hd_url = job.hd_artifact_id ? await signArtifact(job.hd_artifact_id) : null;

  res.status(200).json({
    status: outcome,
    hd_url,
    profile_seeded,
    redirect: "/workspace",
  });
}
