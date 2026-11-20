type Props = {
  connecting: boolean;
  error: string | null;
  onConnect: () => void;
  linkOnly?: boolean;
};

export function SetupCard({ connecting, error, onConnect, linkOnly = false }: Props) {
  return (
    <section className="border-y border-neutral-200 bg-white px-5 py-8 sm:rounded-xl sm:border sm:px-8" aria-labelledby="shopify-setup-title">
      <div className="max-w-xl">
        <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-neutral-500">Shopify connection</p>
        <h1 id="shopify-setup-title" className="mt-3 text-2xl font-semibold tracking-[-0.025em] text-neutral-950">
          {linkOnly ? "Link your Shopify staff account" : "Finish setting up Zavi"}
        </h1>
        <p className="mt-3 text-[14px] leading-6 text-neutral-600">
          {linkOnly
            ? "This store is already connected to Zavi. Sign in to Zavi as an owner or admin of that workspace. When you return, review the exact workspace and select Link account."
            : "Sign in or create a free Zavi account, then choose the workspace for this store. When you return, review the exact workspace and select Connect store."}
        </p>
        {error && <div role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-800">{error}</div>}
        <button
          type="button"
          disabled={connecting}
          onClick={onConnect}
          className="mt-6 rounded-lg bg-neutral-950 px-5 py-3 text-[14px] font-medium text-white transition hover:bg-neutral-800 disabled:cursor-wait disabled:opacity-60"
        >
          {connecting ? "Opening Zavi…" : "Continue to Zavi"}
        </button>
        <p className="mt-3 text-[12px] leading-5 text-neutral-500">
          {linkOnly ? "After you sign in, Zavi will bring you back to Shopify." : "After you sign in or create your workspace, Zavi will bring you back to Shopify."}
        </p>
      </div>
    </section>
  );
}
