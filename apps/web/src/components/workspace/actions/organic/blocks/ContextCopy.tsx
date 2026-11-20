import { cardText } from "../../card/styles";
import { CopyText } from "../../card/blocks/CopyText";

export function ContextCopy({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className={`${cardText.label} line-clamp-2 [overflow-wrap:anywhere]`} title={label}>{label}</p>
      <CopyText text={text} />
    </div>
  );
}
