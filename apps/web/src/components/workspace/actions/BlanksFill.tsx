"use client";

import { useEffect, useId, useState, type Dispatch, type SetStateAction } from "react";
import { Check } from "lucide-react";
import { registerSessionScopedCache } from "@/lib/workspace/sessionScopedCache";
import { apiFetch } from "@/lib/api";
import { EMAIL_FOOTER_SAVED_EVENT, goToEmailFooterSettings, liveSettingItems, SENDER_FIELD } from "@/lib/workspace/emailCampaignSettingsApi";
import { footerPostal } from "../email/postalAddress";
import { useRereadWhileFailed } from "../email/useRereadWhileFailed";
import { useChannelSurface } from "./ChannelSurface";
import { blankContexts } from "./audienceParse";
import { useBlankSuggestions, type BlankSuggestions } from "./blankSuggestions";
import {
  FOOTER_MISSING,
  blankGroup,
  blankLabel,
  blankName,
  blankSource,
  fillBlanks,
  findBlanks,
  isFooterBlank,
  isLinkBlank,
  knownBlankValues,
  linkProblem,
  siteDomain,
  type BlankContext,
  type BlankGroup,
  type BlankSource,
  type KnownValue,
} from "./blanks";

export type BlankFills = {
  blanks: string[];
  values: Record<string, string>;
  known: Record<string, KnownValue>;
  typed: Record<string, string>;
  problem?: Record<string, string>;
  set: (blank: string, value: string) => void;
  left: number;
  fill: (text: string) => string;
  active?: string | null;
  setActive?: Dispatch<SetStateAction<string | null>>;
  ready?: boolean;
  footerFromSettings?: boolean;
  footerUnread?: FooterSource[];
  context?: Record<string, string>;
  suggest?: BlankSuggestions;
  suggested?: Record<string, string>;
};

const COMPANY_SOURCES: readonly BlankSource[] = ["domain", "company_name", "business_name"];
const EMAIL_SOURCES: readonly BlankSource[] = ["postal_address", "unsubscribe", "first_name"];
const EMAIL_CHANNEL = "email_marketing";
const EMAIL_CHANNEL_HREF = "/workspace?tab=channels&channel=email_marketing";
const SETTINGS_PATH = "/api/channels/email_marketing/settings";
const TEMPLATE_PATH = "/api/workspace/email-template";
const SENDING_PATH = "/api/workspace/sending-domain";
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

export function clearBlankContextCache(): void {
  cache.clear();
}

if (typeof window !== "undefined") {
  window.addEventListener(EMAIL_FOOTER_SAVED_EVENT, () => {
    cache.delete(SETTINGS_PATH);
    cache.delete(TEMPLATE_PATH);
  });
}

function readJson(path: string): Promise<unknown> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value: Promise<unknown> = apiFetch(path)
    .then((res) => (res.ok ? res.json().catch(() => null) : null))
    .catch(() => null)
    .then((body) => {
      if (body === null && cache.get(path)?.value === value) cache.delete(path);
      return body;
    });
  cache.set(path, { at: Date.now(), value });
  registerSessionScopedCache(clearBlankContextCache);
  return value;
}

type Facts = { facts?: Array<{ key?: string; value_text?: string | null }> } | null;
type Settings = { fields?: Record<string, Array<{ item?: string | null; status?: string | null }> | undefined>; email_tool?: string | null } | null;
type Template = { template?: { postal_address?: string | null } | null } | null;
type Sending = { domain?: { domain?: string | null } | null; suggested_domain?: string | null } | null;
type FooterSource = "postal_address" | "unsubscribe";
export type BlankContextRead = BlankContext & { domainFrom?: string; footerUnread?: FooterSource[] };

function fact(body: Facts, key: string): string | null {
  return body?.facts?.find((f) => f.key === key)?.value_text?.trim() || null;
}

