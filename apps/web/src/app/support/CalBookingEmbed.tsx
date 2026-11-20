"use client";

import { useEffect, useRef, useState } from "react";

const CAL_LINK = "ravi-ramadasu-wgh4xi/30min";
const CAL_URL = `https://cal.com/${CAL_LINK}`;
const NS = "30min";

const fullHeight = () => (window.innerWidth < 768 ? 700 : 500);

export function CalBookingEmbed() {
  const initialized = useRef(false);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    /* eslint-disable @typescript-eslint/no-explicit-any */
    (function (C: any, A: string, L: string) {
      const p = function (a: any, ar: any) {
        a.q.push(ar);
      };
      const d = C.document;
      C.Cal =
        C.Cal ||
        function (...args: any[]) {
          const cal = C.Cal;
          const ar = args;
          if (!cal.loaded) {
            cal.ns = {};
            cal.q = cal.q || [];
            const s = d.head.appendChild(d.createElement("script"));
            s.src = A;
            s.onerror = () => C.__calScriptFailed?.();
            cal.loaded = true;
          }
          if (ar[0] === L) {
            const api: any = function (...apiArgs: any[]) {
              p(api, apiArgs);
            };
            const namespace = ar[1];
            api.q = api.q || [];
            if (typeof namespace === "string") {
              cal.ns[namespace] = cal.ns[namespace] || api;
              p(cal.ns[namespace], ar);
              p(cal, ["initNamespace", namespace]);
            } else p(cal, ar);
            return;
          }
          p(cal, ar);
        };
    })(window, "https://app.cal.com/embed/embed.js", "init");

    (window as any).__calScriptFailed = () => setState("failed");

    const Cal = (window as any).Cal;
    Cal("init", NS, { origin: "https://app.cal.com" });
    Cal.ns[NS]("inline", {
      elementOrSelector: "#cal-booking-inline",
      config: { layout: "month_view", theme: "light" },
      calLink: CAL_LINK,
    });
    Cal.ns[NS]("ui", { theme: "light", hideEventTypeDetails: false, layout: "month_view" });
    Cal.ns[NS]("on", {
      action: "linkFailed",
      callback: () => setState("failed"),
    });

    const container = document.getElementById("cal-booking-inline");
    let revealed = false;
    const hook = (iframe: HTMLIFrameElement) => {
      iframe.setAttribute("scrolling", "no");
      const check = () => {
        if (!revealed && iframe.getBoundingClientRect().height >= fullHeight()) {
          revealed = true;
          ro.disconnect();
          setState("ready");
        }
      };
      const ro = new ResizeObserver(check);
      ro.observe(iframe);
      check();
    };
    const existing = container?.querySelector("iframe");
    if (existing) hook(existing as HTMLIFrameElement);
    const mo = new MutationObserver(() => {
      const ifr = container?.querySelector("iframe");
      if (ifr) {
        mo.disconnect();
        hook(ifr as HTMLIFrameElement);
      }
    });
    if (container && !existing) mo.observe(container, { childList: true, subtree: true });
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, []);

  return (
    <div>
      {state === "loading" && (
        <div className="flex h-[740px] w-full items-center justify-center rounded-lg border border-[#ececec] bg-white md:h-[535px]">
          <span
            role="status"
            aria-label="Loading booking calendar"
            className="size-8 animate-spin rounded-full border-2 border-[#e5e5e5] border-t-[#0e0f11]"
          />
        </div>
      )}
      {state === "failed" && (
        <div className="flex h-[300px] w-full flex-col items-center justify-center gap-4 rounded-lg border border-[#ececec] bg-white px-6 text-center">
          <p className="text-[14px] text-[#595959]">
            The booking calendar couldn&apos;t load here.
          </p>
          <a
            href={CAL_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-11 items-center justify-center rounded-block bg-[#0e0f11] px-4 text-[14px] font-semibold text-white transition-colors hover:bg-[#26282b]"
          >
            Book on Cal.com
          </a>
        </div>
      )}
      {}
      <div
        id="cal-booking-inline"
        className={
          state === "ready"
            ? "-mb-8 min-h-[740px] w-full opacity-100 transition-opacity duration-300 md:-mb-[35px] md:min-h-[535px]"
            : "h-0 w-full overflow-hidden opacity-0"
        }
      />
    </div>
  );
}
