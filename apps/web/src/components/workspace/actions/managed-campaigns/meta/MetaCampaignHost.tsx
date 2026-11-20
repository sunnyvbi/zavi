"use client";
import { useEffect, useState } from "react";
import { EditorLayer } from "../EditorLayer";
import { META_EDITOR_EVENT, type MetaEditorTarget } from "./metaEditorApi";
import { MetaCampaignEditor } from "./MetaCampaignEditor";

export function MetaCampaignHost({ onChanged }: { onChanged: () => void }) {
  const [target, setTarget] = useState<MetaEditorTarget | null>(null);
  useEffect(() => {
    const on = (e: Event) => setTarget((e as CustomEvent<MetaEditorTarget>).detail ?? null);
    window.addEventListener(META_EDITOR_EVENT, on);
    return () => window.removeEventListener(META_EDITOR_EVENT, on);
  }, []);
  if (!target) return null;
  return <EditorLayer><MetaCampaignEditor key={target === "new" ? "new" : `${target.campaign_id}:${target.create ?? "edit"}`} target={target} onClose={() => setTarget(null)} onChanged={onChanged} /></EditorLayer>;
}
