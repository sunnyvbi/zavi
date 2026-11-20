
export const CONNECT_ADS_HINT = "Connect it from Connectors in the left menu.";

export type AdAccount = {
  id: string;
  name: string;
  currency: string | null;
  status: string | null;
};

export type AdBudget = {
  amount: number;
  currency: string | null;
  kind: "daily" | "lifetime";
};

export type AdCampaign = {
  id: string;
  name: string;
  status: string | null;
  objective: string | null;
  budget: AdBudget | null;
  last_modified_at?: string | null;
  created_at?: string | null;
  schedule_end_at?: string | null;
};
