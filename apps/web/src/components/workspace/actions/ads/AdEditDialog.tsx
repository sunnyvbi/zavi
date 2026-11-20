"use client";

import { useId, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { getChannel, type AdReviewChanges, type AdReviewEditField, type AdReviewResponse } from "@zavi/shared";
import { cn } from "@/lib/cn";
import { newRequestId } from "@/lib/workspace/channelActionsApi";
import { ActionEditDialog } from "../ActionEditDialog";
import { CardButton } from "../card/CardButton";
import { ChannelMarkIcon } from "../../growth/GrowthChannelLabel";
import { adButtonChoices, adEditGroups, adEditLabel, adTextLimit } from "./adEditSections";
import type { AdReviewModel } from "./adReviewModel";

const FIELD = "w-full rounded-xl border border-ca-strong bg-ca-bg px-4 py-3 text-ca-row text-ca-xdark focus-visible:shadow-ca-focus focus-visible:outline-none disabled:opacity-60";
const LABEL = "flex items-center justify-between gap-3 text-ca-row font-medium text-ca-xdark";

function AdMedia({ model, src }: { model: AdReviewModel; src: string | null }) {
  const creative = model.creatives[0];
  const video = creative?.video_url;
  const image = src ?? creative?.image_url ?? null;
  const [broken, setBroken] = useState<string | null>(null);
  if (!video && (!image || broken === image)) return null;
  return (
    <div className="flex h-56 items-center justify-center overflow-hidden rounded-xl border border-ca-border bg-ca-subtle">
      {video ? <video src={video} controls className="h-full w-full object-contain" /> : <img src={image!} alt="The ad's current image" onError={() => setBroken(image)} className="h-full w-full object-contain" />}
    </div>
  );
}

function ButtonChoices({ field, choices, value, disabled, onChange }: { field: AdReviewEditField; choices: Array<{ value: string; label: string }>; value: string; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <div role="radiogroup" aria-label={adEditLabel(field)} className="flex w-fit max-w-full flex-wrap gap-1 rounded-2xl bg-ca-subtle p-1">
      {choices.map((c) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          aria-checked={value === c.value}
          disabled={disabled}
          onClick={() => onChange(c.value)}
          className={cn(
            "rounded-xl px-4 py-2 text-ca-action font-semibold transition-colors duration-ca-press",
            value === c.value ? "bg-ca-bg text-ca-xdark shadow-ca-sm" : "text-ca-secondary hover:text-ca-xdark",
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

export function AdEditDialog({ model, review, revision, onSave, onCancel, busy, saveNote, subtitle }: {
  model: AdReviewModel;
  review: AdReviewResponse;
  revision: string;
  onSave: (edits: AdReviewChanges & { request_id: string }) => Promise<boolean>;
  onCancel: () => void;
  busy?: boolean;
  saveNote: boolean;
  subtitle?: string;
}) {
  const scheduleOnly = review.fields.length > 0 && review.fields.every((field) => ["date", "datetime"].includes(field.kind));
  const formId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [request, setRequest] = useState<{ signature: string; id: string } | null>(null);
  const disabled = saving || !!busy;
  const slug = model.channelSlug;
  const valueOf = (field: AdReviewEditField) => values[field.key] ?? field.value;
  const set = (field: AdReviewEditField, value: string) => setValues((old) => ({ ...old, [field.key]: value }));
  const headline = review.fields.find((f) => /(^|\.)(headline|title)$/.test(f.key));
  const name = headline ? valueOf(headline).trim() : model.creatives[0]?.title?.trim();
  const title = scheduleOnly ? "Edit the schedule" : name ? `Edit ad: ${name}` : "Edit the ad";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const changes = Object.fromEntries(review.fields.filter((field) => values[field.key] !== undefined && values[field.key] !== field.value).map((field) => [field.key, values[field.key]]));
    if (!Object.keys(changes).length) { onCancel(); return; }
    const signature = JSON.stringify(changes);
    const requestId = request?.signature === signature ? request.id : newRequestId();
    setRequest({ signature, id: requestId }); setSaving(true); setError(null);
    try {
      if (await onSave({ revision, changes, request_id: requestId })) onCancel();
      else setError("Changes were not confirmed. Check the channel message, then refresh before retrying.");
    } catch (e) { setError(e instanceof Error ? e.message : "Changes could not be saved."); }
    finally { setSaving(false); }
  }

  const input = (field: AdReviewEditField) => {
    const value = valueOf(field);
    const choices = adButtonChoices(slug, field);
    if (choices) return <ButtonChoices field={field} choices={choices} value={value} disabled={disabled} onChange={(v) => set(field, v)} />;
    if (field.kind === "multiline" || field.kind === "lines") {
      return <textarea aria-label={field.label} value={value} onChange={(e) => set(field, e.target.value)} required={!field.optional} disabled={disabled} rows={field.kind === "lines" ? 4 : 3} maxLength={10000} className={cn(FIELD, "resize-y")} />;
    }
    return <input aria-label={field.label} step={field.kind === "datetime" ? 1 : undefined} type={field.kind === "datetime" ? "datetime-local" : field.kind === "date" ? "date" : field.kind === "url" ? "url" : "text"} value={value} onChange={(e) => set(field, field.kind === "datetime" ? e.target.value.replace(/\.0{1,3}$/, "") : e.target.value)} required={!field.optional} disabled={disabled} maxLength={10000} className={FIELD} />;
  };

  const groups = adEditGroups(review.fields);
  return (
    <ActionEditDialog
      title={title}
      subtitle={scheduleOnly ? subtitle : "What people see in this ad. Its audience and budget stay as they are, and the other ads keep running."}
      icon={getChannel(slug) ? <ChannelMarkIcon slug={slug} compact /> : undefined}
      divided
      busy={disabled}
      onClose={onCancel}
      footer={<>
        <CardButton variant="ghost" className="ml-auto" disabled={disabled} onClick={onCancel}>Cancel</CardButton>
        <CardButton type="submit" form={formId} variant="primary" disabled={disabled}><Check className="size-4" aria-hidden />{saving ? "Saving…" : "Save changes"}</CardButton>
      </>}
    >
      <form id={formId} onSubmit={submit} className="space-y-8" aria-label="Edit ad proposal">
        {groups.map((group) => (
          <div key={group.ad ?? "ad"} className="space-y-6">
            {group.ad && groups.length > 1 && <h3 className="text-ca-title font-semibold tracking-tight text-ca-xdark">{group.ad}</h3>}
            {group.sections.map((section) => (
              <section key={section.id} aria-label={section.title} className="space-y-4">
                <h4 className="text-ca-title font-semibold text-ca-xdark">{section.title}</h4>
                {section.id === "media" && group === groups[0] && <AdMedia model={model} src={(() => { const f = section.fields.find((x) => x.key.endsWith("image_url")); return f ? valueOf(f).trim() || null : null; })()} />}
                {section.fields.map((field) => {
                  const limit = adTextLimit(slug, field);
                  const used = valueOf(field).length;
                  return (
                    <label key={field.key} className="flex min-w-0 flex-col gap-2.5">
                      <span className={LABEL}>
                        <span>{adEditLabel(field)}{field.optional ? " (optional)" : ""}</span>
                        {limit !== null && <span className={cn("text-ca-action font-normal tabular-nums", used > limit ? "text-ca-danger" : "text-ca-secondary")}>{used}/{limit}</span>}
                      </span>
                      {input(field)}
                    </label>
                  );
                })}
              </section>
            ))}
          </div>
        ))}
        {saveNote && <p className="text-ca-action text-ca-secondary">Dates use UTC. Saving replaces this pending proposal; nothing is published. Approval is a separate action.</p>}
        {review.limitations.map((message) => <p key={message} className="text-ca-action text-ca-secondary">{message}</p>)}
        {error && <p role="alert" className="text-ca-action text-ca-danger">{error}</p>}
      </form>
    </ActionEditDialog>
  );
}
