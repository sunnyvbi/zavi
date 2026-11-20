
import { FileText, Users, Video, Wallet } from "lucide-react";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";
import type { PlatformSpec } from "./_shared";

export const ugc: PlatformSpec = {
  name: "UGC Videos",
  postsNoun: "Videos",

  metricDisplay: CREATOR_MARKETPLACE_ENABLED
    ? {
        briefs_out: { label: "Briefs out", icon: FileText },
        creators_hired: { label: "Creators hired", icon: Users },
        videos_delivered: { label: "Videos delivered", icon: Video },
        spent: { label: "Spent", icon: Wallet },
      }
    : { briefs_out: { label: "Briefs written", icon: FileText } },

  ...(CREATOR_MARKETPLACE_ENABLED ? { headerAction: { label: "Find creators" as const, drawer: "find" as const } } : {}),
  creatorMessages: true,

  settingsPanels: ["ugc_write_brief"],
  settings: [
    {
      kind: "choice",
      id: "run_surface",
      label: "Where the asset will run",
      help: CREATOR_MARKETPLACE_ENABLED
        ? "This decides which rights the creator has to grant, so it has to be settled before anyone films."
        : "This decides which rights the production partner has to grant, so it has to be settled before anyone films.",
      options: [
        { value: "own_ad_account", label: "Our own ad account" },
        { value: "own_organic", label: "Our own organic accounts and site" },
      ],
    },
    {
      kind: "list",
      id: "claims_off_limits",
      label: CREATOR_MARKETPLACE_ENABLED ? "Things a creator must never say" : "Things the presenter must never say",
      help: CREATOR_MARKETPLACE_ENABLED
        ? "Add them one at a time, in plain words. These go into the brief the creator shoots from."
        : "Add them one at a time, in plain words. These go into the shoot brief.",
    },
  ],
};
