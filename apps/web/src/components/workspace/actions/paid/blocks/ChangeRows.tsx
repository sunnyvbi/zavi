import type { ExactChangeRow } from "@/lib/workspace/channelActionsApi";
import { groupedChange } from "../../ActionCard";

function Arrow({ before, after }: { before: string; after: string }) {
  return (
    <>
      <span className="text-ca-secondary line-through">{before}</span>
      <span aria-hidden className="text-ca-secondary">→</span>
      <span className="sr-only">changes to</span>
      <span data-testid="exact-change-after" className="min-w-0 break-words font-semibold [overflow-wrap:anywhere]">{after}</span>
    </>
  );
}

export function ChangeRows({ lead, rows }: { lead: string | null; rows: ExactChangeRow[] }) {
  const grouped = groupedChange(rows);
  return (
    <div data-testid="exact-change" className="text-ca-body text-ca-xdark">
      {lead && <p>{lead}</p>}
      {grouped ? (
        <div className="mt-2 flex flex-col gap-3">
          <p className="flex flex-wrap items-baseline gap-x-2 text-ca-row"><Arrow before={grouped.before} after={grouped.after} /></p>
          {grouped.groups.map((g) => (
            <div key={g.label}>
              <p className="text-ca-action text-ca-secondary">{g.label}</p>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {g.terms.map((t, i) => <li key={`${t}-${i}`} data-testid="exact-change-row" className="rounded-full bg-ca-subtle px-2.5 text-ca-action font-medium text-ca-xdark">{t}</li>)}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {rows.map((r, i) => (
            <li key={`${r.item}-${i}`} data-testid="exact-change-row" className="flex flex-wrap items-baseline gap-x-2 text-ca-row">
              <span className="text-ca-secondary"><span>{r.item}</span>:</span>
              {r.before ? <Arrow before={r.before} after={r.after} /> : <span data-testid="exact-change-after" className="min-w-0 break-words font-semibold [overflow-wrap:anywhere]">{r.after}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
