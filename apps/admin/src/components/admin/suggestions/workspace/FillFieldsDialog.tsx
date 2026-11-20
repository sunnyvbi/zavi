"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import type { CompanyEstimatedField, CompanyFieldMethod, CompanyFillableFieldKey } from "@zavi/shared";
import { COMPANY_FILLABLE_FIELD_KEYS } from "@zavi/shared";
import { adminApiFetch } from "@/lib/api-admin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToneBadge, type Tone } from "../ui";
import type { ProfileField } from "./types";

type FillState =
  | { status: "idle" }
  | { status: "running"; requestId: string; runId: string | null }
  | { status: "complete"; requestId: string; runId: string }
  | { status: "failed"; message: string };

type Draft = CompanyEstimatedField & { include: boolean };

const CONFIDENCE_TONE: Record<string, Tone> = { high: "good", medium: "warn", low: "bad" };
const METHOD_LABEL: Record<CompanyFieldMethod, string> = {
  calculated: "AI-calculated",
  recorded: "AI-recalled",
  inferred: "AI-inferred",
};
const POLL_MS = 3000;

const FILLABLE = new Set<string>(COMPANY_FILLABLE_FIELD_KEYS);

export function fillableEmptyFields(fields: ProfileField[]): ProfileField[] {
  return fields.filter((field) => field.value === null && FILLABLE.has(field.key));
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message || fallback;
}

