
import { z } from "zod";

export const EVIDENCE_PACKET_FIELD_KEYS = [
  "customer_communication",
  "customer_purchase_ip",
  "service_documentation",
  "receipt",
  "shipping_documentation",
  "uncategorized_text",
] as const;

const evidenceFieldsSchema = z
  .object({
    customer_communication: z.string().min(1).max(20000).optional(),
    customer_purchase_ip: z.string().min(1).max(64).optional(),
    service_documentation: z.string().min(1).max(20000).optional(),
    receipt: z.string().min(1).max(20000).optional(),
    shipping_documentation: z.string().min(1).max(20000).optional(),
    uncategorized_text: z.string().min(1).max(20000).optional(),
  })
  .strict();

export type EvidenceFields = z.infer<typeof evidenceFieldsSchema>;

const evidencePacketSchema = z
  .object({
    dispute_id: z
      .string()
      .regex(
        /^d[pu]_[A-Za-z0-9]+$/,
        "must be a Stripe dispute id (du_* or legacy dp_*)",
      ),
    evidence_fields: evidenceFieldsSchema,
    field_sources: z.record(z.string(), z.string().max(300)).default({}),
    omitted_fields: z.array(z.string().max(120)).max(20).default([]),
    evidence_due_by: z.union([z.number().int(), z.string().max(40)]).nullable().optional(),
    recommendation: z.enum(["fight", "accept"]),
    win_band: z.enum(["High", "Medium", "Low"]),
  })
  .superRefine((value, ctx) => {
    const filled = Object.values(value.evidence_fields).filter(
      (v) => typeof v === "string" && v.trim().length > 0,
    );
    if (filled.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "evidence_fields has no filled field — an empty packet is not submittable (degrade to prose-only draft)",
        path: ["evidence_fields"],
      });
    }
  });

export type EvidencePacket = z.infer<typeof evidencePacketSchema>;

export const disputeResponseSchema = z.object({
  rendered_markdown: z.string().min(1).max(20000),
  evidence_packet: evidencePacketSchema.optional(),
});

export type DisputeResponseEnvelope = z.infer<typeof disputeResponseSchema>;

export function hasSubmittableEvidencePacket(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const packet = (parsed as { evidence_packet?: unknown }).evidence_packet;
  if (packet == null) return false;
  return evidencePacketSchema.safeParse(packet).success;
}
