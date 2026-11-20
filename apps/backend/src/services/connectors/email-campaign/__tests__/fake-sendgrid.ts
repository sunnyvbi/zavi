
type Req = { method: string; url: URL; body: unknown; auth: string | null };

export type FakeSingleSend = {
  id: string;
  name: string;
  status: "draft" | "scheduled" | "triggered";
  list_ids: string[];
  segment_ids: string[];
  all?: boolean;
  subject: string | null;
  html: string | null;
  plain: string | null;
  sender_id: number | null;
  suppression_group_id: number | null;
  created_at: string;
};

export type FakeSendgrid = {
  fetch: typeof fetch;
  requests: Req[];
  key: string;
  lists: Array<{ id: string; name: string; contact_count: number }>;
  senders: Array<{ id: number; from_email: string; from_name: string; verified: boolean }>;
  groups: Array<{ id: number; name: string; is_default: boolean }>;
  groupSuppressions: Record<string, string[]>;
  globalUnsubscribes: string[];
  contacts: Record<string, string[]>;
  forbidden: Set<string>;
  sends: FakeSingleSend[];
  stats: Record<string, Record<string, number>>;
  failOnce: Map<string, number>;
  dropAnswerOf: Set<string>;
  count: (method: string, pathRe: RegExp) => number;
};

const json = (status: number, body: unknown) => new Response(body === undefined ? "" : JSON.stringify(body), { status });

export const BRIGHTLOOP_KEY = "SG.brightloopKeyId01.brightloopSecret_abcdefghijklmnop";

