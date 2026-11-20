
export type ChangedFile = {
  path: string;
  action: string;
};

const FILE_ACTION_STYLE: Record<string, string> = {
  create: "text-emerald-700",
  modify: "text-amber-700",
  delete: "text-rose-700",
};

export function fileActionClass(action: string): string {
  return FILE_ACTION_STYLE[action] ?? "text-inkMuted";
}

export function changedFilesLabel(count: number): string {
  return `Changed ${count} file${count === 1 ? "" : "s"}`;
}
