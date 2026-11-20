"use client";

import { useEffect, useRef, type ReactNode } from "react";

type Section = { id: string; label: string };

const ICONS: Record<string, ReactNode> = {
  rules: (
    <svg className="h-full w-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 21h11a2 2 0 0 0 2-2v-2H10v2a2 2 0 0 1-4 0V5a2 2 0 0 0-2-2h11a2 2 0 0 1 2 2v12" />
      <path d="M10 8h4M10 12h4" />
    </svg>
  ),
  company: (
    <svg className="h-full w-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 21h18" />
      <path d="M5 21V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v16" />
      <path d="M14 21v-8h3a2 2 0 0 1 2 2v6" />
      <path d="M8 7h3M8 11h3M8 15h3" />
    </svg>
  ),
  personalization: (
    <svg className="h-full w-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </svg>
  ),
  reporting: (
    <svg className="h-full w-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  integration: (
    <svg className="h-full w-full" viewBox="20 182 20 20" fill="none" aria-hidden>
      <path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d="M25.6443 191.966C25.4733 191.829 25.3652 191.796 25.2708 191.798L25.263 191.799H25.2552C25.1806 191.799 25.0791 191.827 24.9025 191.967C24.7603 192.08 24.6264 192.217 24.4543 192.392C24.3924 192.455 24.3255 192.524 24.2515 192.598C23.7442 193.105 23.3904 193.727 23.272 194.24L23.2712 194.244C22.8842 195.878 23.4681 197.013 24.2027 197.796C25.9974 199.493 28.1164 198.815 28.9495 198.14C29.3293 197.833 29.5317 197.623 29.7079 197.44C29.7556 197.391 29.8013 197.344 29.8481 197.297L29.8563 197.289L29.8648 197.281C30.1348 197.03 30.1914 196.846 30.1978 196.744C30.2041 196.643 30.1687 196.507 30.0191 196.336C29.9531 196.26 29.6835 195.993 29.2715 195.586C29.2383 195.553 29.2041 195.519 29.1691 195.484C28.7163 195.036 28.1437 194.467 27.582 193.891C27.3826 193.691 27.2061 193.514 27.0469 193.353C26.7392 193.044 26.4957 192.799 26.2748 192.585L26.2675 192.578L26.2676 192.578C26.1778 192.489 26.1008 192.409 26.0309 192.336C25.889 192.189 25.7762 192.072 25.6443 191.966ZM22.9107 198.202C22.1486 197.202 21.619 195.798 22.0544 193.957C22.2355 193.175 22.7285 192.353 23.3676 191.714C23.4156 191.666 23.4662 191.614 23.5186 191.56C23.7051 191.37 23.9159 191.154 24.1249 190.988C24.4078 190.763 24.7773 190.551 25.2473 190.549C25.7474 190.538 26.1353 190.758 26.4259 190.991C26.6239 191.149 26.8258 191.359 26.9922 191.531C27.0482 191.589 27.1002 191.643 27.1466 191.69C27.376 191.911 27.6333 192.17 27.9466 192.485C28.1052 192.645 28.278 192.819 28.4688 193.01L28.4746 193.016L28.4746 193.016C29.0286 193.584 29.5954 194.147 30.0485 194.596C30.0979 194.645 30.1464 194.693 30.1936 194.74C30.5647 195.107 30.862 195.401 30.9598 195.513C31.2638 195.86 31.4776 196.307 31.4453 196.822C31.4133 197.332 31.1471 197.793 30.7246 198.188C30.6926 198.22 30.6578 198.256 30.6192 198.297C30.4413 198.481 30.1812 198.751 29.7363 199.112C28.6514 199.99 26.0776 200.849 23.7925 199.088L22.108 200.773C21.8639 201.017 21.4682 201.017 21.2241 200.773C20.98 200.529 20.98 200.133 21.2241 199.889L22.9107 198.202Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M38.7754 183.225C39.0195 183.469 39.0196 183.864 38.7755 184.109L37.0881 185.796C37.8522 186.799 38.3899 188.215 37.9541 190.058C37.773 190.841 37.2799 191.663 36.6406 192.302C36.5926 192.35 36.542 192.402 36.4896 192.456C36.303 192.646 36.0922 192.862 35.8832 193.028C35.6002 193.253 35.2307 193.466 34.7606 193.468C34.2846 193.478 33.9224 193.302 33.6326 193.076C33.5476 193.01 33.4616 192.932 33.3781 192.852L32.5222 193.688C32.2753 193.929 31.8796 193.924 31.6384 193.677C31.3973 193.43 31.4021 193.034 31.649 192.793L32.495 191.967C32.3696 191.842 32.2348 191.706 32.0924 191.563C31.9181 191.387 31.7323 191.2 31.5382 191.006L31.5324 191C31.0144 190.468 30.4862 189.942 30.0497 189.509L29.2031 190.361C28.9598 190.606 28.564 190.607 28.3192 190.364C28.0744 190.121 28.0731 189.725 28.3165 189.48L29.1642 188.627C29.1135 188.575 29.0734 188.532 29.0466 188.502C28.7425 188.154 28.5287 187.707 28.561 187.192C28.593 186.682 28.8592 186.221 29.2818 185.825C29.3138 185.793 29.3486 185.757 29.3873 185.717C29.5652 185.532 29.8253 185.262 30.2704 184.901C31.3522 184.025 33.9195 183.149 36.2064 184.91L37.8915 183.225C38.1356 182.981 38.5313 182.981 38.7754 183.225ZM35.7962 186.202C34.0036 184.507 31.8942 185.194 31.0573 185.873C30.6774 186.18 30.4749 186.39 30.2986 186.573C30.251 186.622 30.2052 186.67 30.1584 186.717L30.1502 186.725L30.1418 186.733C29.8716 186.984 29.815 187.168 29.8085 187.27C29.8022 187.371 29.8377 187.507 29.9874 187.679C30.0338 187.732 30.2039 187.903 30.4862 188.183C30.5544 188.25 30.6278 188.323 30.7056 188.4C31.1763 188.866 31.8078 189.491 32.4251 190.125C32.6284 190.328 32.8184 190.52 32.9938 190.696C33.3237 191.029 33.6021 191.309 33.821 191.52L33.8283 191.527C33.923 191.622 34 191.702 34.0672 191.772C34.1962 191.906 34.2892 192.003 34.4008 192.09C34.5285 192.189 34.6184 192.221 34.737 192.218L34.7448 192.218H34.7526C34.8272 192.218 34.9288 192.19 35.1055 192.05C35.2477 191.936 35.3816 191.8 35.5538 191.624C35.6158 191.561 35.6826 191.493 35.7567 191.419C36.2641 190.911 36.6181 190.288 36.7365 189.775L36.7373 189.771C37.1241 188.138 36.5321 186.987 35.7962 186.202Z" fill="currentColor" />
    </svg>
  ),
  agents: (
    <svg className="h-full w-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="8" width="16" height="11" rx="3" />
      <path d="M12 3v3M9 13h.01M15 13h.01" />
    </svg>
  ),
  notetaker: (
    <svg className="h-full w-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4" />
    </svg>
  ),
  notifications: (
    <svg className="h-full w-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m4 7 8 6 8-6" />
    </svg>
  ),
  commands: (
    <svg className="h-full w-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m7 8 4 4-4 4M13 16h4" />
      <rect x="3" y="4" width="18" height="16" rx="3" />
    </svg>
  ),
  email: (
    <svg className="h-full w-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 9V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" />
      <path d="m3.5 6.5 8.5 6 8.5-6" />
      <rect x="15" y="14" width="7" height="6" rx="1.5" />
      <path d="M17 14v-1.5a1.5 1.5 0 0 1 3 0V14" />
    </svg>
  ),
  "ai-clients": (
    <svg className="h-full w-full" viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden>
      <path d="M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z" />
      <path d="M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z" />
    </svg>
  ),
  team: (
    <svg className="h-full w-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 19a6 6 0 0 1 12 0M16 6a3 3 0 0 1 0 6M21 19a5 5 0 0 0-4-4.9" />
    </svg>
  ),
  feedback: (
    <svg className="h-full w-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
    </svg>
  ),
  account: (
    <svg className="h-full w-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="10" r="3" />
      <path d="M6.2 18.2a6.5 6.5 0 0 1 11.6 0" />
    </svg>
  ),
  billing: (
    <svg className="h-full w-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 3h9l3 3v15l-2.5-1.5L13 21l-2.5-1.5L8 21l-2-1.5V3Z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </svg>
  ),
};

