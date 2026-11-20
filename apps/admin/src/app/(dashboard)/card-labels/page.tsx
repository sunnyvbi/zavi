"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type Queue = "quick" | "technical";
type Answer = "yes" | "no" | "skip";
type QKey = "WORTH_NOW" | "STEPS_FOLLOWABLE" | "TRUE" | "RIGHT_GOAL";

type Card = {
  id: string;
  pilot: boolean;
  title: string;
  body: string;
  gist: string;
  deliverable: { label: string | null; content: string } | null;
  how_to: string[];
  steps_kind: "real" | "generic" | "none";
  proposed_at: string;
  company: { name: string; site: string | null; about: string[] };
  channel: { slug: string; label: string; description: string | null };
  based_on?: string[];
  facts?: { key: string; value: string }[];
  right_goal_applies?: boolean;
  evidence?: { blocks: { tool: string; input: string; output: string }[]; clipped: boolean };
  live_pages?: string[];
};

type NextResponse = {
  batch: { id: string; is_creator?: boolean } | null;
  queue: Queue;
  progress?: { total: number; done: number };
  people?: Person[];
  card?: Card | null;
};

type Person = { key: string; name: string; total: number; done: number };
const PERSON_KEY = "card-labels-person";

const QUESTIONS: Record<QKey, { label: string; hint: string; rule: string }> = {
  WORTH_NOW: {
    label: "Would a sensible founder of this company do this now?",
    hint: "An action they can take today that could help them grow.",
    rule: "Yes only if all three hold: it is something the founder or their team can do (not an observation, a status note, or a job for the tool itself); it is addressed to the founder; and it could plausibly help this company grow, with the card saying why. Do not say No just because another card suggests the same thing: repeats are checked separately.",
  },
  STEPS_FOLLOWABLE: {
    label: "Could the founder follow the steps alone?",
    hint: "Each step is one action, names the exact screen or setting, and nothing is missing.",
    rule: "Yes if each step is one action, names the exact screen, setting or page, the steps are in order, and every setting needed is on the card. No if they would need help or another card.",
  },
  TRUE: {
    label: "Backed by what it read?",
    hint: "Every specific fact about this company appears in what the run read or the stored company facts.",
    rule: "Only specific facts about this company count: numbers, prices, cities, what a page says, what is or is not set up. Advice and opinions are not facts. No if any fact is contradicted by the evidence or appears nowhere in it. The AI judge also re-reads the first part of the pages the run fetched (links in the evidence panel), so a fact near the top of one of those pages counts as backed. Ignore tiny mismatches that would not mislead the founder. Not sure if the fact is about something the evidence could not show.",
  },
  RIGHT_GOAL: {
    label: "Is it judged against its own goal?",
    hint: "An existing campaign, page or post is measured on what it was set up to do.",
    rule: "No if the card judges or changes something using a result it was not set up to produce (for example an awareness or engagement campaign judged on sign-ups or sales) without saying so and offering to keep it as it is. Not sure if the card does not judge the results of something that exists.",
  },
};

const QUEUE_QS: Record<Queue, QKey[]> = { quick: ["WORTH_NOW", "STEPS_FOLLOWABLE"], technical: ["TRUE", "RIGHT_GOAL"] };
const SEED_SECONDS: Record<Queue, number> = { quick: 15, technical: 40 };
const ANSWER_LABEL: Record<Answer, string> = { yes: "Yes", no: "No", skip: "Not sure" };

