import type { ComposioExecResult } from "@/services/connectors/composio/api";

type Args = Record<string, unknown>;
type Call = { tool_slug: string; user_id: string; connected_account_id: string; arguments: Args };

const ok = (data: unknown): ComposioExecResult => ({ ok: true, status: 200, data, error: null, outcome_unknown: false });
const isObject = (v: unknown): boolean => typeof v === "object" && v !== null;
const KLAVIYO_TAGS: ReadonlySet<string> = new Set(["unsubscribe", "unsubscribe_link"]);
const KLAVIYO_RENDER_ERROR = JSON.stringify({ errors: [{ status: 400, code: "bad_request", title: "Bad request", detail: "Unable to render given template with provided context. Please check included django syntax and ensure it is compatible with provided context.", source: { pointer: "/data" } }] });
const lost = (): ComposioExecResult => ({ ok: false, status: 0, data: null, error: "composio_transport_error", outcome_unknown: true });
const refused = (status: number, error: string): ComposioExecResult => ({ ok: false, status, data: null, error, outcome_unknown: false });

export type FakeCampaign = {
  id: string;
  title: string;
  list: string;
  status: string;
  html: string | null;
  text?: string | null;
  sent: number;
  env?: { subject?: string; preview?: string; from_name?: string; from_email?: string; reply_to?: string };
  narrowedBy?: string;
};

export type FakeTool = {
  exec: (c: Call) => Promise<ComposioExecResult>;
  calls: Call[];
  campaigns: FakeCampaign[];
  lists: Array<{ id: string; name: string; members: number }>;
  count: (slug: string) => number;
  loseResponseOf: Set<string>;
  refuse: Map<string, string>;
  checklistReady: boolean;
  noDefaultSender?: boolean;
  templates?: Map<string, { html: string; text: string; editor_type: string }>;
  variants?: Set<string>;
};

function base(lists: FakeTool["lists"]): Omit<FakeTool, "exec"> {
  const calls: Call[] = [];
  return {
    calls,
    campaigns: [],
    lists,
    count: (slug) => calls.filter((c) => c.tool_slug === slug).length,
    loseResponseOf: new Set(),
    refuse: new Map(),
    checklistReady: true,
  };
}

