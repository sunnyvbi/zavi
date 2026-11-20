import type { ReactNode } from "react";
import { MediaTile, WithMedia } from "../../card/blocks/MediaTile";
import type { CardCopy } from "../../card/cardModel";
import { copyTextOf } from "../../card/cardPrimary";
import { cardText } from "../../card/styles";
import { deliverableOf, mediaOf, type ActionItem } from "../../types";
import { OrganicBody } from "../OrganicBody";

export type PinField = { label: string; value: string };

const LABEL = /^[ \t*_#-]*([A-Za-z][A-Za-z ]{1,30}?)[ \t]*(?:\([^)\n]*\))?[ \t*_]*:(?!\/\/)[ \t*_]*(.*)$/;

const FIELDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(pin )?title$/, "Title"],
  [/^(pin )?description$/, "Description"],
  [/^(destination( url| link)?|link|url)$/, "Destination"],
  [/^board( name)?$/, "Board"],
];

function host(value: string): string {
  const url = value.match(/https?:\/\/\S+/)?.[0];
  if (!url) return value;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

export function pinFields(text: string): PinField[] | null {
  const found = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = LABEL.exec(raw);
    if (m) {
      const label = FIELDS.find(([re]) => re.test(m[1].trim().toLowerCase()))?.[1] ?? null;
      current = label && !found.has(label) ? [] : null;
      if (current && label) found.set(label, current);
      if (current && m[2].trim()) current.push(m[2].trim());
      continue;
    }
    if (!current) continue;
    if (!line) {
      if (current.length > 0) current = null;
      continue;
    }
    current.push(line);
  }
  const out = FIELDS.flatMap(([, label]) => {
    const lines = found.get(label) ?? [];
    const first = label === "Destination" || label === "Board" ? lines.slice(0, 1) : lines;
    const value = first.join("\n").trim();
    return value ? [{ label, value: label === "Destination" ? host(value) : value }] : [];
  });
  return out.some((f) => f.label === "Title") && out.length >= 2 ? out : null;
}

export function PinFieldList({ fields }: { fields: PinField[] }) {
  return (
    <dl data-testid="pin-fields" className={cardText.body}>
      {fields.map((f) => (
        <div key={f.label} className={f.label === "Description" ? "line-clamp-3" : undefined}>
          <dt className="inline">{f.label}:</dt> <dd className="inline">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PinBody({ a, copy, edited, mediaOverride }: { a: ActionItem; copy: CardCopy; edited: string | null; mediaOverride?: ReactNode }) {
  const fields = edited ? null : pinFields(deliverableOf(a)?.content ?? copyTextOf(a) ?? "");
  if (!fields) return <OrganicBody a={a} copy={copy} edited={edited} mediaOverride={mediaOverride} />;
  const media = mediaOf(a);
  const list = <PinFieldList fields={fields} />;
  const shown = mediaOverride ?? (media && <MediaTile url={media.url} alt={media.alt} />);
  return shown ? <WithMedia media={shown}>{list}</WithMedia> : list;
}
