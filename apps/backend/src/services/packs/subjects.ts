
import { serverClientFromBearer, serviceClient } from "@/services/supabase";
import { SubjectAliasSchema, type SubjectAlias } from "./types";

export type LinkSubjectOptions = {
  subject_id?: string | null;
  accessToken: string | null;
};

export async function linkSubject(
  tenant_id: string,
  aliases: SubjectAlias[],
  opts: LinkSubjectOptions,
): Promise<{ subject_id: string }> {
  if (aliases.length === 0) {
    throw new Error("linkSubject requires at least one alias");
  }
  for (const a of aliases) {
    const r = SubjectAliasSchema.safeParse(a);
    if (!r.success) {
      throw new Error(`invalid alias: ${JSON.stringify(r.error.issues)}`);
    }
  }

  const sb = opts.accessToken
    ? serverClientFromBearer(opts.accessToken)
    : serviceClient();

  const { data, error } = await sb.rpc("link_subject", {
    p_tenant_id: tenant_id,
    p_subject_id: opts.subject_id ?? null,
    p_aliases: aliases,
  });

  if (error) throw new Error(`link_subject failed: ${error.message}`);
  if (typeof data !== "string") {
    throw new Error(`link_subject returned non-uuid: ${JSON.stringify(data)}`);
  }
  return { subject_id: data };
}
