import { useEffect, useId, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Menu as MenuIcon, X } from "lucide-react";
import { useSession } from "../../zavi/react";
import { Container } from "../ui/layout";
import { ActionLink, scrollToHash, useSameHashClick, type Action } from "./action";
import { cn } from "../../lib/utils";

export type NavItem = { label: string; href: string };

function LogoImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return <img src={src} alt="" className="h-8 w-auto shrink-0" onError={() => setFailed(true)} />;
}

function NavItemLink({ item, className, onClick }: { item: NavItem; className: string; onClick?: () => void }) {
  const sameHash = useSameHashClick(item.href);
  if (item.href.startsWith("/") && !item.href.startsWith("//")) {
    if (item.href.includes("#")) {
      return (
        <Link
          to={item.href}
          onClick={() => {
            onClick?.();
            sameHash?.();
          }}
          className={className}
        >
          {item.label}
        </Link>
      );
    }
    return (
      <NavLink to={item.href} end onClick={onClick} className={({ isActive }) => cn(className, isActive && "text-foreground")}>
        {item.label}
      </NavLink>
    );
  }
  return (
    <a href={item.href} onClick={onClick} className={className}>
      {item.label}
    </a>
  );
}

export function SiteHeader({
  name,
  logo,
  links = [],
  cta,
  showAccount = true,
}: {
  name: string;
  logo?: ReactNode;
  links?: NavItem[];
  cta?: Action;
  showAccount?: boolean;
}) {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname, location.hash]);

  const account: NavItem | null = showAccount ? (user ? { label: "Account", href: "/account" } : { label: "Sign in", href: "/login" }) : null;
  const linkClass = "text-sm font-medium text-muted-foreground transition-colors hover:text-foreground";

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <Container className="flex h-16 items-center justify-between gap-4">
        <Link to="/" className="flex min-w-0 items-center gap-2.5 font-display text-lg font-semibold tracking-tight">
          {typeof logo === "string" ? <LogoImage src={logo} /> : logo}
          <span className="truncate">{name}</span>
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-7 md:flex">
          {links.map((l) => (
            <NavItemLink key={l.href} item={l} className={linkClass} />
          ))}
          {account ? <NavItemLink item={account} className={linkClass} /> : null}
          {cta ? <ActionLink action={cta} size="sm" /> : null}
        </nav>
        <button
          type="button"
          className="inline-flex size-10 items-center justify-center rounded-md text-foreground hover:bg-muted md:hidden"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X aria-hidden className="size-5" /> : <MenuIcon aria-hidden className="size-5" />}
        </button>
      </Container>
      <div id={panelId} hidden={!open} className="border-t border-border bg-background md:hidden">
        <Container className="flex flex-col gap-1 py-4">
          {[...links, ...(account ? [account] : [])].map((l) => (
            <NavItemLink key={l.href} item={l} onClick={() => setOpen(false)} className="rounded-md px-2 py-3 text-base font-medium text-foreground hover:bg-muted" />
          ))}
          {cta ? <ActionLink action={cta} className="mt-3 w-full" /> : null}
        </Container>
      </div>
    </header>
  );
}

export function ScrollManager() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (!hash || !scrollToHash(hash)) window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}
