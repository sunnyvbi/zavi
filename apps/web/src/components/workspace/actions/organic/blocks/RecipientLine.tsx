import { CopyText } from "../../card/blocks/CopyText";

export function RecipientLine({ to, text }: { to: string; text: string }) {
  return (
    <div>
      <p className="mb-2 text-ca-label font-semibold text-ca-xdark">{to}</p>
      <CopyText text={text} />
    </div>
  );
}
