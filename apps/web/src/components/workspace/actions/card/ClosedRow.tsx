import { CardButton } from "./CardButton";

export function ClosedRow({ title, until, onUndo }: { title: string; until?: string | null; onUndo?: () => void }) {
  return (
    <div data-testid="card-closed" className="flex flex-wrap items-center gap-x-1.5 rounded-2xl border border-dashed border-ca-strong px-5 py-3 text-ca-action text-ca-secondary">
      <span className="font-semibold text-ca-xdark">{title}</span>
      <span>· {until ? `Back on ${new Date(until).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "Closed"}</span>
      {onUndo && <CardButton variant="ghost" className="ml-auto" onClick={onUndo}>Undo</CardButton>}
    </div>
  );
}
