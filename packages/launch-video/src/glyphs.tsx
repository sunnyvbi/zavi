import React from 'react';

export type GlyphName =
  | 'bolt'
  | 'chart'
  | 'shield'
  | 'clock'
  | 'car'
  | 'check'
  | 'spark'
  | 'chat'
  | 'pin'
  | 'search'
  | 'box'
  | 'user'
  | 'star';

const STROKE = { fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const Glyph: React.FC<{ name: GlyphName; size?: number; color?: string; weight?: number }> = ({
  name,
  size = 40,
  color = 'currentColor',
  weight = 2.2,
}) => {
  const common = { width: size, height: size, viewBox: '0 0 24 24', stroke: color, strokeWidth: weight, ...STROKE };
  switch (name) {
    case 'bolt':
      return (
        <svg {...common}>
          <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
        </svg>
      );
    case 'chart':
      return (
        <svg {...common}>
          <path d="M4 20V4M4 20h16" />
          <path d="M8 16l3-4 3 2 4-7" />
        </svg>
      );
    case 'shield':
      return (
        <svg {...common}>
          <path d="M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      );
    case 'clock':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3.5 2" />
        </svg>
      );
    case 'car':
      return (
        <svg {...common}>
          {}
          <path d="M2.5 14.2l1.4-3.1a2.4 2.4 0 0 1 1.5-1.3l1.9-.5 2.2-2.5a2.6 2.6 0 0 1 1.95-.9h2.4a2.6 2.6 0 0 1 2.1 1.07l1.7 2.36 2.1.8a2 2 0 0 1 1.3 1.87v2.02" />
          <path d="M2.5 14.2h19v2.1a1 1 0 0 1-1 1h-1.4M8.9 17.3H15.1M4.9 17.3H3.5a1 1 0 0 1-1-1v-1.1" />
          {}
          <path d="M8.2 9.2l1.0 2.4h7.3l-1.5-2.3" />
          <path d="M12.7 6.4v5.2" />
          {}
          <circle cx="7" cy="17.4" r="2.1" />
          <circle cx="17" cy="17.4" r="2.1" />
          <circle cx="7" cy="17.4" r="0.5" />
          <circle cx="17" cy="17.4" r="0.5" />
          {}
          <path d="M21.5 13.1h-1.2" />
        </svg>
      );
    case 'check':
      return (
        <svg {...common}>
          <path d="M4 12.5l5 5 11-11" />
        </svg>
      );
    case 'spark':
      return (
        <svg {...common}>
          <path d="M12 3v5M12 16v5M3 12h5M16 12h5M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3" />
        </svg>
      );
    case 'chat':
      return (
        <svg {...common}>
          <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 4v-4H6a2 2 0 0 1-2-2V6Z" />
        </svg>
      );
    case 'pin':
      return (
        <svg {...common}>
          <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z" />
          <circle cx="12" cy="10" r="2.6" />
        </svg>
      );
    case 'search':
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <path d="M16.5 16.5 21 21" />
        </svg>
      );
    case 'box':
      return (
        <svg {...common}>
          <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
          <path d="M4 7l8 4 8-4M12 11v10" />
        </svg>
      );
    case 'user':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.6" />
          <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
        </svg>
      );
    case 'star':
      return (
        <svg {...common}>
          <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z" />
        </svg>
      );
    default:
      return null;
  }
};

const ALL_GLYPHS: GlyphName[] = ['bolt', 'chart', 'shield', 'clock', 'car', 'check', 'spark', 'chat', 'pin', 'box', 'user', 'star'];

export const GLYPH_NAMES: GlyphName[] = [...ALL_GLYPHS, 'search'];

export function asGlyph(hint: string | undefined, text: string | undefined, index = 0): GlyphName {
  if (hint && (GLYPH_NAMES as string[]).includes(hint)) return hint as GlyphName;
  return glyphFor(text, index);
}

export function glyphFor(text: string | undefined, index = 0): GlyphName {
  const t = (text ?? '').toLowerCase();
  if (/\b(engineer|build|ship|cod|pull request|\bpr\b|deploy|api)/.test(t)) return 'bolt';
  if (/\b(market|campaign|ad|growth|revenue|metric|analy|chart|spend|roas)/.test(t)) return 'chart';
  if (/\b(secure|trust|risk|fraud|safe|protect|complian|moderat)/.test(t)) return 'shield';
  if (/\b(fast|time|hour|day|night|always|24|instant|speed|schedul)/.test(t)) return 'clock';
  if (/\b(support|inbox|repl|messag|chat|triage|customer|ticket)/.test(t)) return 'chat';
  if (/\b(car|vehicle|fleet|rental|driv|host)/.test(t)) return 'car';
  if (/\b(done|clear|resolv|complet|approv|verif)/.test(t)) return 'check';
  return ALL_GLYPHS[index % ALL_GLYPHS.length];
}

export function monogramOf(name: string | undefined): string {
  const cleaned = (name ?? '').replace(/[^A-Za-z0-9 ]/g, '').trim();
  if (!cleaned) return '·';
  const parts = cleaned.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

export const Monogram: React.FC<{
  label: string;
  size?: number;
  bg?: string;
  fg?: string;
  fontFamily?: string;
  radius?: number;
}> = ({ label, size = 56, bg = '#1B1A17', fg = '#FFFFFF', fontFamily, radius }) => (
  <div
    style={{
      flex: '0 0 auto',
      width: size,
      height: size,
      borderRadius: radius ?? Math.round(size * 0.26),
      background: bg,
      color: fg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily,
      fontWeight: 700,
      fontSize: Math.round(size * 0.4),
      letterSpacing: 0.5,
    }}
  >
    {label}
  </div>
);