export function SettingsSubNav({
  sections,
  activeId,
  onSelect,
  title,
  variant = "default",
}: {
  sections: Section[];
  activeId: string;
  onSelect: (id: string) => void;
  title?: string;
  variant?: "default" | "rail" | "pills";
}) {
  const pillsRef = useRef<HTMLDivElement>(null);
  const shownId = useRef(activeId);
  useEffect(() => {
    if (shownId.current === activeId) return;
    shownId.current = activeId;
    const row = pillsRef.current;
    const el = row?.querySelector<HTMLElement>('[data-active="true"]');
    if (!row || !el || typeof row.scrollTo !== "function") return;
    const rowBox = row.getBoundingClientRect();
    const pill = el.getBoundingClientRect();
    if (pill.left >= rowBox.left && pill.right <= rowBox.right) return;
    row.scrollTo({
      left: row.scrollLeft + (pill.left - rowBox.left) - (rowBox.width - pill.width) / 2,
      behavior: "smooth",
    });
  }, [activeId]);

  const nav = (
    <nav className="flex flex-col gap-0.5">
      {sections.map((s) => {
        const active = activeId === s.id;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            className={`flex w-full max-w-[224px] items-center gap-2 rounded-cta px-3 py-2.5 text-left text-[16px] font-medium tracking-[0.14px] transition-colors ${
              active
                ? variant === "rail"
                  ? "bg-white text-[#0e0f11] shadow-[0_1px_2px_rgba(25,25,25,0.08)]"
                  : "bg-[#f0f0f0] text-[#0e0f11]"
                : variant === "rail"
                  ? "text-[#3a3a3a] hover:bg-[#f0f0f0] hover:text-[#0e0f11]"
                  : "text-[#0e0f11] hover:bg-[#f6f6f6]"
            }`}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[#0e0f11]">
              {ICONS[s.id]}
            </span>
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
          </button>
        );
      })}
    </nav>
  );

  const pills = (
    <div
      ref={pillsRef}
      className={
        variant === "pills"
          ? "hide-scrollbar -mx-6 mb-5 overflow-x-auto px-6 pb-1 compact:-mx-4 compact:px-4 md:hidden"
          : "hide-scrollbar -mx-6 mb-4 overflow-x-auto px-6 pb-1 compact:-mx-4 compact:px-4 md:hidden"
      }
    >
      <div className="inline-flex gap-0.5 whitespace-nowrap rounded-full bg-[#f0f0f0] p-1">
        {sections.map((s) => {
          const active = activeId === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id)}
              aria-pressed={active}
              data-active={active ? "true" : undefined}
              className={`flex min-h-[40px] touch-manipulation items-center gap-2 rounded-full px-3.5 text-[13px] font-medium transition-colors ${
                active
                  ? "bg-white text-[#0e0f11] shadow-[0_1px_2px_rgba(25,25,25,0.08)]"
                  : "text-[#595959] hover:text-[#0e0f11]"
              }`}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {ICONS[s.id]}
              </span>
              {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );

  if (variant === "rail") {
    return (
      <aside className="hidden w-[248px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-[#ececec] bg-[#fafafa] px-3 py-4 md:flex">
        {title && (
          <h1 className="px-3 text-[12px] font-semibold uppercase tracking-[0.1em] text-[#8a8a8a]">
            {title}
          </h1>
        )}
        {nav}
      </aside>
    );
  }
  if (variant === "pills") return pills;

  return (
    <>
      <aside className="hidden md:block md:w-56 md:shrink-0">
        <div className="sticky top-6 flex flex-col gap-3">
          {title && (
            <h1 className="px-3 text-[20px] font-semibold leading-[25px] text-[#0e0f11]">
              {title}
            </h1>
          )}
          {nav}
        </div>
      </aside>
      {pills}
    </>
  );
}