function postalFrom(template: Template, settings: Settings): string | null {
  if (!template) return null;
  if (template.template) return footerPostal({ postal_address: template.template.postal_address ?? null }, null) || null;
  return footerPostal(null, liveSettingItems(settings?.fields?.postal_address)) || null;
}

function unreadFooter(needPostal: boolean, needEmail: boolean, template: Template, settings: Settings): FooterSource[] {
  const postal = needPostal && (!template || (!template.template && !settings));
  return [...(postal ? (["postal_address"] as const) : []), ...(needEmail && !settings ? (["unsubscribe"] as const) : [])];
}

function setting(body: Settings, id: string): string | null {
  return liveSettingItems(body?.fields?.[id]).map((v) => v.trim()).find(Boolean) || null;
}

export function useBlankContext(sources: BlankSource[]): BlankContextRead | null {
  const needCompany = sources.some((s) => COMPANY_SOURCES.includes(s));
  const needDomain = sources.includes("domain");
  const needEmail = sources.some((s) => EMAIL_SOURCES.includes(s));
  const needPostal = sources.includes("postal_address");
  const [ctx, setCtx] = useState<BlankContextRead | null>(null);
  const [version, setVersion] = useState(0);
  useRereadWhileFailed(Boolean(ctx?.footerUnread?.length), () => setVersion((v) => v + 1));
  useEffect(() => {
    if (!needEmail) return;
    const onSaved = () => {
      cache.delete(SETTINGS_PATH);
      cache.delete(TEMPLATE_PATH);
      setVersion((v) => v + 1);
    };
    window.addEventListener(EMAIL_FOOTER_SAVED_EVENT, onSaved);
    return () => window.removeEventListener(EMAIL_FOOTER_SAVED_EVENT, onSaved);
  }, [needEmail]);
  useEffect(() => {
    if (!needCompany && !needEmail) return;
    let live = true;
    void Promise.all([
      needCompany ? (readJson("/api/connectors/company-facts") as Promise<Facts>) : Promise.resolve(null),
      needEmail ? (readJson(SETTINGS_PATH) as Promise<Settings>) : Promise.resolve(null),
      needPostal ? (readJson(TEMPLATE_PATH) as Promise<Template>) : Promise.resolve(null),
    ]).then(async ([facts, settings, template]) => {
      const site = siteDomain(fact(facts, "domain"));
      const sending = needDomain && !site ? ((await readJson(SENDING_PATH)) as Sending) : null;
      const sent = siteDomain(sending?.domain?.domain ?? sending?.suggested_domain ?? setting(settings, "sending_domain"));
      if (!live) return;
      setCtx({
        companyName: fact(facts, "company_name"),
        whatWeSell: fact(facts, "what_we_sell"),
        domain: site ?? sent,
        domainFrom: !site && sent ? "From Settings > Sending" : undefined,
        postalAddress: postalFrom(template, settings),
        footerUnread: unreadFooter(needPostal, needEmail, template, settings),
        esp: setting(settings, "esp") ?? settings?.email_tool ?? (setting(settings, SENDER_FIELD) ? "sendgrid" : null),
        unsubscribeLink: setting(settings, "unsubscribe_link"),
      });
    });
    return () => {
      live = false;
    };
  }, [needCompany, needEmail, needPostal, needDomain, version]);
  return ctx;
}

