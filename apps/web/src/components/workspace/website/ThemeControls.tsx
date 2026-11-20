"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Check, ChevronDown } from "lucide-react";

export const THEME_FIELD_LABEL = "mb-2 block text-[13px] font-medium leading-[18px] text-inkMuted";
const FIELD_FRAME =
  "h-10 w-full rounded-[10px] border border-rule bg-white text-[14px] font-medium text-ink outline-none transition-colors focus-visible:border-[#027bff] focus-visible:ring-2 focus-visible:ring-[#027bff]/15";
const POPOVER = "raised-surface absolute z-30 rounded-[12px] border border-rule bg-white shadow-pop";

type Hsv = { h: number; s: number; v: number };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function normalizeHex(raw: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  if (!m) return null;
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return `#${hex.toLowerCase()}`;
}

export function hexToHsv(hex: string): Hsv {
  const n = normalizeHex(hex) ?? "#000000";
  const r = parseInt(n.slice(1, 3), 16) / 255;
  const g = parseInt(n.slice(3, 5), 16) / 255;
  const b = parseInt(n.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}

const fontLinks = new Set<string>();
function loadFontPreview(family: string) {
  if (typeof document === "undefined" || fontLinks.has(family) || !/^[\w .-]+$/.test(family)) return;
  fontLinks.add(family);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}&text=${encodeURIComponent(family)}&display=swap`;
  document.head.appendChild(link);
}

export type ThemeSelectOption = { value: string; label: string; font?: string };

export function ThemeSelect({
  layerId,
  label,
  ariaLabel,
  value,
  options,
  open,
  onOpenChange,
  onChange,
  placement = "down",
}: {
  layerId: string;
  label: string;
  ariaLabel: string;
  value: string;
  options: ThemeSelectOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
  placement?: "up" | "down";
}) {
  const listId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const [active, setActive] = useState(selectedIndex);
  const current = options.find((o) => o.value === value);

  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    for (const o of optionsRef.current) if (o.font) loadFontPreview(o.font);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  const show = (index: number) => {
    setActive(clamp(index, 0, options.length - 1));
    onOpenChange(true);
  };
  const close = () => {
    onOpenChange(false);
    buttonRef.current?.focus();
  };
  const choose = (index: number) => {
    const o = options[index];
    if (o && o.value !== value) onChange(o.value);
    close();
  };

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (open) return;
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) return;
    e.preventDefault();
    show(selectedIndex);
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive((i) => clamp(i + 1, 0, options.length - 1)),
      ArrowUp: () => setActive((i) => clamp(i - 1, 0, options.length - 1)),
      Home: () => setActive(0),
      End: () => setActive(options.length - 1),
      Enter: () => choose(active),
      " ": () => choose(active),
      Escape: close,
    };
    if (e.key === "Tab") {
      onOpenChange(false);
      return;
    }
    const run = keys[e.key];
    if (!run) return;
    e.preventDefault();
    e.stopPropagation();
    run();
  };

  return (
    <div data-theme-layer={layerId} className="relative min-w-0">
      <span className={THEME_FIELD_LABEL}>{label}</span>
      <button
        ref={buttonRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? onOpenChange(false) : show(selectedIndex))}
        onKeyDown={onButtonKey}
        className={`${FIELD_FRAME} flex items-center gap-2 pl-3 pr-2.5 text-left hover:border-inkLight/60`}
      >
        <span className="min-w-0 flex-1 truncate" style={current?.font ? { fontFamily: `"${current.font}", ui-sans-serif, system-ui` } : undefined}>
          {current?.label ?? value}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-inkMuted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={`${ariaLabel} options`}
          tabIndex={-1}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKey}
          className={`${POPOVER} left-0 right-0 max-h-56 overflow-y-auto p-1 outline-none ${placement === "up" ? "bottom-full mb-1.5" : "top-full mt-1.5"}`}
        >
          {options.map((o, i) => {
            const selected = o.value === value;
            return (
              <li
                key={o.value}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
                className={`flex h-9 cursor-pointer items-center gap-2 rounded-[8px] px-2.5 text-[14px] text-ink ${i === active ? "bg-creamDeep" : ""}`}
              >
                <span className="min-w-0 flex-1 truncate" style={o.font ? { fontFamily: `"${o.font}", ui-sans-serif, system-ui` } : undefined}>
                  {o.label}
                </span>
                {selected && <Check className="h-4 w-4 shrink-0 text-ink" aria-hidden />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ThemeColorField({
  layerId,
  label,
  value,
  open,
  onOpenChange,
  onChange,
}: {
  layerId: string;
  label: string;
  value: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (hex: string) => void;
}) {
  const inputId = useId();
  const [text, setText] = useState(value);
  const swatchRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setText((t) => (normalizeHex(t) === normalizeHex(value) ? t : value));
  }, [value]);

  return (
    <div
      data-theme-layer={layerId}
      className="relative min-w-0"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        e.stopPropagation();
        onOpenChange(false);
        swatchRef.current?.focus();
      }}
    >
      <label htmlFor={inputId} className={THEME_FIELD_LABEL}>
        {label}
      </label>
      <div className={`${FIELD_FRAME} flex items-center gap-2 pl-1.5 pr-2.5 focus-within:border-[#027bff] focus-within:ring-2 focus-within:ring-[#027bff]/15`}>
        <button
          ref={swatchRef}
          type="button"
          aria-label={`Pick ${label.toLowerCase()} colour`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className="h-7 w-7 shrink-0 rounded-[7px] border border-black/10 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)] outline-none focus-visible:ring-2 focus-visible:ring-[#027bff]/40"
          style={{ backgroundColor: value }}
        />
        <input
          id={inputId}
          aria-label={`${label} colour`}
          value={text}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            const hex = normalizeHex(e.target.value);
            if (hex && e.target.value.replace("#", "").length === 6) onChange(hex);
          }}
          onBlur={() => setText(value)}
          className="min-w-0 flex-1 bg-transparent font-mono text-[13px] uppercase text-ink outline-none"
        />
      </div>
      {open && <ColorPopover label={label} value={value} onChange={onChange} />}
    </div>
  );
}

