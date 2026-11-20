"use client";

import { ExtraTable } from "../../actions/ExtraTable";
import { gadsCampaignTable } from "./campaignTableData";
import type { GadsPayload } from "./types";

export function CampaignTable({ d }: { d: GadsPayload }) {
  return <ExtraTable data={gadsCampaignTable(d)} />;
}
