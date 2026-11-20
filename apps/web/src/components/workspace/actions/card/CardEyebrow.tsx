import { cardText } from "./styles";

export function CardEyebrow({ kind, meta, chip, isNew }: { kind: string; meta: string[]; chip?: string | null; isNew?: boolean }) {
  return (
    <p className={cardText.eyebrow}>
      <span data-testid="action-kind" className="font-medium text-ca-dark">{kind}</span>
      {meta.map((m) => <span key={m}>· {m}</span>)}
      {chip && <span className="rounded-full bg-ca-subtle px-2 font-medium text-ca-xdark">{chip}</span>}
      {isNew && <span className="font-medium text-ca-success">New</span>}
    </p>
  );
}
