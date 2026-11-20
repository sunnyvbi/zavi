import { LinkButton } from "@/components/ui/LinkButton";

export function TitleBar({ openUrl }: { openUrl: string }) {
  return (
    <header className="flex items-center justify-between px-4 py-3 sm:px-0">
      <div className="flex items-center gap-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-neutral-900 text-xs font-bold text-white" aria-hidden="true">Z</span>
        <h1 className="text-xl font-semibold text-neutral-900">Zavi</h1>
      </div>
      <LinkButton variant="primary" className="h-9 px-3.5" href={openUrl} target="_blank" rel="noopener noreferrer">Open Zavi <span aria-hidden="true">↗</span></LinkButton>
    </header>
  );
}
