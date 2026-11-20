import { cn } from "@/lib/cn";
import { cardText } from "../styles";

export function Steps({ lead, points }: { lead: string | null; points: string[] }) {
  if (!lead && !points.length) return null;
  const shown = points.slice(0, 3);
  return (
    <div className={cardText.body}>
      {lead && <p className={cn(lead.length > 260 && "line-clamp-3")}>{lead}</p>}
      {shown.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {shown.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
    </div>
  );
}
