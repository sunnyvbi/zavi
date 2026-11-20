import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useSetupOn, useSetupOptional } from "./SetupProvider";
import { IMPORT_POLL_MS, namesOf, summarizeReads } from "./importReads";
import { displayedFacts, EMPTY_FORM, formFromFacts, type CompanyForm } from "./polish";

const FIELD_LABEL: Record<string, string> = {
  company_name: "company name",
  domain: "website",
  what_we_sell: "one-liner",
  competitors: "competitors",
};
const FILLABLE = ["company_name", "what_we_sell", "competitors"] as const;
export type Fillable = (typeof FILLABLE)[number];
const AFTER_LABEL: Record<Fillable, string> = { company_name: "Company name", what_we_sell: "What you do", competitors: "Competitors" };
type Val = string | string[];
const same = (a: Val, b: Val) => JSON.stringify(a) === JSON.stringify(b);
const isFillable = (k: string): k is Fillable => (FILLABLE as readonly string[]).includes(k);

const GAVE_UP = 3;
const COMPETITOR_TRIES = 3;
const COMPETITOR_SUGGESTIONS = "/api/connectors/company-facts/competitor-suggestions";

export function useSetupPolishForm(onFinish: (problems: string[]) => Promise<void>) {
  const setup = useSetupOn();
  const ctx = useSetupOptional();
  const files = ctx?.imports?.files;
  const reads = useMemo(() => summarizeReads(files), [files]);
  const [before, setBefore] = useState<CompanyForm>(EMPTY_FORM);
  const [form, setForm] = useState<CompanyForm>(EMPTY_FORM);
  const [compDraft, setCompDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [factsRead, setFactsRead] = useState<"loading" | "ok" | "failed">("loading");
  const importsLoaded = !ctx?.imports || ctx.imports.files !== null;
  const importsGaveUp = !importsLoaded && (ctx?.imports?.failures ?? 0) >= GAVE_UP;
  const importsSettled = importsLoaded || importsGaveUp;
  const prefillSettled = factsRead !== "loading" && importsSettled;
  const prefillFailed = factsRead === "failed";

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch("/api/connectors/company-facts");
        const body = (await res.json().catch(() => null)) as { facts?: Array<{ key: string; value_text: string | null }> } | null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const f = formFromFacts(body?.facts ?? []);
        setBefore(f);
        setForm(f);
        setFactsRead("ok");
      } catch {
        setFactsRead("failed");
      }
    })();
  }, []);

  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [fromFile, setFromFile] = useState<Partial<Record<Fillable, { file: string; guess: Val }>>>({});
  const [sugg, setSugg] = useState<Partial<Record<Fillable, { file: string; value: Val }>>>({});
  const factsReadRef = useRef(factsRead);
  const live = useRef({ form, before, touched });
  useLayoutEffect(() => {
    factsReadRef.current = factsRead;
    live.current = { form, before, touched };
  }, [factsRead, form, before, touched]);
  const [seenDone, setSeenDone] = useState<ReadonlySet<string>>(() => new Set());
  const [retryTick, setRetryTick] = useState(0);
  const [factsFailures, setFactsFailures] = useState(0);
  const factsBusy = useRef(false);
  const retryTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
  }, []);
  const unseen = useMemo(() => factsRead !== "loading" ? reads.done.filter((f) => !seenDone.has(f.id)) : [], [factsRead, reads.done, seenDone]);
  const factsGaveUp = unseen.length > 0 && factsFailures >= GAVE_UP;
  const awaitingFileFacts = unseen.length > 0 && !factsGaveUp;
  useEffect(() => {
    if (!unseen.length || factsBusy.current) return;
    const fresh = unseen;
    factsBusy.current = true;
    const file = namesOf(fresh);
    const retry = () => {
      setFactsFailures((n) => n + 1);
      retryTimer.current = window.setTimeout(() => setRetryTick((n) => n + 1), IMPORT_POLL_MS);
    };
    void (async () => {
      try {
        const res = await apiFetch("/api/connectors/company-facts");
        const body = (await res.json().catch(() => null)) as { facts?: Array<{ key: string; value_text: string | null }> } | null;
        if (!res.ok) {
          retry();
          return;
        }
        const next = formFromFacts(body?.facts ?? []);
        const { form: cur, before: was, touched: mine } = live.current;
        const before2: CompanyForm = { ...was };
        const recovered = !mine.has("domain") && factsReadRef.current === "failed";
        if (recovered) before2.domain = next.domain;
        const tags: Partial<Record<Fillable, { file: string; guess: Val }>> = {};
        const offers: Partial<Record<Fillable, { file: string; value: Val }>> = {};
        for (const k of FILLABLE) {
          if (same(next[k], was[k])) continue;
          if (!mine.has(k)) tags[k] = { file, guess: cur[k] };
          else if (!same(cur[k], next[k])) offers[k] = { file, value: next[k] };
          (before2 as Record<string, Val>)[k] = next[k];
        }
        setForm((f) => {
          const out: CompanyForm = { ...f };
          for (const k of Object.keys(tags) as Fillable[]) {
            if (!live.current.touched.has(k)) (out as Record<string, Val>)[k] = next[k];
          }
          if (recovered && !live.current.touched.has("domain")) out.domain = next.domain;
          return out;
        });
        setFactsRead("ok");
        setFactsFailures(0);
        setBefore(before2);
        setFromFile((t) => ({ ...t, ...tags }));
        setSugg((o) => ({ ...o, ...offers }));
        setSeenDone((seen) => new Set([...seen, ...fresh.map((f) => f.id)]));
      } catch {
        retry();
      } finally {
        factsBusy.current = false;
      }
    })();
  }, [unseen, retryTick]);

  const [compSearch, setCompSearch] = useState<"idle" | "loading" | "found" | "none">("idle");
  const compAsked = useRef(false);
  useEffect(() => {
    if (factsRead !== "ok" || compAsked.current) return;
    compAsked.current = true;
    if (before.competitors.length > 0) return;
    setCompSearch("loading");
    void (async () => {
      let names: string[] = [];
      for (let i = 0; i < COMPETITOR_TRIES; i++) {
        try {
          const res = await apiFetch(COMPETITOR_SUGGESTIONS, { method: "POST" });
          const body = (await res.json().catch(() => null)) as { competitors?: unknown; pending?: boolean } | null;
          if (!res.ok) break;
          names = Array.isArray(body?.competitors) ? body.competitors.filter((c): c is string => typeof c === "string" && c.trim() !== "").map((c) => c.trim()) : [];
          if (!body?.pending) break;
        } catch {
          break;
        }
      }
      if (!names.length) {
        setCompSearch("none");
        return;
      }
      setForm((f) => {
        const have = new Set(f.competitors.map((c) => c.toLowerCase()));
        return { ...f, competitors: [...f.competitors, ...names.filter((n) => !have.has(n.toLowerCase()))] };
      });
      setBefore((b) => (b.competitors.length ? b : { ...b, competitors: names }));
      setCompSearch("found");
    })();
  }, [factsRead, before.competitors.length]);

  const edit = (k: string, next: CompanyForm) => {
    setForm(next);
    if (!touched.has(k)) setTouched((t) => new Set(t).add(k));
    if (isFillable(k) && fromFile[k]) setFromFile((t) => { const o = { ...t }; delete o[k]; return o; });
  };
  const useGuess = (k: Fillable) => {
    const tag = fromFile[k];
    if (tag) edit(k, { ...form, [k]: tag.guess } as CompanyForm);
  };
  const useFileValue = (k: Fillable) => {
    const offer = sugg[k];
    if (!offer) return;
    setForm({ ...form, [k]: offer.value } as CompanyForm);
    setSugg((o) => { const n = { ...o }; delete n[k]; return n; });
  };
  const keepMine = (k: Fillable) => setSugg((o) => { const n = { ...o }; delete n[k]; return n; });
  const readingName = reads.reading.length ? namesOf(reads.reading) : null;
  const finish = async () => {
    setBusy(true);
    const problems: string[] = [];
    const fileUnknown = !!readingName || factsGaveUp || importsGaveUp;
    const leftToFile: Fillable[] = fileUnknown ? FILLABLE.filter((k) => !touched.has(k) && !fromFile[k]) : [];
    ctx?.setAfterRead?.(
      readingName
        ? {
            files: reads.reading.map((f) => f.id),
            untouched: leftToFile.map((k) => ({ key: k, label: AFTER_LABEL[k], value: Array.isArray(form[k]) ? (form[k] as string[]).join(", ") : (form[k] as string) })),
          }
        : null,
    );
    const skip = new Set<string>(leftToFile);
    for (const fact of displayedFacts(form, before).filter((f) => !skip.has(f.key))) {
      const label = FIELD_LABEL[fact.key] ?? fact.key;
      try {
        const res = await apiFetch("/api/connectors/company-facts", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ facts: [fact] }),
        });
        const body = (await res.json().catch(() => null)) as { rejected?: Array<{ dropped: string[] }> } | null;
        if (!res.ok) problems.push(label);
        else if ((body?.rejected ?? []).some((r) => r.dropped.length > 0)) problems.push(`some ${label}`);
      } catch {
        problems.push(label);
      }
    }
    try { await onFinish(problems); } finally { setBusy(false); }
  };

  const dirty = touched.size > 0 || compDraft.trim() !== "";
  const fromFiles = reads.facts > 0 || (setup?.docs.facts ?? 0) > 0;
  return {
    before, form, compDraft, setCompDraft, busy, prefillSettled, prefillFailed,
    touched, fromFile, sugg, importsGaveUp, factsGaveUp, awaitingFileFacts,
    compSearch, edit, useGuess, useFileValue, keepMine, readingName, finish, fromFiles, dirty,
  };
}