export function fakeSendgrid(): FakeSendgrid {
  const t: FakeSendgrid = {
    fetch: null as unknown as typeof fetch,
    requests: [],
    key: BRIGHTLOOP_KEY,
    groupSuppressions: {},
    globalUnsubscribes: [],
    contacts: {},
    forbidden: new Set(),
    lists: [{ id: "6a1f0c2e-0000-4000-8000-00000000b001", name: "Brightloop members", contact_count: 238 }],
    senders: [{ id: 41, from_email: "hello@brightloop.test", from_name: "Brightloop", verified: true }],
    groups: [
      { id: 7, name: "Product news", is_default: true },
      { id: 8, name: "Billing", is_default: false },
    ],
    sends: [],
    stats: {},
    failOnce: new Map(),
    dropAnswerOf: new Set(),
    count: (method, re) => t.requests.filter((r) => r.method === method && re.test(r.url.pathname)).length,
  };
  let seq = 0;
  const view = (s: FakeSingleSend) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    send_to: { list_ids: s.list_ids, segment_ids: s.segment_ids, all: s.all ?? false },
    email_config: {
      subject: s.subject,
      html_content: s.html,
      plain_content: s.plain,
      editor: "code",
      sender_id: s.sender_id,
      suppression_group_id: s.suppression_group_id,
      custom_unsubscribe_url: null,
    },
    created_at: s.created_at,
  });

  const handle = (r: Req): Response => {
    if (r.auth !== `Bearer ${t.key}`) return json(401, { errors: [{ message: "authorization required" }] });
    const p = r.url.pathname;
    const key = `${r.method} ${p.replace(/[0-9a-f-]{36}|ss-\d+/g, "{id}")}`;
    const failing = t.failOnce.get(key);
    if (failing) {
      t.failOnce.delete(key);
      return json(failing, { errors: [{ message: `failure ${failing}` }] });
    }
    let m: RegExpMatchArray | null;
    if (r.method === "GET" && p === "/v3/marketing/lists") return json(200, { result: t.lists, _metadata: { count: t.lists.length } });
    if (r.method === "GET" && (m = p.match(/^\/v3\/marketing\/lists\/([^/]+)\/contacts\/count$/))) {
      const l = t.lists.find((x) => x.id === m![1]);
      return l ? json(200, { contact_count: l.contact_count, billable_count: l.contact_count }) : json(404, {});
    }
    if (r.method === "GET" && (m = p.match(/^\/v3\/marketing\/lists\/([^/]+)$/))) {
      const l = t.lists.find((x) => x.id === m![1]);
      return l ? json(200, l) : json(404, { errors: [{ message: "not found" }] });
    }
    if (r.method === "GET" && p === "/v3/verified_senders") return json(200, { results: t.senders });
    if (t.forbidden.has(p)) return json(403, { errors: [{ message: "access forbidden" }] });
    m = p.match(/^\/v3\/asm\/groups\/([^/]+)\/suppressions$/);
    if (r.method === "GET" && m) return json(200, t.groupSuppressions[m[1]] ?? []);
    if (r.method === "GET" && p === "/v3/suppression/unsubscribes") {
      const limit = Number(r.url.searchParams.get("limit") ?? 500);
      const offset = Number(r.url.searchParams.get("offset") ?? 0);
      return json(200, t.globalUnsubscribes.slice(offset, offset + limit).map((email) => ({ created: 1, email })));
    }
    if (r.method === "POST" && p === "/v3/marketing/contacts/search/emails") {
      const emails = (r.body as { emails: string[] }).emails;
      if (emails.length > 100) return json(400, { errors: [{ message: "too many" }] });
      const hits = emails.filter((e) => t.contacts[e]);
      if (hits.length === 0) return json(404, { errors: [{ message: "no contacts" }] });
      return json(200, { result: Object.fromEntries(emails.map((e) => [e, t.contacts[e] ? { contact: { email: e, list_ids: t.contacts[e] } } : { error: "contact not found" }])) });
    }
    if (r.method === "GET" && p === "/v3/asm/groups") return json(200, t.groups);
    if (r.method === "POST" && p === "/v3/marketing/singlesends/search") {
      const name = String((r.body as { name?: string }).name ?? "");
      const hits = t.sends.filter((s) => s.name.includes(name));
      return json(200, { result: hits.map((s) => ({ id: s.id, name: s.name, status: s.status, created_at: s.created_at })) });
    }
    if (r.method === "POST" && p === "/v3/marketing/singlesends") {
      const b = r.body as { name: string; send_to: { list_ids: string[] }; email_config: Record<string, unknown> };
      const s: FakeSingleSend = {
        id: `ss-${++seq}`,
        name: b.name,
        status: "draft",
        list_ids: b.send_to.list_ids,
        segment_ids: [],
        subject: (b.email_config.subject as string) ?? null,
        html: null,
        plain: null,
        sender_id: (b.email_config.sender_id as number) ?? null,
        suppression_group_id: (b.email_config.suppression_group_id as number) ?? null,
        created_at: `2026-10-11T10:00:${String(seq).padStart(2, "0")}Z`,
      };
      t.sends.push(s);
      return json(201, view(s));
    }
    if ((m = p.match(/^\/v3\/marketing\/singlesends\/([^/]+)\/schedule$/)) && r.method === "PUT") {
      const s = t.sends.find((x) => x.id === m![1]);
      if (!s) return json(404, { errors: [{ message: "not found" }] });
      s.status = "scheduled";
      return json(201, { send_at: "now", status: "scheduled" });
    }
    if ((m = p.match(/^\/v3\/marketing\/singlesends\/([^/]+)$/))) {
      const s = t.sends.find((x) => x.id === m![1]);
      if (!s) return json(404, { errors: [{ message: "not found" }] });
      if (r.method === "GET") return json(200, view(s));
      if (r.method === "PATCH") {
        const b = r.body as { name?: string; email_config?: Record<string, unknown> };
        if (!b.name) return json(400, { errors: [{ field: "name", message: "name is required" }] });
        const c = b.email_config ?? {};
        if ("subject" in c) s.subject = c.subject as string;
        if ("html_content" in c) s.html = c.html_content as string;
        if ("plain_content" in c) s.plain = c.plain_content as string;
        if ("sender_id" in c) s.sender_id = c.sender_id as number;
        if ("suppression_group_id" in c) s.suppression_group_id = c.suppression_group_id as number;
        return json(200, view(s));
      }
    }
    if (r.method === "GET" && (m = p.match(/^\/v3\/marketing\/stats\/singlesends\/([^/]+)$/))) {
      const st = t.stats[m[1]];
      return json(200, { results: st ? [{ id: m[1], ab_variation: "all", ab_phase: "all", aggregation: "total", stats: st }] : [] });
    }
    return json(404, { errors: [{ message: `no route ${r.method} ${p}` }] });
  };

  t.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const req: Req = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization ?? null };
    t.requests.push(req);
    const res = handle(req);
    const dropKey = `${req.method} ${url.pathname.replace(/[0-9a-f-]{36}|ss-\d+/g, "{id}")}`;
    if (t.dropAnswerOf.has(dropKey)) {
      t.dropAnswerOf.delete(dropKey);
      throw new TypeError("fetch failed");
    }
    return res;
  }) as unknown as typeof fetch;
  return t;
}
