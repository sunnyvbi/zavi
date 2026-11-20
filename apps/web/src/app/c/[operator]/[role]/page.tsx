
import { ApplyChat } from "./ApplyChat";
import { Markdown } from "@/components/workspace/Markdown";

type PublicRole = {
  role_id: string;
  tenant_id: string;
  title: string;
  jd: string;
  approved_questions: unknown;
};

async function fetchPublicRole(operator: string, role: string): Promise<PublicRole | null> {
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/get_public_role`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!}`,
    },
    body: JSON.stringify({ p_operator_slug: operator, p_role_slug: role }),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as PublicRole[];
  return rows[0] ?? null;
}

function operatorLabel(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-cream font-body text-ink antialiased selection:bg-ink selection:text-cream">
      {}
      <div className="border-b border-ink/10 bg-cream/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3.5 sm:px-6">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-inkMuted">
            Careers
          </span>
          <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-inkMuted">
            <span className="relative flex size-1.5">
              <span className="relative size-1.5 rounded-full bg-mintDeep" />
            </span>
            Powered by Zavi
          </span>
        </div>
      </div>
      <div className="mx-auto max-w-3xl px-4 pb-16 pt-8 sm:px-6 sm:pt-12">{children}</div>
    </main>
  );
}

export default async function CandidatePage(
  props: {
    params: Promise<{ operator: string; role: string }>;
  }
) {
  const params = await props.params;
  const role = await fetchPublicRole(params.operator, params.role);
  const operator = operatorLabel(params.operator);

  if (!role) {
    return (
      <PageFrame>
        <div className="rounded-2xl border border-ink/10 bg-white p-7 shadow-[0_10px_30px_-12px_rgba(25,25,25,0.16)] sm:p-9">
          <span className="inline-flex items-center rounded-full bg-marigold/25 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.16em] text-marigoldDeep">
            Role closed
          </span>
          <h1 className="mt-4 font-display text-[26px] font-semibold tracking-tighter text-ink sm:text-[30px]">
            This role isn&apos;t accepting applications
          </h1>
          <p className="mt-2.5 text-[14px] leading-[1.6] text-inkMuted">
            The position may have been filled or the link may be out of date.
            If you believe this is a mistake, reach back out to whoever shared
            it with you.
          </p>
        </div>
      </PageFrame>
    );
  }

  return (
    <PageFrame>
      {}
      <header className="mb-6">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-ink font-display text-[16px] font-semibold text-cream">
            {operator.slice(0, 1)}
          </span>
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-inkMuted">
            {operator} · Now hiring
          </span>
        </div>
        <h1 className="mt-4 font-display text-[30px] font-semibold leading-[1.1] tracking-tighter text-ink sm:text-[38px]">
          {role.title}
        </h1>
        <p className="mt-2.5 max-w-xl text-[14px] leading-[1.6] text-inkMuted">
          Apply in a few minutes. No account, no password. Share your resume
          and have a short conversation. <span className="text-ink">Real
          people review every application.</span>
        </p>
      </header>

      {}
      <section className="mb-6 rounded-2xl border border-ink/10 bg-white shadow-[0_8px_24px_-12px_rgba(25,25,25,0.10)]">
        <details className="group" open>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 sm:px-6">
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-inkMuted">
              About the role
            </span>
            <svg
              viewBox="0 0 16 16"
              className="size-4 shrink-0 text-inkMuted transition-transform duration-200 group-open:rotate-180"
              aria-hidden
            >
              <path
                d="M4 6l4 4 4-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </summary>
          <div className="border-t border-ink/[0.07] px-4 py-4 text-inkSoft sm:px-6">
            {}
            <Markdown
              source={role.jd}
              disableActionLinks
              className="prose-headings:mt-4 prose-headings:mb-1.5 first:prose-headings:mt-0 text-[16px] prose-p:text-[16px] prose-li:text-[16px]"
            />
          </div>
        </details>
      </section>

      {}
      <ApplyChat
        operatorSlug={params.operator}
        roleSlug={params.role}
        roleTitle={role.title}
        operatorLabel={operator}
      />

      {}
      <p className="mt-6 text-[13px] leading-[1.6] text-inkMuted">
        This application uses AI-assisted screening to make first contact faster
        and more human. A person reviews every application. We never ask about
        protected characteristics.
      </p>
    </PageFrame>
  );
}
