
import { createHash } from "node:crypto";
import { serviceClient } from "@/services/supabase";

export type DigestGuardVerdict = "sent" | "blocked_content" | "skipped_low_signal";

export function hashSubject(subject: string): string {
  return createHash("sha256").update(subject, "utf8").digest("hex");
}

export async function recordDigestSendAudit(args: {
  tenant_id: string;
  source_worker: string;
  subject: string;
  verdict: DigestGuardVerdict;
  violations: string[];
}): Promise<void> {
  try {
    const svc = serviceClient();
    const { error } = await svc.from("digest_send_audit").insert({
      tenant_id: args.tenant_id,
      source_worker: args.source_worker.slice(0, 64),
      subject_hash: hashSubject(args.subject),
      guard_verdict: args.verdict,
      violations: args.violations.slice(0, 20),
    });
    if (error) {
      const code = (error as { code?: string }).code ?? "";
      if (code === "42P01" || /relation .* does not exist/i.test(error.message)) {
        console.warn(
          "[digest-send-audit] digest_send_audit table not provisioned — apply the digest_send_audit migration.",
        );
      } else {
        console.warn(`[digest-send-audit] insert failed (${args.verdict}): ${error.message}`);
      }
    }
  } catch (e) {
    console.warn(`[digest-send-audit] unexpected error: ${(e as Error).message}`);
  }
}
