
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { zavi } from "./index";

type TurnstileApi = {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
};
const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loader: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  const w = window as unknown as { turnstile?: TurnstileApi };
  if (w.turnstile) return Promise.resolve(w.turnstile);
  if (!loader) {
    loader = new Promise<TurnstileApi>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SCRIPT_URL;
      s.async = true;
      s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error("turnstile did not load")));
      s.onerror = () => reject(new Error("turnstile did not load"));
      document.head.appendChild(s);
    });
    loader.catch(() => { loader = null; });
  }
  return loader;
}

export type Captcha = {
  widget: ReactElement | null;
  token: string | null;
  required: boolean;
  reset(): void;
};

export function useCaptcha(enabled = true): Captcha {
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    zavi.captcha.siteKey().then((k) => { if (live) setSiteKey(k); }).catch(() => {  });
    return () => { live = false; };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !siteKey || !box.current) return;
    let api: TurnstileApi | null = null;
    let live = true;
    loadTurnstile().then((t) => {
      if (!live || !box.current) return;
      api = t;
      widgetId.current = t.render(box.current, {
        sitekey: siteKey,
        callback: (v: string) => setToken(v),
        "expired-callback": () => setToken(null),
        "error-callback": () => setToken(null),
      });
    }).catch(() => {  });
    return () => {
      live = false;
      if (api && widgetId.current) api.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [enabled, siteKey]);

  const reset = useCallback(() => {
    setToken(null);
    const t = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
    if (t && widgetId.current) t.reset(widgetId.current);
  }, []);

  const required = enabled && siteKey !== null;
  return {
    widget: required ? <div ref={box} data-zavi="captcha" /> : null,
    token,
    required,
    reset,
  };
}
