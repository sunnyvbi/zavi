import { cn } from "@/lib/cn";
import { cardText } from "../../card/styles";

export type LabeledField = { label: string; content: string };

const TIMED = /^\s*\(?\d{1,2}:\d{2}/;

function Value({ field }: { field: LabeledField }) {
  const lines = field.content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (/^hook$/i.test(field.label)) return <p className="font-semibold">{field.content}</p>;
  if (lines.length > 1 && lines.some((l) => TIMED.test(l))) {
    return <ul className={cn("flex flex-col gap-1 leading-6", lines.length > 4 && "max-h-24 overflow-hidden")}>{lines.map((l) => <li key={l}>{l}</li>)}</ul>;
  }
  return <p className={cn("whitespace-pre-line", field.content.length > 240 && "line-clamp-3")}>{field.content}</p>;
}

export function LabeledFields({ fields }: { fields: LabeledField[] }) {
  return (
    <div className={`flex flex-col gap-3 ${cardText.body}`}>
      {fields.slice(0, 4).map((f) => (
        <div key={f.label}>
          <p className={cardText.label}>{f.label}</p>
          <Value field={f} />
        </div>
      ))}
    </div>
  );
}