function ColorPopover({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const areaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setHsv((cur) => (hsvToHex(cur) === normalizeHex(value) ? cur : hexToHsv(value)));
  }, [value]);

  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  const update = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    if (hex !== normalizeHex(value)) onChange(hex);
  };

  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width || !r.height) return;
    update({ h: hsv.h, s: clamp((e.clientX - r.left) / r.width, 0, 1), v: clamp(1 - (e.clientY - r.top) / r.height, 0, 1) });
  };

  const onAreaKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const moves: Record<string, Partial<Hsv>> = {
      ArrowRight: { s: clamp(hsv.s + step, 0, 1) },
      ArrowLeft: { s: clamp(hsv.s - step, 0, 1) },
      ArrowUp: { v: clamp(hsv.v + step, 0, 1) },
      ArrowDown: { v: clamp(hsv.v - step, 0, 1) },
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    update({ ...hsv, ...move });
  };

  const hueColor = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  return (
    <div role="dialog" aria-label={`${label} colour picker`} className={`${POPOVER} left-0 top-full mt-1.5 w-[232px] space-y-3 p-3`}>
      <div
        ref={areaRef}
        role="slider"
        tabIndex={0}
        aria-label={`${label} saturation and brightness`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        onKeyDown={onAreaKey}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) fromPointer(e);
        }}
        className="relative h-[132px] w-full cursor-crosshair touch-none rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-[#027bff]/40"
        style={{ backgroundColor: hueColor, backgroundImage: "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)" }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: hsvToHex(hsv) }}
        />
      </div>
      <input
        type="range"
        min={0}
        max={359}
        step={1}
        aria-label={`${label} hue`}
        value={Math.round(hsv.h)}
        onChange={(e) => update({ ...hsv, h: Number(e.target.value) })}
        className="block h-3 w-full cursor-pointer appearance-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[#027bff]/40 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-transparent [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
        style={{ background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }}
      />
    </div>
  );
}
