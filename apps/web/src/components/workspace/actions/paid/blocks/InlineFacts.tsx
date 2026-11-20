export type Fact = { label: string; value: string };

export function InlineFacts({ facts }: { facts: Fact[] }) {
  if (!facts.length) return null;
  return (
    <dl className="mt-1 flex flex-col gap-1 text-ca-facts">
      {facts.map((f) => (
        <div key={f.label} className="flex gap-2">
          <dt className="text-ca-secondary">{f.label}:</dt>
          <dd className="font-medium text-ca-xdark">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}