export function fakeMailchimp(lists: FakeTool["lists"] = [{ id: "L1", name: "Newsletter", members: 412 }]): FakeTool {
  const t = base(lists) as FakeTool;
  const view = (c: FakeCampaign) => ({
    id: c.id,
    web_id: 9000 + t.campaigns.indexOf(c),
    status: c.status,
    emails_sent: c.sent,
    settings: { title: c.title, subject_line: c.env?.subject, preview_text: c.env?.preview, from_name: c.env?.from_name, reply_to: c.env?.reply_to },
    recipients: {
      list_id: c.list,
      recipient_count: t.lists.find((l) => l.id === c.list)?.members ?? 0,
      ...(c.narrowedBy ? { segment_opts: { saved_segment_id: Number(c.narrowedBy) || 1, match: "all" } } : {}),
    },
  });
  t.exec = async (call) => {
    t.calls.push(call);
    const a = call.arguments;
    const slug = call.tool_slug;
    const why = t.refuse.get(slug);
    if (why) return refused(400, why);
    const answer = (data: unknown) => {
      if (t.loseResponseOf.delete(slug)) return lost();
      return ok(data);
    };
    switch (slug) {
      case "MAILCHIMP_GET_LISTS_INFO":
        return answer({ lists: t.lists.map((l) => ({ id: l.id, name: l.name, stats: { member_count: l.members }, campaign_defaults: { from_name: "Acme", from_email: "hi@acme.test" } })) });
      case "MAILCHIMP_GET_LIST_INFO": {
        const l = t.lists.find((x) => x.id === a.list_id);
        return l ? answer({ id: l.id, name: l.name, stats: { member_count: l.members }, campaign_defaults: t.noDefaultSender ? {} : { from_name: "Acme", from_email: "hi@acme.test" } }) : refused(404, "Resource Not Found");
      }
      case "MAILCHIMP_LIST_CAMPAIGNS":
        return answer({ campaigns: [...t.campaigns].reverse().map(view), total_items: t.campaigns.length });
      case "MAILCHIMP_GET_CAMPAIGN_INFO": {
        const c = t.campaigns.find((x) => x.id === a.campaign_id);
        return c ? answer(view(c)) : refused(404, "Resource Not Found");
      }
      case "MAILCHIMP_ADD_CAMPAIGN": {
        const c: FakeCampaign = {
          id: `mc${t.campaigns.length + 1}`, title: String(a.settings__title), list: String(a.recipients__list__id), status: "save", html: null, sent: 0,
          env: { subject: a.settings__subject__line as string, preview: a.settings__preview__text as string | undefined, from_name: a.settings__from__name as string, reply_to: a.settings__reply__to as string },
        };
        t.campaigns.push(c);
        return answer(view(c));
      }
      case "MAILCHIMP_SET_CAMPAIGN_CONTENT": {
        const c = t.campaigns.find((x) => x.id === a.campaign_id);
        if (!c) return refused(404, "Resource Not Found");
        c.html = String(a.html);
        c.text = typeof a.plain_text === "string" ? a.plain_text : null;
        return answer({ html: c.html, plain_text: c.text ?? "" });
      }
      case "MAILCHIMP_GET_CAMPAIGN_CONTENT": {
        const c = t.campaigns.find((x) => x.id === a.campaign_id);
        if (!c) return refused(404, "Resource Not Found");
        return answer({
          data: {
            html: c.html ?? "",
            plain_text: c.text ?? "",
            archive_html: c.html ?? "",
            ...(t.variants?.has(c.id) ? { variate_contents: [{ content_label: "A", html: c.html, plain_text: c.text }] } : {}),
            _links: [],
          },
        });
      }
      case "MAILCHIMP_UPDATE_CAMPAIGN_SETTINGS": {
        const c = t.campaigns.find((x) => x.id === a.campaign_id);
        if (!c) return refused(404, "Resource Not Found");
        c.env = { subject: a.settings__subject__line as string, preview: (a.settings__preview__text as string) || undefined, from_name: a.settings__from__name as string, reply_to: a.settings__reply__to as string };
        return answer(view(c));
      }
      case "MAILCHIMP_DELETE_CAMPAIGN": {
        const i = t.campaigns.findIndex((x) => x.id === a.campaign_id);
        if (i < 0) return refused(404, "Resource Not Found");
        t.campaigns.splice(i, 1);
        return answer({});
      }
      case "MAILCHIMP_GET_CAMPAIGN_SEND_CHECKLIST":
        return answer(t.checklistReady ? { is_ready: true, items: [] } : { is_ready: false, items: [{ type: "error", heading: "From address", details: "Verify your sending domain" }] });
      case "MAILCHIMP_SEND_CAMPAIGN": {
        const c = t.campaigns.find((x) => x.id === a.campaign_id);
        if (!c) return refused(404, "Resource Not Found");
        if (c.status !== "save") return refused(400, "Campaign already sent");
        c.status = "sent";
        c.sent = t.lists.find((l) => l.id === c.list)?.members ?? 0;
        return answer({});
      }
      case "MAILCHIMP_GET_CAMPAIGN_REPORT": {
        const c = t.campaigns.find((x) => x.id === a.campaign_id);
        return c ? answer({ emails_sent: c.sent, opens: { unique_opens: 120, open_rate: 0.29 }, clicks: { unique_subscriber_clicks: 31, click_rate: 0.075 } }) : refused(404, "Resource Not Found");
      }
      default:
        throw new Error(`fake Mailchimp: unexpected action ${slug}`);
    }
  };
  return t;
}

