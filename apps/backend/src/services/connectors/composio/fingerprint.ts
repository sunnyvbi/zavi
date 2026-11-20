import { createHash } from "node:crypto";

const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
        )
      : v;

export function composioWriteFingerprint(b: {
  toolkit: unknown;
  tool_slug: unknown;
  arguments: unknown;
  classification: unknown;
  labels: unknown;
  decision_class: unknown;
  connected_account_id: unknown;
  auth_config_id: unknown;
}): string {
  const labels = Array.isArray(b.labels) ? [...b.labels].map(String).sort() : b.labels;
  const sealed = canon({
    toolkit: b.toolkit,
    tool_slug: b.tool_slug,
    arguments: b.arguments,
    classification: b.classification,
    labels,
    decision_class: b.decision_class,
    connected_account_id: b.connected_account_id,
    auth_config_id: b.auth_config_id,
  });
  return createHash("sha256").update(JSON.stringify(sealed)).digest("hex");
}