export function useBlankFills(texts: Array<string | null | undefined>, kind?: string | null, channel?: string | null, suggestFor?: { slug: string; cardId: string } | null): BlankFills {
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [active, setActive] = useState<string | null>(null);
  const joined = texts.filter(Boolean).join("\n\n");
  const blanks = findBlanks(joined, kind);
  const sources = blanks.map(blankSource).filter((s): s is BlankSource => s !== null);
  const ctx = useBlankContext(sources);
  const known = knownBlankValues(blanks, ctx);
  if (ctx?.domainFrom) for (const b of blanks) if (known[b] && blankSource(b) === "domain") known[b] = { ...known[b], from: ctx.domainFrom };
  const context = blankContexts(joined, blanks);
  const [askFor] = useState(() => blanks.filter((b) => !(known[b]?.value ?? "").trim()));
  const suggest = useBlankSuggestions(suggestFor?.slug, suggestFor?.cardId, suggestFor ? askFor : [], context);
  const values: Record<string, string> = {};
  const problem: Record<string, string> = {};
  const suggested: Record<string, string> = {};
  for (const b of blanks) {
    const own = typed[b] ?? known[b]?.value;
    const best = suggest.options[b]?.[0];
    if (own === undefined && best !== undefined) suggested[b] = best;
    const raw = own ?? best;
    if (raw === undefined) continue;
    const bad = typed[b] !== undefined ? linkProblem(b, raw) : null;
    if (bad) {
      problem[b] = bad;
      continue;
    }
    values[b] = typed[b] !== undefined && isLinkBlank(b) ? raw.trim() : raw;
  }
  return {
    blanks,
    values,
    known,
    typed,
    problem,
    set: (blank, value) => setTyped((v) => ({ ...v, [blank]: value })),
    left: blanks.filter((b) => !values[b]?.trim()).length,
    fill: (text) => fillBlanks(text, values),
    context,
    suggest,
    suggested,
    active,
    setActive,
    ready: ctx !== null || !sources.some((s) => EMAIL_SOURCES.includes(s) || COMPANY_SOURCES.includes(s)),
    footerFromSettings: channel === EMAIL_CHANNEL,
    footerUnread: ctx?.footerUnread,
  };
}

const INPUT =
  "h-10 w-full min-w-0 rounded-[10px] border bg-cream px-3 text-[16px] leading-5 text-ink outline-none transition-[border-color,box-shadow] placeholder:text-inkLight focus:border-marigold/60 focus:shadow-[0_0_0_4px_rgb(255_201_61/0.14),0_0_18px_-4px_rgb(255_201_61/0.35)] motion-reduce:transition-none";

const GROUPS: ReadonlyArray<{ key: BlankGroup; title: string; note: string }> = [
  { key: "recipient", title: "Personalisation", note: "Changes for each person who gets it" },
  { key: "sender", title: "Your details", note: "The same on every email" },
];

const FOOTER_LINK =
  "inline-flex min-h-[44px] items-center font-medium text-ink underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30";

function FooterMissing({ source }: { source: "postal_address" | "unsubscribe" }) {
  const onEmailChannel = useChannelSurface() === EMAIL_CHANNEL;
  return (
    <p data-testid="blank-footer-missing" data-source={source} className="flex flex-wrap items-center gap-x-2 text-[14px] leading-5 text-ink">
      <span>{FOOTER_MISSING[source]}</span>
      {onEmailChannel ? (
        <button type="button" onClick={goToEmailFooterSettings} className={FOOTER_LINK}>
          Open Footer settings
        </button>
      ) : (
        <a href={EMAIL_CHANNEL_HREF} className={FOOTER_LINK}>
          Open Email campaigns
        </a>
      )}
    </p>
  );
}

