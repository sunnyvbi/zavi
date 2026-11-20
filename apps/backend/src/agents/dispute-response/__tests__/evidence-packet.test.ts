
import { describe, it, expect } from "vitest";
import {
  disputeResponseSchema,
  hasSubmittableEvidencePacket,
  EVIDENCE_PACKET_FIELD_KEYS,
} from "../output-schema";

const validPacket = {
  dispute_id: "dp_1abc",
  evidence_fields: {
    customer_communication: "buyer↔seller chat proving the interaction",
    uncategorized_text: "drafted rebuttal case summary",
  },
  field_sources: { customer_communication: "email" },
  omitted_fields: ["receipt — no receipt on file"],
  evidence_due_by: 1_700_000_000,
  recommendation: "fight" as const,
  win_band: "High" as const,
};

describe("evidence_packet schema — PII is structurally impossible", () => {
  it("rejects customer_name in evidence_fields (.strict())", () => {
    const r = disputeResponseSchema.safeParse({
      rendered_markdown: "draft",
      evidence_packet: {
        ...validPacket,
        evidence_fields: {
          ...validPacket.evidence_fields,
          customer_name: "Jane Cardholder",
        },
      },
    });
    expect(r.success).toBe(false);
  });

  it("rejects customer_email_address in evidence_fields (.strict())", () => {
    const r = disputeResponseSchema.safeParse({
      rendered_markdown: "draft",
      evidence_packet: {
        ...validPacket,
        evidence_fields: {
          ...validPacket.evidence_fields,
          customer_email_address: "jane@example.com",
        },
      },
    });
    expect(r.success).toBe(false);
  });

  it("rejects any unknown evidence field key (closed key set)", () => {
    const r = disputeResponseSchema.safeParse({
      rendered_markdown: "draft",
      evidence_packet: {
        ...validPacket,
        evidence_fields: { ...validPacket.evidence_fields, ssn: "000-00-0000" },
      },
    });
    expect(r.success).toBe(false);
  });

  it("the exported key set contains ONLY the six PII-safe Stripe fields", () => {
    expect([...EVIDENCE_PACKET_FIELD_KEYS].sort()).toEqual(
      [
        "customer_communication",
        "customer_purchase_ip",
        "receipt",
        "service_documentation",
        "shipping_documentation",
        "uncategorized_text",
      ].sort(),
    );
    expect(EVIDENCE_PACKET_FIELD_KEYS).not.toContain("customer_name");
    expect(EVIDENCE_PACKET_FIELD_KEYS).not.toContain("customer_email_address");
  });
});

describe("evidence_packet schema — degrade-safe (optional packet)", () => {
  it("validates a prose-only envelope with NO packet (degrade to draft)", () => {
    const r = disputeResponseSchema.safeParse({
      rendered_markdown: "## Dispute response — draft-only mode\n...",
    });
    expect(r.success).toBe(true);
    expect(hasSubmittableEvidencePacket(r.success ? r.data : null)).toBe(false);
  });

  it("rejects a dispute_id that is not a dp_ Stripe id", () => {
    const r = disputeResponseSchema.safeParse({
      rendered_markdown: "draft",
      evidence_packet: { ...validPacket, dispute_id: "not-a-dispute" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an empty evidence_fields packet (nothing submittable → prose)", () => {
    const r = disputeResponseSchema.safeParse({
      rendered_markdown: "draft",
      evidence_packet: { ...validPacket, evidence_fields: {} },
    });
    expect(r.success).toBe(false);
  });

  it("validates a real packet and recognizes it as submittable", () => {
    const r = disputeResponseSchema.safeParse({
      rendered_markdown: "## Dispute response\n...",
      evidence_packet: validPacket,
    });
    expect(r.success).toBe(true);
    expect(hasSubmittableEvidencePacket(r.success ? r.data : null)).toBe(true);
  });
});

describe("hasSubmittableEvidencePacket — fail-closed emit gate", () => {
  it("false for null / non-object / no packet", () => {
    expect(hasSubmittableEvidencePacket(null)).toBe(false);
    expect(hasSubmittableEvidencePacket("nope")).toBe(false);
    expect(hasSubmittableEvidencePacket({ rendered_markdown: "x" })).toBe(false);
  });

  it("false when the packet is present but structurally invalid (PII smuggled)", () => {
    expect(
      hasSubmittableEvidencePacket({
        rendered_markdown: "x",
        evidence_packet: {
          ...validPacket,
          evidence_fields: { customer_name: "Jane" },
        },
      }),
    ).toBe(false);
  });

  it("true only for a present + schema-valid packet", () => {
    expect(
      hasSubmittableEvidencePacket({
        rendered_markdown: "x",
        evidence_packet: validPacket,
      }),
    ).toBe(true);
  });
});
