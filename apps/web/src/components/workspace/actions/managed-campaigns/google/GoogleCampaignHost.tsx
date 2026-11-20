"use client";
import { useEffect, useState } from "react";
import { EditorLayer } from "../EditorLayer";
import { editorEvent, type GoogleEditorChannel, type GoogleEditorTarget } from "./googleEditorApi";
import { GoogleCampaignEditor } from "./GoogleCampaignEditor";

export function GoogleCampaignHost({ onChanged, channel = "google_ads" }: { onChanged: () => void; channel?: GoogleEditorChannel }) {
  const [target, setTarget] = useState<GoogleEditorTarget | null>(null);
  useEffect(() => {
    const on = (e: Event) => setTarget((e as CustomEvent<GoogleEditorTarget>).detail ?? null);
    window.addEventListener(editorEvent(channel), on);
    return () => window.removeEventListener(editorEvent(channel), on);
  }, [channel]);
  if (!target) return null;
  return <EditorLayer><GoogleCampaignEditor key={target === "new" ? "new" : `${target.campaign_id}:${target.create ?? "edit"}`} channel={channel} target={target} onClose={() => setTarget(null)} onChanged={onChanged} /></EditorLayer>;
}