function BlankField({ fills, blank, index }: { fills: BlankFills; blank: string; index: number }) {
  const own = blankLabel(blank);
  const where = fills.context?.[blank];
  const title = where ?? own.title;
  const hint = where ? (own.hint ?? own.title) : own.hint;
  const known = fills.typed[blank] === undefined ? fills.known[blank] : undefined;
  const empty = !fills.values[blank]?.trim();
  const helpId = useId();
  const { setActive } = fills;
  useEffect(() => () => setActive?.((current) => (current === blank ? null : current)), [blank, setActive]);
  return (
    <label
      data-testid="blank-field"
      data-state={known ? "auto" : empty ? "empty" : "typed"}
      className="block min-w-0"
    >
      <span className="flex items-center gap-1.5 text-[14px] font-medium leading-5 text-ink">
        <span className="truncate">{title}</span>
        {!empty && <Check data-testid="blank-done" className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />}
      </span>
      <input
        type="text"
        name={`zavi-blank-${index}`}
        autoComplete="off"
        data-1p-ignore=""
        data-lpignore="true"
        data-form-type="other"
        value={fills.typed[blank] ?? fills.values[blank] ?? ""}
        placeholder={hint ?? undefined}
        onChange={(e) => fills.set(blank, e.target.value)}
        onFocus={() => fills.setActive?.(blank)}
        onBlur={() => fills.setActive?.(null)}
        aria-label={blankName(blank)}
        aria-invalid={fills.problem?.[blank] ? true : undefined}
        aria-describedby={fills.problem?.[blank] ? helpId : known?.from ? helpId : undefined}
        className={`${INPUT} mt-1.5 ${empty ? "border-rule" : "border-success/35"}`}
      />
      {fills.problem?.[blank] ? (
        <span id={helpId} role="alert" data-testid="blank-problem" className="mt-1 block text-[12px] leading-4 text-ink [overflow-wrap:anywhere]">
          {fills.problem[blank]}
        </span>
      ) : known?.from ? (
        <span id={helpId} data-testid="blank-from" className="mt-1 block text-[12px] leading-4 text-inkMuted [overflow-wrap:anywhere]">
          {known.from}
        </span>
      ) : null}
    </label>
  );
}

export function BlanksFill({ fills }: { fills: BlankFills }) {
  if (!fills.blanks.length) return null;
  const fromSettings = (b: string) => fills.footerFromSettings === true && isFooterBlank(b);
  const fields = fills.blanks.filter((b) => !fromSettings(b));
  const empty = Array.from(
    new Set(
      fills.blanks
        .filter((b) => fills.ready !== false && fromSettings(b) && !fills.values[b]?.trim())
        .map((b) => blankSource(b) as FooterSource),
    ),
  );
  const missing = empty.filter((s) => !fills.footerUnread?.includes(s));
  const unread = missing.length < empty.length;
  if (!fields.length && !empty.length) return null;
  const total = fills.blanks.length;
  const index = new Map(fills.blanks.map((b, i) => [b, i]));
  const groups = GROUPS.map((g) => ({ ...g, blanks: fields.filter((b) => blankGroup(b) === g.key) })).filter((g) => g.blanks.length);
  const titled = groups.length > 1;
  return (
    <div data-testid="blanks-fill" className="rounded-xl border border-rule bg-white px-4 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-semibold text-ink">Fill these in first</p>
        <p
          data-testid="blanks-left"
          className={`shrink-0 rounded-full px-2 py-[1px] text-[12px] font-medium [font-variant-numeric:tabular-nums] ${fills.left ? "bg-bone text-inkMuted" : "bg-success/10 text-success"}`}
        >
          {fills.left ? `${fills.left} of ${total} left` : "All filled in"}
        </p>
      </div>
      {groups.map((g) => (
        <fieldset key={g.key} data-testid={`blanks-group-${g.key}`} className="mt-4 min-w-0 first-of-type:mt-3.5">
          {titled ? (
            <legend className="mb-2 flex w-full items-baseline gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-inkMuted">{g.title}</span>
              <span className="text-[12px] text-inkLight">{g.note}</span>
            </legend>
          ) : null}
          <div className="grid grid-cols-1 items-start gap-x-4 gap-y-3 sm:grid-cols-2">
            {g.blanks.map((b) => (
              <BlankField key={b} fills={fills} blank={b} index={index.get(b) ?? 0} />
            ))}
          </div>
        </fieldset>
      ))}
      {empty.length ? (
        <div data-testid="blanks-footer" className="mt-3 grid gap-1">
          {missing.map((source) => (
            <FooterMissing key={source} source={source} />
          ))}
          {unread ? (
            <p data-testid="blank-footer-unread" role="status" className="text-[14px] leading-5 text-ink">
              Could not read your footer settings. Trying again.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
