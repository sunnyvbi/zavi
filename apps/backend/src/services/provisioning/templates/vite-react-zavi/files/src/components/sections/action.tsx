import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import type { VariantProps } from "class-variance-authority";
import { buttonVariants } from "../ui/button";
import { cn } from "../../lib/utils";

export type Action = { label: string; href: string };

type Look = VariantProps<typeof buttonVariants>;

export function scrollToHash(hash: string): boolean {
  const el = document.getElementById(decodeURIComponent(hash.replace(/^#/, "")));
  if (!el) return false;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  return true;
}

export function useSameHashClick(href: string): (() => void) | undefined {
  const { pathname, hash } = useLocation();
  const at = href.indexOf("#");
  if (at < 0) return undefined;
  const target = { path: href.slice(0, at) || pathname, hash: href.slice(at) };
  return () => {
    if (target.path === pathname && target.hash === hash) scrollToHash(hash);
  };
}

export function ActionLink({
  action,
  variant,
  size = "lg",
  className,
  children,
}: { action: Action; className?: string; children?: ReactNode } & Look) {
  const sameHash = useSameHashClick(action.href);
  const cls = cn(buttonVariants({ variant, size }), className);
  const body = children ?? action.label;
  if (action.href.startsWith("/") && !action.href.startsWith("//")) {
    return (
      <Link to={action.href} onClick={sameHash} className={cls}>
        {body}
      </Link>
    );
  }
  const external = /^https?:\/\//i.test(action.href);
  return (
    <a href={action.href} className={cls} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {body}
    </a>
  );
}

export function Actions({ actions, className, align = "start" }: { actions?: Action[]; className?: string; align?: "start" | "center" }) {
  if (!actions?.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-3", align === "center" && "justify-center", className)}>
      {actions.map((a, i) => (
        <ActionLink key={`${a.href}-${a.label}`} action={a} variant={i === 0 ? "default" : "outline"} />
      ))}
    </div>
  );
}
