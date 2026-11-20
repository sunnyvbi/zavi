
import { describe, it, expect } from "vitest";
import { sanitizeWhatsAppPayload } from "@/services/redactor/whatsapp-payload-sanitizer";

const REAL_WEBHOOK = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_ID_123",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "14159699735", phone_number_id: "PN_ABC_123" },
            contacts: [{ profile: { name: "Ravi Ramadasu" }, wa_id: "14085551234" }],
            messages: [
              {
                from: "14085551234",
                id: "wamid.HBgLMTQwODU1NTEyMzQV",
                timestamp: "1788300000",
                type: "text",
                text: { body: "my email is ravi@upcar.ai and my card is 4111111111111111" },
              },
            ],
          },
        },
      ],
    },
  ],
};

function walk(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === "object") Object.values(node).forEach((n) => walk(n, out));
  return out;
}

describe("sanitizeWhatsAppPayload", () => {
  const clean = sanitizeWhatsAppPayload(REAL_WEBHOOK);
  const strings = walk(clean);
  const blob = JSON.stringify(clean);

  it("does NOT leak the sender's phone number — it is PII, not an opaque id", () => {
    expect(blob).not.toContain("14085551234");
  });

  it("does not leak our own display phone number either", () => {
    expect(blob).not.toContain("14159699735");
  });

  it("redacts message body content (email + card in this fixture)", () => {
    expect(blob).not.toContain("ravi@upcar.ai");
    expect(blob).not.toContain("4111111111111111");
  });

  it("redacts the sender's profile name", () => {
    expect(blob).not.toContain("Ravi Ramadasu");
  });

  it("KEEPS structural ids so an ingested event stays debuggable", () => {
    expect(blob).toContain("PN_ABC_123");
    expect(blob).toContain("wamid.HBgLMTQwODU1NTEyMzQV");
    expect(blob).toContain("whatsapp_business_account");
    expect(blob).toContain("messages");
  });

  it("preserves the object SHAPE so downstream readers still parse it", () => {
    const v = (clean as any).entry[0].changes[0].value;
    expect(v.messaging_product).toBe("whatsapp");
    expect(v.messages[0].type).toBe("text");
    expect(v.messages[0].timestamp).toBe("1788300000");
    expect(typeof v.messages[0].text.body).toBe("string");
  });

  it("does not mutate the input", () => {
    expect(REAL_WEBHOOK.entry[0].changes[0].value.contacts[0].wa_id).toBe("14085551234");
  });

  it("is idempotent — re-sanitizing does not double-mangle", () => {
    expect(JSON.stringify(sanitizeWhatsAppPayload(clean))).toBe(blob);
  });

  it("survives hostile shapes without throwing", () => {
    for (const bad of [null, undefined, 42, "str", [], {}, { entry: null }]) {
      expect(() => sanitizeWhatsAppPayload(bad)).not.toThrow();
    }
  });
});
