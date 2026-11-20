'use client';

import { useState } from 'react';

export type ThemeSlot = 'primary' | 'accent' | 'background';

export const THEME_SLOTS: ReadonlyArray<{ id: ThemeSlot; label: string; hint: string }> = [
  { id: 'primary', label: 'Primary', hint: 'Buttons, links, key actions' },
  { id: 'accent', label: 'Accent', hint: 'Highlights and secondary emphasis' },
  { id: 'background', label: 'Background', hint: 'Page background' },
];

export type ThemeSelection = Partial<Record<ThemeSlot, string>>;

export function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

export function composeThemeRefineMessage(selection: ThemeSelection): string | null {
  const chosen = THEME_SLOTS.filter((slot) => {
    const value = selection[slot.id];
    return typeof value === 'string' && isHexColor(value);
  });
  if (chosen.length === 0) return null;

  const parts = chosen.map((slot) => `the ${slot.id} color to ${selection[slot.id]!.toLowerCase()}`);
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

  return [
    `Update the visual theme only. Set ${list}.`,
    'Change only theme/color tokens (CSS variables, the Tailwind/theme config, or the equivalent styling layer) and keep the rest of the design system coherent with them.',
    'Do not change routes, page structure, copy, data models, dependencies, or any application behavior.',
  ].join(' ');
}

type ThemeControlsProps = {
  onApply: (message: string) => void;
  disabled?: boolean;
};

export function ThemeControls({ onApply, disabled = false }: ThemeControlsProps) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<ThemeSelection>({});

  const message = composeThemeRefineMessage(selection);
  const canApply = message !== null && !disabled;

  const apply = () => {
    if (!message || disabled) return;
    onApply(message);
    setSelection({});
    setOpen(false);
  };

  return (
    <div className="mb-3 lg:shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-xs font-medium text-inkSoft underline-offset-2 hover:text-ink hover:underline"
      >
        {open ? 'Hide colors' : 'Colors'}
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-[#ececec] bg-[#f9f9f9] p-3">
          <div className="flex flex-wrap gap-4">
            {THEME_SLOTS.map((slot) => (
              <label key={slot.id} className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label={slot.label}
                  title={slot.hint}
                  value={selection[slot.id] ?? '#000000'}
                  onChange={(e) =>
                    setSelection((prev) => ({ ...prev, [slot.id]: e.target.value }))
                  }
                  className="h-7 w-7 cursor-pointer rounded border border-[#dcdcdc] bg-white p-0.5"
                />
                <span className="text-xs font-medium text-inkSoft">{slot.label}</span>
              </label>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={apply}
              disabled={!canApply}
              className="inline-flex items-center rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-cream transition-colors hover:bg-inkSoft disabled:cursor-not-allowed disabled:opacity-40"
            >
              Apply colors
            </button>
            <span className="text-xs text-inkMuted">
              {message
                ? 'Sends a refine. Your app redeploys in a few minutes.'
                : 'Pick a color to apply.'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
