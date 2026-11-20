
export function oneTapRef(messageId: string): string | null {
  const m = /zavi-([0-9a-f]{8})-([0-9a-f]{4})-/i.exec(messageId);
  return m ? `${m[1]}${m[2]}`.toLowerCase() : null;
}

const REF_RE = /\[ref ([0-9a-f]{12})\]/i;

export function refFromSubject(subject: string | null | undefined): string | null {
  const m = REF_RE.exec(subject ?? "");
  return m ? m[1].toLowerCase() : null;
}

export function rootPrefixForRef(ref: string): string {
  return `zavi-${ref.slice(0, 8)}-${ref.slice(8, 12)}-`;
}

export function oneTapMailto(args: { to: string; subject: string; ref: string; body: string }): string {
  const subject = `Re: ${args.subject.replace(REF_RE, "").trim()} [ref ${args.ref}]`;
  return `mailto:${encodeURIComponent(args.to).replace(/%40/g, "@")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(args.body)}`;
}