export function fakeKlaviyo(lists: FakeTool["lists"] = [{ id: "L1", name: "Customers", members: 412 }]): FakeTool {
  const t = base(lists) as FakeTool;
  const view = (c: FakeCampaign) => ({
    type: "campaign",
    id: c.id,
    attributes: { name: c.title, status: c.status, audiences: { included: [c.list], excluded: c.narrowedBy ? [c.narrowedBy] : [] } },
    relationships: { "campaign-messages": { data: [{ type: "campaign-message", id: `${c.id}-msg` }] } },
  });
  t.exec = async (call) => {
    t.calls.push(call);
    const a = call.arguments;
    const slug = call.tool_slug;
    const why = t.refuse.get(slug);
    if (why) return refused(400, why);
    const answer = (data: unknown) => {
      if (t.loseResponseOf.delete(slug)) return lost();
      return ok({ data });
    };
    const byId = (id: unknown) => t.campaigns.find((x) => x.id === id);
    switch (slug) {
      case "KLAVIYO_GET_ACCOUNTS":
        return t.noDefaultSender
          ? answer([{ type: "account", id: "AC1", attributes: { contact_information: {} } }])
          : answer([{ type: "account", id: "AC1", attributes: { contact_information: { default_sender_name: "Acme Shop", default_sender_email: "hello@acme.test" } } }]);
      case "KLAVIYO_GET_LISTS":
        return answer(t.lists.map((l) => ({ type: "list", id: l.id, attributes: { name: l.name } })));
      case "KLAVIYO_GET_LIST": {
        const l = t.lists.find((x) => x.id === a.id);
        return l ? answer({ type: "list", id: l.id, attributes: { name: l.name, profile_count: l.members } }) : refused(404, "not found");
      }
      case "KLAVIYO_GET_CAMPAIGNS":
        if (a.sort !== undefined && !/^-?(created_at|scheduled_at|updated_at|id|name)$/.test(String(a.sort))) {
          return refused(400, `'sort' is not a valid value: ${String(a.sort)}`);
        }
        return answer([...t.campaigns].reverse().map(view));
      case "KLAVIYO_GET_CAMPAIGN": {
        const c = byId(a.campaign_id);
        if (!c) return refused(404, "not found");
        if (t.loseResponseOf.delete(slug)) return lost();
        const message = {
          type: "campaign-message",
          id: `${c.id}-msg`,
          attributes: { content: { subject: c.env?.subject, preview_text: c.env?.preview, from_label: c.env?.from_name, from_email: c.env?.from_email, reply_to_email: c.env?.reply_to } },
        };
        return ok({ data: view(c), ...(a.include_messages ? { included: [message] } : {}) });
      }
      case "KLAVIYO_UPDATE_CAMPAIGN_MESSAGE": {
        const c = t.campaigns.find((x) => `${x.id}-msg` === a.id);
        if (!c) return refused(404, "not found");
        const content = a.data__attributes__content as Record<string, string>;
        c.env = { subject: content.subject, preview: content.preview_text || undefined, from_name: content.from_label, from_email: content.from_email, reply_to: content.reply_to_email };
        return answer({ type: "campaign-message", id: a.id, attributes: {} });
      }
      case "KLAVIYO_CREATE_CAMPAIGN": {
        const content = ((a.data__attributes__campaign__messages__data as Array<{ attributes: { content: Record<string, string> } }>)[0]?.attributes.content ?? {}) as Record<string, string>;
        const c: FakeCampaign = {
          id: `KV${t.campaigns.length + 1}`, title: String(a.data__attributes__name), list: String((a.data__attributes__audiences__included as string[])[0]), status: "Draft", html: null, sent: 0,
          env: { subject: content.subject, preview: content.preview_text, from_name: content.from_label, from_email: content.from_email, reply_to: content.reply_to_email },
        };
        t.campaigns.push(c);
        return answer(view(c));
      }
      case "KLAVIYO_CREATE_TEMPLATE": {
        const id = `tpl${t.count(slug)}`;
        t.templates ??= new Map();
        t.templates.set(id, { html: String(a.data__attributes__html), text: String(a.data__attributes__text ?? ""), editor_type: String(a.data__attributes__editor__type ?? "CODE") });
        return answer({ type: "template", id, attributes: { name: a.data__attributes__name, html: a.data__attributes__html, text: a.data__attributes__text, editor_type: a.data__attributes__editor__type } });
      }
      case "KLAVIYO_ASSIGN_CAMPAIGN_MESSAGE_TEMPLATE": {
        const c = t.campaigns.find((x) => `${x.id}-msg` === a.data__id);
        if (!c) return refused(404, "not found");
        const src = t.templates?.get(String(a.data__relationships__template__data__id));
        if (!src) return refused(404, "template not found");
        c.html = src.html;
        c.text = src.text;
        t.templates!.set(`${c.id}-msg-tpl`, { ...src });
        return answer({ type: "campaign-message", id: a.data__id, attributes: {}, relationships: { template: { data: { type: "template", id: `${c.id}-msg-tpl` } } } });
      }
      case "KLAVIYO_GET_CAMPAIGN_MESSAGE_TEMPLATE": {
        const c = t.campaigns.find((x) => `${x.id}-msg` === a.id);
        const tpl = c ? t.templates?.get(`${c.id}-msg-tpl`) : undefined;
        if (!c || !tpl) return refused(404, "not found");
        return answer({ type: "template", id: `${c.id}-msg-tpl`, attributes: { name: c.title, editor_type: tpl.editor_type, html: c.html, text: c.text, updated: "2026-10-12T00:00:00Z" } });
      }
      case "KLAVIYO_CREATE_TEMPLATE_RENDER": {
        const tpl = t.templates?.get(String(a.data__id));
        if (!tpl) return refused(404, JSON.stringify({ errors: [{ status: 404, code: "not_found", title: "Not found.", detail: `Template with id '${String(a.data__id)}' does not exist` }] }));
        if (!isObject(a.data__attributes__context)) return { ok: false, status: 200, data: null, error: "{'attributes'} values are missing from `data` object", outcome_unknown: false };
        const bad = [...`${tpl.html}\n${tpl.text}`.matchAll(/\{%\s*(\w+)/g)].some((m) => !KLAVIYO_TAGS.has(m[1]));
        if (bad) return refused(400, KLAVIYO_RENDER_ERROR);
        return answer({ type: "template", id: a.data__id, attributes: { html: tpl.html, text: tpl.text } });
      }
      case "KLAVIYO_CREATE_CAMPAIGN_RECIPIENT_ESTIMATION_JOB":
        return answer({ type: "campaign-recipient-estimation-job", id: a.campaign_id, attributes: { status: "queued" } });
      case "KLAVIYO_GET_CAMPAIGN_RECIPIENT_ESTIMATION_JOB":
        return answer({ type: "campaign-recipient-estimation-job", id: a.id, attributes: { status: "complete" } });
      case "KLAVIYO_GET_CAMPAIGN_RECIPIENT_ESTIMATION": {
        const c = byId(a.id);
        return answer({ type: "campaign-recipient-estimation", id: a.id, attributes: { estimated_recipient_count: t.lists.find((l) => l.id === c?.list)?.members ?? 0 } });
      }
      case "KLAVIYO_CREATE_CAMPAIGN_SEND_JOB": {
        const c = byId(a.data__id);
        if (!c) return refused(404, "not found");
        if (c.status !== "Draft") return refused(400, "already sent");
        c.status = "Sending";
        c.sent = t.lists.find((l) => l.id === c.list)?.members ?? 0;
        return answer({ type: "campaign-send-job", id: c.id, attributes: { status: "queued" } });
      }
      case "KLAVIYO_GET_CAMPAIGN_SEND_JOB": {
        const c = byId(a.id);
        return c && c.status !== "Draft" ? answer({ type: "campaign-send-job", id: c.id, attributes: { status: "queued" } }) : refused(404, "not found");
      }
      default:
        throw new Error(`fake Klaviyo: unexpected action ${slug}`);
    }
  };
  return t;
}
