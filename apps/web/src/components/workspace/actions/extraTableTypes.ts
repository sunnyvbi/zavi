import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export type CellTone = "good" | "bad" | "dim";

export type ChipTone = "good" | "warn" | "bad" | "muted";

export type ExtraCell = {
  media?: ReactNode;
  text: string;

  badge?: { text: string; tone: ChipTone };

  sub?: string;

  tone?: CellTone;

  strong?: boolean;

  href?: string | null;

  chip?: ChipTone;

  title?: string;

  meter?: { value: number; max?: number; name: string };

  terms?: { items: readonly string[]; name: string; heading: string; buttonLabel: string };

  select?: ExtraCellSelect;
};

export type ExtraCellSelect = {
  value: string | null;

  unsetLabel: string;
  options: readonly { value: string; label: string }[];

  label: string;
  onChange: (value: string | null) => void | Promise<unknown>;
};

export type ExtraRowAction = {
  label: string;

  chatDraft?: string;

  onClick?: () => void | Promise<unknown>;

  href?: string;

  busyLabel?: string;

  retryLabel?: string;

  title?: string;

  toast?: boolean;
};

export type ExtraRowDetail = {
  content?: ReactNode;

  title?: string;

  text: string;

  openLabel: string;
  closeLabel: string;

  actions?: ExtraRowAction[];
};

export type ExtraRow = {
  id: string;
  cells: ExtraCell[];

  actions?: ExtraRowAction[];

  detail?: ExtraRowDetail;

  tail?: boolean;
};

export type ExtraColumn = { label: string; align?: "left" | "right" };

export type ExtraTableView = {
  id: string;
  label: string;
  data?: Pick<ExtraTableData, "columns" | "rows" | "footer" | "empty" | "pageSize">;
};

export type ExtraTableData = {
  id?: string;
  title: string;
  icon?: LucideIcon;
  columns: ExtraColumn[];
  rows: ExtraRow[];

  footer?: ExtraCell[];

  empty: string;
  keepWhenEmpty?: boolean;

  caption?: string;

  actionsLabel?: string;

  tailToggle?: {
    show: (n: number) => string;
    hide: string;

    noneAbove: string;
  };

  narrow?: boolean;

  detailInDrawer?: boolean;

  pageSize?: number;

  views?: ExtraTableView[];
};