function autoAnswers(queue: Queue, card: Card): Partial<Record<QKey, { answer: Answer; why: string }>> {
  if (queue === "quick") {
    if (card.steps_kind === "generic") return { STEPS_FOLLOWABLE: { answer: "no", why: "Only the template steps (\"make the change this card describes\")." } };
    if (card.steps_kind === "none") return { STEPS_FOLLOWABLE: { answer: "skip", why: "This card has no steps." } };
    return {};
  }
  if (!card.right_goal_applies) return { RIGHT_GOAL: { answer: "skip", why: "This card does not judge the results of an existing campaign, page or post." } };
  return {};
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

export default function CardLabelsPage() {
  const [queue, setQueue] = useState<Queue>("quick");
  const [person, setPerson] = useState<string | null>(null);
  const [personReady, setPersonReady] = useState(false);
  const [data, setData] = useState<NextResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Partial<Record<QKey, Answer>>>({});
  const [overridden, setOverridden] = useState<Set<QKey>>(new Set());
  const [focus, setFocus] = useState<QKey | null>(null);
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [seen, setSeen] = useState(0);
  const durations = useRef<number[]>([]);
  const loadId = useRef(0);
  const shownAt = useRef<number>(Date.now());

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("queue");
    if (q === "technical") setQueue("technical");
    try {
      setPerson(window.localStorage.getItem(PERSON_KEY));
    } catch {
    }
    setPersonReady(true);
  }, []);

  const load = useCallback(async (q: Queue, who: string | null) => {
    const id = ++loadId.current;
    setError(null);
    try {
      const res = await adminApiFetch(`/api/admin/card-labels/next?queue=${q}${who ? `&as=${encodeURIComponent(who)}` : ""}`);
      const body = await res.json().catch(() => ({}));
      if (id !== loadId.current) return;
      if (body?.error?.code === "unknown_labeller") {
        try {
          window.localStorage.removeItem(PERSON_KEY);
        } catch {
        }
        setPerson(null);
        return;
      }
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      const next = body as NextResponse;
      setData(next);
      setNote("");
      setShowNote(false);
      setOverridden(new Set());
      const auto = next.card ? autoAnswers(q, next.card) : {};
      const pre: Partial<Record<QKey, Answer>> = {};
      for (const [k, v] of Object.entries(auto)) pre[k as QKey] = v!.answer;
      setAnswers(pre);
      setFocus(QUEUE_QS[q].find((k) => !(k in pre)) ?? null);
      shownAt.current = Date.now();
      window.scrollTo({ top: 0 });
    } catch (e) {
      if (id === loadId.current) setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (personReady) void load(queue, person);
  }, [queue, person, personReady, load]);

  const switchPerson = (key: string) => {
    if (key === person || saving) return;
    try {
      window.localStorage.setItem(PERSON_KEY, key);
    } catch {
    }
    durations.current = [];
    setSeen(0);
    setData(null);
    setPerson(key);
  };

  const switchQueue = (q: Queue) => {
    if (q === queue) return;
    const url = new URL(window.location.href);
    if (q === "technical") url.searchParams.set("queue", "technical");
    else url.searchParams.delete("queue");
    window.history.replaceState(null, "", url.toString());
    durations.current = [];
    setData(null);
    setQueue(q);
  };

  const card = person ? (data?.card ?? null) : null;
  const auto = card ? autoAnswers(queue, card) : {};
  const asked = QUEUE_QS[queue].filter((k) => !(k in auto) || overridden.has(k));
  const allAnswered = QUEUE_QS[queue].every((k) => answers[k]);

  const answer = (k: QKey, a: Answer) => {
    const nextAnswers = { ...answers, [k]: a };
    setAnswers(nextAnswers);
    setFocus(asked.find((q) => q !== k && !nextAnswers[q]) ?? k);
  };

  const save = useCallback(async () => {
    if (!data?.batch || !card || !allAnswered || saving) return;
    setSaving(true);
    setError(null);
    const autoKeys = QUEUE_QS[queue].filter((k) => k in auto && !overridden.has(k));
    try {
      const res = await adminApiFetch(`/api/admin/card-labels/${data.batch.id}/${card.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queue, as: person, answers, auto: autoKeys, note: note.trim() || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      durations.current = [...durations.current.slice(-9), (Date.now() - shownAt.current) / 1000];
      setSeen((n) => n + 1);
      await load(queue, person);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [data, card, allAnswered, saving, queue, person, auto, overridden, answers, note, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
        if (e.key === "Escape") el.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || !card) return;
      const k = e.key.toLowerCase();
      if (focus && (k === "y" || k === "n" || k === "u")) {
        e.preventDefault();
        answer(focus, k === "y" ? "yes" : k === "n" ? "no" : "skip");
      } else if (e.key === "Enter") {
        e.preventDefault();
        void save();
      } else if (e.key === "/") {
        e.preventDefault();
        setShowNote(true);
        setTimeout(() => document.getElementById("label-note")?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const createBatch = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await adminApiFetch("/api/admin/card-labels/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setConfirmBatch(false);
      await load(queue, person);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const left = data?.progress ? data.progress.total - data.progress.done : 0;
  const pace = durations.current.length >= 3 ? median(durations.current) : SEED_SECONDS[queue];
  const minutesLeft = Math.max(1, Math.round((left * pace) / 60));

  return (
    <div className={`${queue === "technical" ? "max-w-6xl" : "max-w-2xl"} mx-auto p-6 pb-24`}>
      <div className="text-xs uppercase tracking-[0.2em] text-sky-700">Zavi · admin</div>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <h1 className="font-display font-semibold text-2xl text-slate-900">Card labels</h1>
        <div className="flex rounded-lg border border-slate-200 bg-white p-0.5 text-sm">
          {(["quick", "technical"] as Queue[]).map((q) => (
            <button
              key={q}
              type="button"
              disabled={saving}
              onClick={() => switchQueue(q)}
              className={`rounded-md px-3 py-1.5 ${queue === q ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
            >
              {q === "quick" ? "Quick questions" : "Facts & goal"}
            </button>
          ))}
        </div>
      </div>

      {data?.batch && data.people && (
        <div className="mt-4">
          <div className="text-xs text-slate-500">{person ? "Labelling as" : "Who is labelling? Pick yourself to start."}</div>
          <div className="mt-1 flex flex-wrap gap-2">
            {data.people.map((p) => {
              const left = p.total - p.done;
              return (
                <button
                  key={p.key}
                  type="button"
                  disabled={saving}
                  onClick={() => switchPerson(p.key)}
                  className={`rounded-lg border px-3 py-2 text-left text-sm ${person === p.key ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}
                >
                  <span className="font-medium">{p.name}</span>
                  <span className={`ml-2 ${person === p.key ? "text-slate-300" : "text-slate-500"}`}>
                    {left === 0 ? "all done" : `${left} left of ${p.total}`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {error && <div className="mt-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
      {!data && !error && <div className="mt-6 text-sm text-slate-500">Loading…</div>}

      {data && !data.batch && (
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-700">
          No labelling batch yet.
          <BatchButton confirm={confirmBatch} setConfirm={setConfirmBatch} onCreate={createBatch} busy={saving} />
        </div>
      )}

      {person && data?.batch && data.progress && !card && (
        <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-900">
          All done here: {data.progress.done} of {data.progress.total} cards. Thank you.
        </div>
      )}

      {card && data?.progress && (
        <>
          <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
            <span>
              {left} cards left · about {minutesLeft} min at your pace
            </span>
            <div className="h-2 w-40 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full bg-sky-600" style={{ width: `${Math.round((100 * data.progress.done) / Math.max(1, data.progress.total))}%` }} />
            </div>
          </div>
          {card.pilot && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Pilot card. If a question is unclear on this card, say so in a note (press /).
            </div>
          )}

          {queue === "quick" ? <QuickCard card={card} /> : <TechnicalCard card={card} />}

          <section className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-white p-5">
            {QUEUE_QS[queue].map((k) => {
              const a = auto[k];
              if (a && !overridden.has(k)) {
                return (
                  <div key={k} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
                    <span>
                      <span className="font-medium text-slate-800">{QUESTIONS[k].label}</span> {ANSWER_LABEL[a.answer]} · set automatically. {a.why}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setOverridden(new Set([...overridden, k]));
                        setAnswers((prev) => {
                          const n = { ...prev };
                          delete n[k];
                          return n;
                        });
                        setFocus(k);
                      }}
                      className="text-sky-700 underline"
                    >
                      {k === "RIGHT_GOAL" ? "Ask it anyway" : "Change"}
                    </button>
                  </div>
                );
              }
              return (
                <QuestionRow
                  key={k}
                  qk={k}
                  focused={focus === k}
                  value={answers[k]}
                  openRule={seen < 3}
                  onFocus={() => setFocus(k)}
                  onAnswer={(v) => answer(k, v)}
                  steps={queue === "quick" && k === "STEPS_FOLLOWABLE" ? card.how_to : undefined}
                />
              );
            })}

            {showNote ? (
              <textarea
                id="label-note"
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 1000))}
                placeholder="What is wrong, or what is unclear about the question"
                className="w-full rounded-md border border-slate-300 p-2 text-sm"
                rows={2}
              />
            ) : (
              <button type="button" onClick={() => setShowNote(true)} className="text-sm text-slate-500 underline">
                Add a note (/)
              </button>
            )}
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={!allAnswered || saving}
                onClick={() => void save()}
                className="rounded-md bg-slate-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                {saving ? "Saving…" : "Save and next (Enter)"}
              </button>
              <span className="text-xs text-slate-500">Keys: Y yes · N no · U not sure</span>
            </div>
          </section>
        </>
      )}

      {data?.batch?.is_creator && (
        <div className="mt-10 border-t border-slate-200 pt-4 text-xs text-slate-500">
          <BatchButton confirm={confirmBatch} setConfirm={setConfirmBatch} onCreate={createBatch} busy={saving} small />
        </div>
      )}
    </div>
  );
}

function CompanyLine({ card }: { card: Card }) {
  return (
    <div className="text-sm text-slate-600">
      <span className="font-medium text-slate-900">{card.company.name}</span> · {card.channel.label}
      {card.company.site && (
        <a href={card.company.site} target="_blank" rel="noopener noreferrer" className="ml-2 text-sky-700 underline">
          their site
        </a>
      )}
      {card.company.about[0] && <div className="mt-0.5 text-xs text-slate-500">{card.company.about.join(" ")}</div>}
    </div>
  );
}

function Draft({ card }: { card: Card }) {
  if (!card.deliverable) return null;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-sm text-sky-700">
        Show the draft ({card.deliverable.content.length.toLocaleString()} characters)
      </summary>
      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-700">{card.deliverable.content}</pre>
    </details>
  );
}

function QuickCard({ card }: { card: Card }) {
  const [whole, setWhole] = useState(false);
  useEffect(() => setWhole(false), [card.id]);
  const longer = card.body.replace(/\s+/g, " ").trim().length > card.gist.length;
  return (
    <section className="mt-4 rounded-lg border border-slate-200 bg-white p-5">
      <CompanyLine card={card} />
      <h2 className="mt-3 text-lg font-semibold text-slate-900">{card.title}</h2>
      <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{whole ? card.body : card.gist}</p>
      {longer && (
        <button type="button" onClick={() => setWhole(!whole)} className="mt-1 text-sm text-sky-700 underline">
          {whole ? "Show less" : "Read the whole card"}
        </button>
      )}
      <Draft card={card} />
    </section>
  );
}

function TechnicalCard({ card }: { card: Card }) {
  const ev = card.evidence ?? { blocks: [], clipped: false };
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <CompanyLine card={card} />
        <h2 className="mt-3 text-lg font-semibold text-slate-900">{card.title}</h2>
        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{card.body}</p>
        {card.how_to.length > 0 && (
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-800">
            {card.how_to.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        )}
        <Draft card={card} />
        {card.based_on && card.based_on.length > 0 && (
          <div className="mt-3 text-xs text-slate-500">
            <span className="font-medium">The card says it is based on:</span> {card.based_on.join(" · ")}
          </div>
        )}
      </section>
      <section className="rounded-lg border border-slate-200 bg-white p-5 lg:sticky lg:top-4 lg:max-h-[80vh] lg:overflow-auto">
        <div className="text-xs uppercase tracking-wide text-slate-500">What the run read</div>
        <p className="mt-1 text-xs text-slate-500">
          The same evidence the AI judge reads{ev.clipped ? ", clipped at the same size" : ""}. The judge also re-reads the pages
          below, but only the first ~25,000 characters of each page's text, and not pages that block it. Count a fact
          as backed only if it is near the top of one of them; if you are unsure, answer Not sure.
        </p>
        {card.live_pages && card.live_pages.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs">
            {card.live_pages.map((u) => (
              <li key={u}>
                <a href={u} target="_blank" rel="noopener noreferrer" className="break-all text-sky-700 underline">
                  {u}
                </a>
              </li>
            ))}
          </ul>
        )}
        {card.facts && card.facts.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium text-slate-800">Stored company facts ({card.facts.length})</summary>
            <dl className="mt-2 space-y-1 text-xs text-slate-700">
              {card.facts.map((f) => (
                <div key={f.key}>
                  <dt className="inline font-mono text-slate-500">{f.key}: </dt>
                  <dd className="inline">{f.value}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
        {ev.blocks.length === 0 && <p className="mt-3 text-sm text-slate-600">No stored tool results for this run.</p>}
        {ev.blocks.map((b, i) => (
          <details key={i} className="mt-3" open={i === 0}>
            <summary className="cursor-pointer font-mono text-xs text-slate-700">
              {b.tool} {b.input && <span className="text-slate-400">· {b.input.slice(0, 120)}</span>}
            </summary>
            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-700">{b.output}</pre>
          </details>
        ))}
      </section>
    </div>
  );
}

function QuestionRow({
  qk,
  focused,
  value,
  openRule,
  onFocus,
  onAnswer,
  steps,
}: {
  qk: QKey;
  focused: boolean;
  value: Answer | undefined;
  openRule: boolean;
  onFocus: () => void;
  onAnswer: (a: Answer) => void;
  steps?: string[];
}) {
  const q = QUESTIONS[qk];
  return (
    <div onClick={onFocus} className={`rounded-md border px-3 py-3 ${focused ? "border-sky-300 bg-sky-50/40" : "border-transparent"}`}>
      <div className="font-medium text-slate-900">{q.label}</div>
      <div className="mt-0.5 text-xs text-slate-500">{q.hint}</div>
      {steps && steps.length > 0 && (
        <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-sm text-slate-700">
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      <details className="mt-1" open={openRule}>
        <summary className="cursor-pointer text-xs text-sky-700">What counts as yes?</summary>
        <p className="mt-1 text-xs text-slate-600">{q.rule}</p>
      </details>
      <div className="mt-2 flex gap-2">
        {(["yes", "no", "skip"] as Answer[]).map((a) => (
          <button
            key={a}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAnswer(a);
            }}
            className={`rounded-full border px-4 py-1.5 text-sm ${
              value === a
                ? a === "yes"
                  ? "border-emerald-600 bg-emerald-600 text-white"
                  : a === "no"
                    ? "border-rose-600 bg-rose-600 text-white"
                    : "border-slate-500 bg-slate-500 text-white"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {ANSWER_LABEL[a]}
          </button>
        ))}
      </div>
    </div>
  );
}

function BatchButton({
  confirm,
  setConfirm,
  onCreate,
  busy,
  small = false,
}: {
  confirm: boolean;
  setConfirm: (v: boolean) => void;
  onCreate: () => void;
  busy: boolean;
  small?: boolean;
}) {
  return (
    <div className={small ? "" : "mt-3"}>
      {!confirm ? (
        <button
          type="button"
          onClick={() => setConfirm(true)}
          className={small ? "underline" : "rounded-md border border-slate-300 px-4 py-1.5 text-sm"}
        >
          {small ? "Start a new labelling batch" : "Create labelling batch (200 cards)"}
        </button>
      ) : (
        <span className="text-sm">
          Start a new batch of 200 cards? It replaces the current one for everyone.{" "}
          <button type="button" disabled={busy} onClick={onCreate} className="ml-2 rounded-md bg-slate-900 px-3 py-1 text-white">
            Yes, create
          </button>
          <button type="button" onClick={() => setConfirm(false)} className="ml-2 text-slate-600 underline">
            Cancel
          </button>
        </span>
      )}
    </div>
  );
}