export function FillFieldsDialog({
  tenantId,
  fields,
  open,
  onOpenChange,
  onSaved,
}: {
  tenantId: string;
  fields: ProfileField[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [fill, setFill] = useState<FillState>({ status: "idle" });
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [unfilled, setUnfilled] = useState<Array<{ key: string; reason: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const autoStartedRef = useRef(false);
  const labelOf = (key: string) => fields.find((field) => field.key === key)?.label ?? key;

  const clearPoll = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => () => clearPoll(), [clearPoll]);

  useEffect(() => {
    if (open) return;
    autoStartedRef.current = false;
    generationRef.current += 1;
    clearPoll();
    setFill({ status: "idle" });
    setDrafts([]);
    setUnfilled([]);
    setSaveError(null);
  }, [open, clearPoll]);

  const poll = useCallback(
    async (runId: string, requestId: string, generation: number) => {
      try {
        const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/company-fields/fill/${runId}`);
        if (generation !== generationRef.current) return;
        if (!res.ok) throw new Error(await errorMessage(res, `HTTP ${res.status}`));
        const body = (await res.json()) as {
          status: "running" | "complete" | "failed";
          error?: string;
          fields?: CompanyEstimatedField[];
          unfilled?: Array<{ key: string; reason: string }>;
        };
        if (body.status === "running") {
          timerRef.current = setTimeout(() => void poll(runId, requestId, generation), POLL_MS);
          return;
        }
        if (body.status === "complete") {
          setDrafts((body.fields ?? []).map((field) => ({ ...field, include: true })));
          setUnfilled(body.unfilled ?? []);
          setFill({ status: "complete", requestId, runId });
          return;
        }
        setFill({ status: "failed", message: body.error || "The AI fill did not complete." });
      } catch (error) {
        if (generation !== generationRef.current) return;
        setFill({ status: "failed", message: error instanceof Error ? error.message : "The AI fill failed." });
      }
    },
    [tenantId],
  );

  const start = useCallback(async () => {
    const keys = fields.map((field) => field.key as CompanyFillableFieldKey);
    if (keys.length === 0) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    clearPoll();
    const requestId = crypto.randomUUID();
    setDrafts([]);
    setUnfilled([]);
    setSaveError(null);
    setFill({ status: "running", requestId, runId: null });
    try {
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/company-fields/fill`, {
        method: "POST",
        body: JSON.stringify({ keys, request_id: requestId }),
      });
      if (generation !== generationRef.current) return;
      if (!res.ok) throw new Error(await errorMessage(res, `HTTP ${res.status}`));
      const body = (await res.json()) as { run_id: string };
      setFill({ status: "running", requestId, runId: body.run_id });
      timerRef.current = setTimeout(() => void poll(body.run_id, requestId, generation), POLL_MS);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setFill({ status: "failed", message: error instanceof Error ? error.message : "The AI fill could not start." });
    }
  }, [clearPoll, fields, poll, tenantId]);

  useEffect(() => {
    if (!open || autoStartedRef.current || fields.length === 0) return;
    autoStartedRef.current = true;
    void start();
  }, [open, fields.length, start]);

  const selected = drafts.filter((draft) => draft.include && draft.value.trim());
  const canSave = fill.status === "complete" && selected.length > 0 && !saving;

  async function save() {
    if (fill.status !== "complete" || !canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/company-fields`, {
        method: "POST",
        body: JSON.stringify({
          run_id: fill.runId,
          request_id: fill.requestId,
          fields: selected.map(({ include: _include, ...field }) => ({ ...field, value: field.value.trim() })),
        }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, `HTTP ${res.status}`));
      onSaved();
      onOpenChange(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save the reviewed fields.");
    } finally {
      setSaving(false);
    }
  }

  function update(key: string, patch: Partial<Draft>) {
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-32px)] w-[calc(100%-32px)] gap-0 overflow-y-auto rounded-[15px] border-0 p-0 shadow-[0_24px_40px_rgba(16,24,39,0.29)] sm:max-w-[640px] [&>button]:right-5 [&>button]:top-5 [&>button]:rounded-full [&>button]:p-1 [&>button>svg]:size-5">
        <DialogHeader className="border-b border-border/60 px-5 pb-4 pt-5 pr-14">
          <DialogTitle className="flex items-center gap-2 text-left text-xl font-semibold leading-7 text-[#11192d]">
            <Sparkles className="size-5" />
            Fill missing fields with AI
          </DialogTitle>
          <DialogDescription className="text-left">
            Values come from the company brain, Stripe and Your database with formulas shown — review, edit, then approve.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-5 py-4">
          {fields.length === 0 && (
            <p className="text-sm text-muted-foreground">Every fillable field already has a value.</p>
          )}

          {fill.status === "running" && (
            <div role="status" aria-live="polite" className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
              <div>
                <p className="text-sm font-medium">Zavi is working through {fields.length} empty field{fields.length === 1 ? "" : "s"}…</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Searching memory, then querying Stripe and Your database and computing what isn't recorded.
                  This usually takes a few minutes.
                </p>
              </div>
            </div>
          )}

          {fill.status === "failed" && (
            <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
              <p className="text-sm text-destructive">{fill.message}</p>
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void start()}>
                <RefreshCw className="size-4" />
                Retry
              </Button>
            </div>
          )}

          {fill.status === "complete" && drafts.length === 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              Zavi could not ground any of these fields in the data it can reach, so nothing was estimated.
            </p>
          )}

          {drafts.map((draft) => (
            <div key={draft.key} className={`space-y-3 rounded-xl border p-4 ${draft.include ? "" : "opacity-60"}`}>
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-foreground"
                  checked={draft.include}
                  aria-label={`Include ${labelOf(draft.key)}`}
                  onChange={(event) => update(draft.key, { include: event.target.checked })}
                />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold">{labelOf(draft.key)}</p>
                    <ToneBadge tone="warn">{METHOD_LABEL[draft.method] ?? "AI-estimated"}</ToneBadge>
                    {draft.confidence && (
                      <ToneBadge tone={CONFIDENCE_TONE[draft.confidence] ?? "flat"} dot>
                        {draft.confidence} confidence
                      </ToneBadge>
                    )}
                  </div>
                  <Input
                    value={draft.value}
                    aria-label={`${labelOf(draft.key)} value`}
                    onChange={(event) => update(draft.key, { value: event.target.value })}
                  />
                  {draft.method === "calculated" && (
                    <div className="space-y-1.5 rounded-md bg-muted/60 px-3 py-2 text-xs">
                      <p>
                        <span className="font-medium">Formula:</span>{" "}
                        <span className="text-muted-foreground">{draft.formula || "not stated"}</span>
                      </p>
                      {draft.inputs.length > 0 && (
                        <ul className="space-y-0.5 text-muted-foreground">
                          {draft.inputs.map((input, index) => (
                            <li key={index}>
                              {input.name}: <span className="text-foreground">{input.value}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  <Textarea
                    value={draft.assumptions}
                    rows={2}
                    placeholder="Assumptions / how this was derived"
                    aria-label={`${labelOf(draft.key)} assumptions`}
                    className="text-xs"
                    onChange={(event) => update(draft.key, { assumptions: event.target.value })}
                  />
                  <Textarea
                    value={draft.caveats}
                    rows={2}
                    placeholder="Caveats (sample size, proxies, truncation)"
                    aria-label={`${labelOf(draft.key)} caveats`}
                    className="text-xs"
                    onChange={(event) => update(draft.key, { caveats: event.target.value })}
                  />
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>Source:</span>
                    <Input
                      value={draft.source}
                      aria-label={`${labelOf(draft.key)} source`}
                      className="h-7 max-w-xs text-xs"
                      onChange={(event) => update(draft.key, { source: event.target.value })}
                    />
                  </div>
                  {draft.evidence.length > 0 && (
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {draft.evidence.map((item, index) => (
                        <li key={index}>· {item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          ))}

          {unfilled.length > 0 && (
            <div className="space-y-1.5 rounded-lg bg-muted/60 p-3">
              <p className="text-xs font-semibold uppercase text-muted-foreground">Left blank on purpose</p>
              {unfilled.map((row) => (
                <p key={row.key} className="text-xs text-muted-foreground">
                  <Badge variant="outline" className="mr-1.5 font-normal">{labelOf(row.key)}</Badge>
                  {row.reason}
                </p>
              ))}
            </div>
          )}

          {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
        </div>

        <DialogFooter className="gap-2 border-t border-border/60 px-5 pb-5 pt-3 sm:space-x-0">
          <Button type="button" variant="outline" className="rounded-xl shadow-none" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" className="rounded-xl bg-[#0e0f11] hover:bg-[#0e0f11]/90" disabled={!canSave} onClick={() => void save()}>
            {saving ? "Saving…" : `Approve ${selected.length} field${selected.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
