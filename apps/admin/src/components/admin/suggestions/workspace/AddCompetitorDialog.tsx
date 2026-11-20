"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { CompetitorProfileInput, CompetitorResearchResult } from "@zavi/shared";
import { adminApiFetch } from "@/lib/api-admin";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  areProfileFieldsLocked,
  isResearchableWebsite,
  matchesActiveResearch,
} from "./competitorResearchState";

type ResearchState =
  | { status: "idle" }
  | { status: "researching"; requestId: string; runId: string | null; website: string }
  | { status: "complete"; requestId: string; runId: string; website: string }
  | { status: "failed"; requestId: string; website: string; message: string };

const EMPTY: CompetitorProfileInput = {
  website: "",
  company_name: "",
  industry: "",
  positioning: "",
  target_audience: "",
  pricing: "",
  acquisition_channels: [],
  threat_level: "medium",
};

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message || fallback;
}

export function AddCompetitorDialog({
  tenantId,
  open,
  onOpenChange,
  onAdded,
  initialProfile = EMPTY,
  mode = "add",
}: {
  tenantId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
  initialProfile?: CompetitorProfileInput;
  mode?: "add" | "edit";
}) {
  const [form, setForm] = useState<CompetitorProfileInput>(() => initialProfile);
  const [channelsText, setChannelsText] = useState(() => initialProfile.acquisition_channels.join(", "));
  const [research, setResearch] = useState<ResearchState>({ status: "idle" });
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPoll = useCallback(() => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }, []);

  useEffect(() => () => clearPoll(), [clearPoll]);

  useEffect(() => {
    if (open) return;
    generationRef.current += 1;
    clearPoll();
    setForm(initialProfile);
    setChannelsText(initialProfile.acquisition_channels.join(", "));
    setResearch({ status: "idle" });
    setPublishError(null);
  }, [clearPoll, initialProfile, open]);

  const applyResult = useCallback((profile: CompetitorResearchResult) => {
    setForm({
      website: profile.website,
      company_name: profile.company_name,
      industry: profile.industry,
      positioning: profile.positioning,
      target_audience: profile.target_audience,
      pricing: profile.pricing,
      acquisition_channels: profile.acquisition_channels,
      threat_level: profile.threat_level,
    });
    setChannelsText(profile.acquisition_channels.join(", "));
  }, []);

  const poll = useCallback(async (
    runId: string,
    requestId: string,
    website: string,
    generation: number,
  ) => {
    try {
      const res = await adminApiFetch(
        `/api/admin/tenants/${tenantId}/competitors/research/${runId}`,
      );
      if (!res.ok) throw new Error(await errorMessage(res, `HTTP ${res.status}`));
      const body = (await res.json()) as {
        status: "researching" | "complete" | "failed";
        request_id: string;
        website: string;
        profile?: CompetitorResearchResult;
        error?: string;
      };
      if (!matchesActiveResearch({
        activeGeneration: generationRef.current,
        responseGeneration: generation,
        activeRequestId: requestId,
        responseRequestId: body.request_id,
        activeWebsite: website,
        responseWebsite: body.website,
      })) return;
      if (body.status === "researching") {
        pollTimerRef.current = setTimeout(
          () => void poll(runId, requestId, website, generation),
          2_000,
        );
        return;
      }
      if (body.status === "complete" && body.profile) {
        applyResult(body.profile);
        setResearch({ status: "complete", requestId, runId, website });
        return;
      }
      setResearch({
        status: "failed",
        requestId,
        website,
        message: body.error || "Research failed. Try again.",
      });
    } catch (error) {
      if (generationRef.current !== generation) return;
      setResearch({
        status: "failed",
        requestId,
        website,
        message: error instanceof Error ? error.message : "Research failed. Try again.",
      });
    }
  }, [applyResult, tenantId]);

  const startResearch = useCallback(async (website: string) => {
    if (!isResearchableWebsite(website)) return;
    clearPoll();
    const generation = ++generationRef.current;
    const requestId = crypto.randomUUID();
    setPublishError(null);
    setResearch({ status: "researching", requestId, runId: null, website });
    try {
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/competitors/research`, {
        method: "POST",
        body: JSON.stringify({ website, request_id: requestId }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, `HTTP ${res.status}`));
      const body = (await res.json()) as {
        run_id: string;
        request_id: string;
        website: string;
      };
      if (generationRef.current !== generation || body.request_id !== requestId) return;
      setForm((current) => ({ ...current, website: body.website }));
      setResearch({
        status: "researching",
        requestId,
        runId: body.run_id,
        website: body.website,
      });
      void poll(body.run_id, requestId, body.website, generation);
    } catch (error) {
      if (generationRef.current !== generation) return;
      setResearch({
        status: "failed",
        requestId,
        website,
        message: error instanceof Error ? error.message : "Research could not be started.",
      });
    }
  }, [clearPoll, poll, tenantId]);

  useEffect(() => {
    if (!open || research.status === "researching") return;
    const website = form.website.trim();
    if (!isResearchableWebsite(website)) return;
    if (
      (research.status === "complete" || research.status === "failed") &&
      research.website === website
    ) return;
    const timer = setTimeout(() => void startResearch(website), 650);
    return () => clearTimeout(timer);
  }, [form.website, open, research, startResearch]);

  const locked = areProfileFieldsLocked(research.status);
  const canPublish =
    research.status === "complete" &&
    research.website === form.website &&
    form.company_name.trim().length > 0 &&
    !publishing;

  async function publish() {
    if (research.status !== "complete" || !canPublish) return;
    setPublishing(true);
    setPublishError(null);
    try {
      const profile: CompetitorProfileInput = {
        ...form,
        acquisition_channels: channelsText
          .split(/[,;|]/)
          .map((value) => value.trim())
          .filter(Boolean),
      };
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/competitors`, {
        method: "POST",
        body: JSON.stringify({
          run_id: research.runId,
          request_id: research.requestId,
          profile,
        }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, `HTTP ${res.status}`));
      generationRef.current += 1;
      clearPoll();
      setForm(initialProfile);
      setChannelsText(initialProfile.acquisition_channels.join(", "));
      setResearch({ status: "idle" });
      onOpenChange(false);
      onAdded();
    } catch (error) {
      setPublishError(error instanceof Error ? error.message : "Could not save competitor.");
    } finally {
      setPublishing(false);
    }
  }

  function updateWebsite(website: string) {
    generationRef.current += 1;
    clearPoll();
    setForm((current) => ({ ...current, website }));
    setPublishError(null);
    setResearch({ status: "idle" });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-32px)] w-[calc(100%-32px)] gap-0 overflow-y-auto rounded-[15px] border-0 p-0 shadow-[0_24px_40px_rgba(16,24,39,0.29)] sm:max-w-[472px] [&>button]:right-5 [&>button]:top-5 [&>button]:rounded-full [&>button]:p-1 [&>button>svg]:size-5">
        <DialogHeader className="border-b border-border/60 px-5 pb-4 pt-5 pr-14">
          <DialogTitle className="text-left text-xl font-semibold leading-7 text-[#11192d]">
            {mode === "edit" ? "Edit competitor" : "Add a competitor"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Paste a public website. The Research Agent will fill the profile, then you can review it before saving.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-5 py-4">
          <Field label="Website" htmlFor="competitor-website">
            <Input
              id="competitor-website"
              type="url"
              placeholder="acme.com"
              value={form.website}
              disabled={locked}
              className="h-10 rounded-[10px] px-2.5 text-[15px] shadow-none"
              onChange={(event) => updateWebsite(event.target.value)}
            />
          </Field>

          {locked && (
            <div role="status" aria-live="polite" className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
              <div>
                <p className="text-sm font-medium">Researching this competitor…</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Reading the website and corroborating public sources. Profile fields are locked until this finishes.
                </p>
              </div>
            </div>
          )}

          {research.status === "failed" && (
            <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
              <p className="text-sm text-destructive">{research.message}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void startResearch(form.website)}
              >
                <RefreshCw className="size-4" />
                Retry research
              </Button>
            </div>
          )}

          {research.status === "complete" && (
            <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              Research complete. Review and edit every field before saving this competitor.
            </p>
          )}

          <fieldset disabled={locked} className="space-y-5 disabled:opacity-60">
            <Field label="Company Name" htmlFor="competitor-name">
              <Input id="competitor-name" placeholder="Acme Security" className="h-10 rounded-[10px] px-2.5 text-[15px] shadow-none" value={form.company_name} onChange={(e) => setForm((v) => ({ ...v, company_name: e.target.value }))} />
            </Field>
            <Field label="Industry" htmlFor="competitor-industry">
              <Input id="competitor-industry" placeholder="Identity & access management" className="h-10 rounded-[10px] px-2.5 text-[15px] shadow-none" value={form.industry} onChange={(e) => setForm((v) => ({ ...v, industry: e.target.value }))} />
            </Field>
            <Field label="Positioning" htmlFor="competitor-positioning">
              <Textarea id="competitor-positioning" placeholder="How they describe themselves to your buyer" className="h-[105px] min-h-[105px] resize-none rounded-[10px] px-2.5 py-2.5 text-[15px] shadow-none" value={form.positioning} onChange={(e) => setForm((v) => ({ ...v, positioning: e.target.value }))} />
            </Field>
            <Field label="Target Audience" htmlFor="competitor-audience">
              <Input id="competitor-audience" placeholder="Who they sell to" className="h-10 rounded-[10px] px-2.5 text-[15px] shadow-none" value={form.target_audience} onChange={(e) => setForm((v) => ({ ...v, target_audience: e.target.value }))} />
            </Field>
            <Field label="Pricing" htmlFor="competitor-pricing">
              <Input id="competitor-pricing" placeholder="$X per seat, annual" className="h-10 rounded-[10px] px-2.5 text-[15px] shadow-none" value={form.pricing} onChange={(e) => setForm((v) => ({ ...v, pricing: e.target.value }))} />
            </Field>
            <Field label="Primary Acquisition Channels" htmlFor="competitor-channels">
              <Input id="competitor-channels" className="h-10 rounded-[10px] px-2.5 text-[15px] shadow-none" value={channelsText} onChange={(e) => setChannelsText(e.target.value)} placeholder="Paid search, Content, Partnerships" />
            </Field>
            <div className="space-y-1.5">
              <Label htmlFor="competitor-threat" className="text-sm font-medium leading-5">Threat Level</Label>
              <Select
                value={form.threat_level}
                onValueChange={(value) => setForm((current) => ({
                  ...current,
                  threat_level: value as CompetitorProfileInput["threat_level"],
                }))}
                disabled={locked}
              >
                <SelectTrigger id="competitor-threat" className="h-10 rounded-[10px] px-2.5 text-[15px] shadow-none"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </fieldset>

          {publishError && <p role="alert" className="text-sm text-destructive">{publishError}</p>}
        </div>

        <DialogFooter className="gap-2 border-t border-border/60 px-5 pb-5 pt-3 sm:space-x-0">
          <Button type="button" variant="outline" className="rounded-xl shadow-none" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" className="rounded-xl bg-[#0e0f11] hover:bg-[#0e0f11]/90" disabled={!canPublish} onClick={() => void publish()}>
            {publishing ? "Saving…" : mode === "edit" ? "Save Competitor" : "Add Competitor"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-sm font-medium leading-5">{label}</Label>
      {children}
    </div>
  );
}
