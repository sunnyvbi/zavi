
import type { PlatformSpec } from "./_shared";
import { TOPIC } from "../topActions/fieldSets";
import { generated_video } from "./generated_video";

export const youtube_organic: PlatformSpec = {
  name: "YouTube",
  createMenu: "New video",
  topActions: [
    {
      key: "plan_video",
      label: "Plan a video",
      modal: "form",
      lead: "One video, fully planned: title options, thumbnail idea, opening script, chapters and description. You film and upload it.",
      fields: [TOPIC],
      primary: "Plan the video",
      done: "Video plan added to What Zavi wants to do.",
    },
  ],

  settings: [
    {
      kind: "text",
      id: "handle",
      label: "Your YouTube handle",
      help: "Your @handle, not the full URL. That is the form the lookup takes. Leave it blank and every run has to find you by search.",
      placeholder: "@yourcompany",
    },
    {
      kind: "choice",
      id: "on_camera",
      label: "Who can be on camera",
      help: "Answer it and the plan stops guessing. Zavi writes a no-face version either way, so “nobody” narrows the plan rather than ending it.",
      options: [
        { value: "face", label: "Someone will appear on camera" },
        { value: "voice_screen", label: "Voiceover and screen recording only" },
        { value: "nobody", label: "Nobody can appear on camera" },
      ],
    },
    {
      kind: "list",
      id: "queries",
      label: "Questions you want to rank for",
      help: "Typed the way a viewer would type them into YouTube search, not the way you would write a headline.",
    },
  ],

  execCopy: generated_video.execCopy,
};
