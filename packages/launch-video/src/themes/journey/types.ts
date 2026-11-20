export type Station =
  | { kind: 'title'; slate?: string; kicker: string; headline: string; sub?: string; chips?: string[]; notes?: string[] }
  | { kind: 'numeral'; slate?: string; label: string; value: string; unit?: string; source?: string; notes?: string[] }
  | {
      kind: 'versus';
      slate?: string;
      title: string;
      left: { label: string; value: string; unit?: string; notes?: string[] };
      right: { label: string; value: string; unit?: string; notes?: string[] };
    }
  | { kind: 'ring'; slate?: string; title: string; big: string; ringLabel: string; gapLabel?: string; rows: string[] }
  | { kind: 'wall'; slate?: string; title: string; items: string[]; countLabel: string }
  | { kind: 'burst'; slate?: string; title: string; center: string; items: string[] }
  | { kind: 'ladder'; slate?: string; title: string; rungs: string[]; countLabel?: string }
  | { kind: 'filter'; slate?: string; title: string; fields: { label: string; values: string[] }[]; button: string; notes?: string[] }
  | { kind: 'steps'; slate?: string; title: string; steps: { title: string; detail: string }[] }
  | { kind: 'chat'; slate?: string; title: string; from: string; message: string; checks: string[] }
  | { kind: 'range'; slate?: string; title: string; min: string; max: string; unit: string; caption: string; notes?: string[] }
  | { kind: 'repeat'; slate?: string; title: string; slot: string; caption: string; contrast?: string }
  | {
      kind: 'clock';
      slate?: string;
      title: string;
      left: { place: string; when: string };
      right: { place: string; when: string };
      caption: string;
    }
  | { kind: 'strike'; slate?: string; title: string; items: string[]; stamp: string }
  | { kind: 'redact'; slate?: string; title: string; shown: { label: string; value: string }[]; hiddenCount?: number; caption: string }
  | { kind: 'options'; slate?: string; title: string; items: string[]; caption: string }
  | { kind: 'gate'; slate?: string; title: string; pass: string[]; block: string; empty: string; caption: string }
  | { kind: 'flow'; slate?: string; title: string; from: string; to: string; via: string[]; zero?: { label: string; value: string }; caption: string }
  | { kind: 'countdown'; slate?: string; title: string; hours: string; inside: string; outside: string }
  | { kind: 'quad'; slate?: string; title: string; items: { title: string; detail: string }[]; tag?: string; caption?: string }
  | { kind: 'cycle'; slate?: string; title: string; center: string; nodes: string[]; caption?: string }
  | { kind: 'terms'; slate?: string; title: string; rows: { label: string; value: string }[]; caption?: string }
  | { kind: 'cta'; slate?: string; headline: string; button: string; url: string; notes?: string[] };

export type StationKind = Station['kind'];
