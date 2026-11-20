import { vi } from "vitest";
import type { FanoutDeps } from "../fanout";
import { BULK_REFUSAL_SENTENCES, type BulkRefusalCode } from "../readiness";
import type { BulkWireMessage, BulkWireResult } from "../wire";
import { FakeLedger } from "./fake-ledger";

export const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OTHER_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const LIST = "11111111-1111-4111-8111-111111111111";
export const VERSION = "22222222-2222-4222-8222-222222222222";
export const DECISION = "33333333-3333-4333-8333-333333333333";
export const FROM = "hello@acme.com";
export const POSTAL = "1 Main St, Austin TX";
export const SUBJECT = "A subject nobody should log";
export const BODY = "A body nobody should log";

export const people = (n: number) => Array.from({ length: n }, (_, i) => `p${String(i).padStart(4, "0")}@x.com`);

export const REPLY_TO = "founder@acme.com";

export function harness(opts: { emails?: string[]; newDomain?: boolean } = {}) {
  const ledger = new FakeLedger();
  if (!opts.newDomain) {
    ledger.warmup.set(`${TENANT}|acme.com`, { index: 10, last: new Date(ledger.now).toISOString().slice(0, 10) });
  }
  ledger.decisions.set(DECISION, { tenantId: TENANT, approved_by: "user-a" });
  ledger.addVersion(VERSION, { tenantId: TENANT, listId: LIST, emails: opts.emails ?? ["a@x.com", "b@x.com", "c@x.com"], consented: true });

  const state = {
    refusal: null as BulkRefusalCode | null,
    from: FROM,
    replyTo: REPLY_TO as string | null,
  };
  const wire = vi.fn(async (_msg: BulkWireMessage): Promise<BulkWireResult> => ({ kind: "sent" }));
  const shutOff = vi.fn(async (_t: string, _s: string, _r: string) => {});
  const unverifyDomain = vi.fn(async (_t: string) => {});
  const refuse = (code: BulkRefusalCode) => ({ ok: false as const, code, sentence: BULK_REFUSAL_SENTENCES[code] });

  const deps: FanoutDeps = {
    store: ledger,
    wire,
    checkReady: async (tenantId, listId, versionId) => {
      if (state.refusal) return refuse(state.refusal);
      if (ledger.archivedLists.has(listId)) return refuse("list_archived");
      const v = ledger.versions.get(versionId);
      if (!v || v.tenantId !== tenantId || v.listId !== listId) return refuse("list_not_found");
      if (!v.consented) return refuse("list_not_consented");
      return {
        ok: true as const,
        sender: { domain: "acme.com", from_address: state.from, from_name: "Acme" },
        postal_address: POSTAL,
        list_name: "Newsletter",
      };
    },
    unsubToken: async (_t, email) => `tok-${email}`,
    replyTo: async () => state.replyTo,
    shutOff,
    unverifyDomain,
    now: () => new Date(ledger.now),
  };

  const body = (over: Record<string, unknown> = {}) => ({
    list_id: LIST,
    list_version_id: VERSION,
    list_name: "Newsletter",
    from_address: FROM,
    reply_to: REPLY_TO,
    template: { subject: SUBJECT, body_text: BODY },
    est_recipient_count: 3,
    sample_recipients: ["a@x.com", "b@x.com", "c@x.com"],
    ...over,
  });

  return { ledger, state, wire, shutOff, unverifyDomain, deps, body };
}

export const sentTo = (wire: { mock: { calls: unknown[][] } }) => wire.mock.calls.map((c) => (c[0] as BulkWireMessage).to);
