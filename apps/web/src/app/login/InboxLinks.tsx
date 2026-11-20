import { inboxLinks } from "./inboxProviders";

export function InboxLinks({ email, className }: { email: string; className?: string }) {
  return (
    <nav aria-label="Open your inbox" className={className}>
      <ul className="flex items-center gap-3">
        {inboxLinks(email).map((link) => (
          <li key={link.id}>
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${link.name}`}
              aria-label={`Open ${link.name} in a new tab`}
              className="flex size-14 items-center justify-center rounded-[16px] border border-[#e5e5e5] bg-white transition-colors hover:bg-[#f7f6f3] focus-visible:border-[#171717] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#171717]/10"
            >
              <img src={link.logo} alt="" className="size-[22px] object-contain" />
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
