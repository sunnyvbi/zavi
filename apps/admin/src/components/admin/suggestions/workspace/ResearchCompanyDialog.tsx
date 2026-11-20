"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { CompanyProfileInput, CompanyResearchResult, CompanySocialPlatform } from "@zavi/shared";
import { adminApiFetch } from "@/lib/api-admin";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

const SOCIAL_FIELDS: Array<{ platform: CompanySocialPlatform; label: string }> = [
  { platform: "linkedin", label: "LinkedIn" },
  { platform: "x", label: "X / Twitter" },
  { platform: "instagram", label: "Instagram" },
  { platform: "facebook", label: "Facebook" },
  { platform: "youtube", label: "YouTube" },
  { platform: "tiktok", label: "TikTok" },
];

type FormState = {
  website: string;
  industry: string;
  category: string;
  founded: string;
  location: string;
  social: Record<CompanySocialPlatform, string>;
};

function emptySocial(): Record<CompanySocialPlatform, string> {
  return { linkedin: "", x: "", facebook: "", instagram: "", youtube: "", tiktok: "" };
}

function emptyForm(website = ""): FormState {
  return { website, industry: "", category: "", founded: "", location: "", social: emptySocial() };
}

function asWebsite(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message || fallback;
}

export function ResearchCompanyDialog({
  tenantId,
  website,
  open,
  onOpenChange,
  onSaved,
}: {
  tenantId: string;
  website: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => emptyForm(asWebsite(website)));
  const [research, setResearch] = useState<ResearchState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
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
    setForm(emptyForm(asWebsite(website)));
    setResearch({ status: "idle" });
    setSaveError(null);
  }, [clearPoll, open, website]);

  const applyResult = useCallback((profile: CompanyResearchResult) => {
    const social = emptySocial();
    for (const row of profile.social_profiles) {
      if (row.url) social[row.platform] = row.url;
    }
    setForm({
      website: profile.website,
      industry: profile.industry,
      category: profile.category,
      founded: profile.founded,
      location: profile.location,
      social,
    });
  }, []);

  const poll = useCallback(async (
    runId: string,
    requestId: string,
    researchedWebsite: string,
    generation: number,
  ) => {
    try {
      const res = await adminApiFetch(
        `/api/admin/tenants/${tenantId}/company-profile/research/${runId}`,
      );
      if (!res.ok) throw new Error(await errorMessage(res, `HTTP ${res.status}`));
      const body = (await res.json()) as {
        status: "researching" | "complete" | "failed";
        request_id: string;
        website: string;
        profile?: CompanyResearchResult;
        error?: string;
      };
      if (!matchesActiveResearch({
        activeGeneration: generationRef.current,
        responseGeneration: generation,
        activeRequestId: requestId,
        responseRequestId: body.request_id,
        activeWebsite: researchedWebsite,
        responseWebsite: body.website,
      })) return;
      if (body.status === "researching") {
        pollTimerRef.current = setTimeout(
          () => void poll(runId, requestId, researchedWebsite, generation),
          2_000,
        );
        return;
      }
      if (body.status === "complete" && body.profile) {
        applyResult(body.profile);
        setResearch({ status: "complete", requestId, runId, website: researchedWebsite });
        return;
      }
      setResearch({
        status: "failed",
        requestId,
        website: researchedWebsite,
        message: body.error || "Research failed. Try again.",
      });
    } catch (error) {
      if (generationRef.current !== generation) return;
      setResearch({
        status: "failed",
        requestId,
        website: researchedWebsite,
        message: error instanceof Error ? error.message : "Research failed. Try again.",
      });
    }
  }, [applyResult, tenantId]);

  const startResearch = useCallback(async (rawWebsite: string) => {
    const researchedWebsite = asWebsite(rawWebsite);
    if (!isResearchableWebsite(researchedWebsite)) return;
    clearPoll();
    const generation = ++generationRef.current;
    const requestId = crypto.randomUUID();
    setSaveError(null);
    setResearch({ status: "researching", requestId, runId: null, website: researchedWebsite });
    try {
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/company-profile/research`, {
        method: "POST",
        body: JSON.stringify({ website: researchedWebsite, request_id: requestId }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, `HTTP ${res.status}`));
      const body = (await res.json()) as { run_id: string; request_id: string; website: string };
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
        website: researchedWebsite,
        message: error instanceof Error ? error.message : "Research could not be started.",
      });
    }
  }, [clearPoll, poll, tenantId]);

  useEffect(() => {
    if (!open || research.status === "researching") return;
    const researchedWebsite = asWebsite(form.website);
    if (!isResearchableWebsite(researchedWebsite)) return;
    if (
      (research.status === "complete" || research.status === "failed") &&
      research.website === researchedWebsite
    ) return;
    const timer = setTimeout(() => void startResearch(researchedWebsite), 650);
    return () => clearTimeout(timer);
  }, [form.website, open, research, startResearch]);

  const locked = areProfileFieldsLocked(research.status);
  const canSave =
    research.status === "complete" &&
    research.website === asWebsite(form.website) &&
    !saving;

  async function save() {
    if (research.status !== "complete" || !canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const profile: CompanyProfileInput = {
        website: form.website,
        industry: form.industry,
        category: form.category,
        founded: form.founded,
        location: form.location,
        social_profiles: SOCIAL_FIELDS.flatMap(({ platform }) => {
          const url = asWebsite(form.social[platform]);
          return url ? [{ platform, url, followers: null }] : [];
        }),
      };
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/company-profile`, {
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
      onOpenChange(false);
      onSaved();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save company profile.");
    } finally {
      setSaving(false);
    }
  }

  function updateWebsite(next: string) {
    generationRef.current += 1;
    clearPoll();
    setForm((current) => ({ ...current, website: next }));
    setSaveError(null);
    setResearch({ status: "idle" });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-32px)] w-[calc(100%-32px)] gap-0 overflow-y-auto rounded-[15px] border-0 p-0 shadow-[0_24px_40px_rgba(16,24,39,0.29)] sm:max-w-[472px] [&>button]:right-5 [&>button]:top-5 [&>button]:rounded-full [&>button]:p-1 [&>button>svg]:size-5">
        <DialogHeader className="border-b border-border/60 px-5 pb-4 pt-5 pr-14">
          <DialogTitle className="text-left text-xl font-semibold leading-7 text-[#11192d]">
            Research this company
          </DialogTitle>
          <DialogDescription className="sr-only">
            Research fills public profile fields. Review them, then save on admin.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-5 py-4">
          <Field label="Website" htmlFor="company-website">
            <Input
              id="company-website"
              type="url"
              placeholder="upcar.ai"
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
                <p className="text-sm font-medium">Researching this company…</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Reading the website and public social links. Fields stay locked until this finishes.
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
              Research complete. Review and edit before saving. Growth score and MRR stay calculated from live data.
            </p>
          )}

          <fieldset disabled={locked} className="space-y-5 disabled:opacity-60">
            <Field label="Industry" htmlFor="company-industry">
              <Input id="company-industry" value={form.industry} onChange={(e) => setForm((v) => ({ ...v, industry: e.target.value }))} />
            </Field>
            <Field label="Category" htmlFor="company-category">
              <Input id="company-category" value={form.category} onChange={(e) => setForm((v) => ({ ...v, category: e.target.value }))} />
            </Field>
            <Field label="Founded" htmlFor="company-founded">
              <Input id="company-founded" value={form.founded} onChange={(e) => setForm((v) => ({ ...v, founded: e.target.value }))} />
            </Field>
            <Field label="Location" htmlFor="company-location">
              <Input id="company-location" value={form.location} onChange={(e) => setForm((v) => ({ ...v, location: e.target.value }))} />
            </Field>
            {SOCIAL_FIELDS.map(({ platform, label }) => (
              <Field key={platform} label={label} htmlFor={`company-${platform}`}>
                <Input
                  id={`company-${platform}`}
                  type="url"
                  placeholder={`https://…`}
                  value={form.social[platform]}
                  onChange={(e) => setForm((v) => ({ ...v, social: { ...v.social, [platform]: e.target.value } }))}
                />
              </Field>
            ))}
          </fieldset>

          {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
        </div>

        <DialogFooter className="gap-2 border-t border-border/60 px-5 pb-5 pt-3 sm:space-x-0">
          <Button type="button" variant="outline" className="rounded-xl shadow-none" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" className="rounded-xl bg-[#0e0f11] hover:bg-[#0e0f11]/90" disabled={!canSave} onClick={() => void save()}>
            {saving ? "Saving…" : "Save profile"}
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
