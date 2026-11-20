
const DEFAULT_ICON_SIZE = "h-[18px] w-[18px]";

export function CreateIcon({ className = DEFAULT_ICON_SIZE }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M11.5 2.5H6A1.5 1.5 0 0 0 4.5 4v12A1.5 1.5 0 0 0 6 17.5h8a1.5 1.5 0 0 0 1.5-1.5V6.5L11.5 2.5Z" />
      <path d="M11.5 2.5V6.5h4" />
      <path d="M10 9.5v4M8 11.5h4" />
    </svg>
  );
}

export function GrowIcon({ className = DEFAULT_ICON_SIZE }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M3.5 17.5V5.2L10 2.5l6.5 2.7V17.5" />
      <path d="M2.5 17.5h15" />
      <path d="M7 8.5h1.5M7 11.5h1.5M11.5 8.5H13M11.5 11.5H13" />
    </svg>
  );
}

export function OrDivider() {
  return (
    <div className="flex items-center gap-3" aria-hidden>
      <div className="flex-1" />
      <span className="text-[16px] font-medium text-[#1f1f1f]">Or</span>
      <div className="h-px flex-1 bg-[#e5e5e5]" />
    </div>
  );
}
