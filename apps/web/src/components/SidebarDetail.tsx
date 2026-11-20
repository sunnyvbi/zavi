
import type { ReactNode } from "react";

export type SidebarDetailProps = {
  sidebar: ReactNode;
  detail: ReactNode;
  sidebarOpen?: boolean;
  onCloseSidebar?: () => void;
  sidebarLabel?: string;
  detailLabel?: string;
};

export function SidebarDetail({
  sidebar,
  detail,
  sidebarOpen = false,
  onCloseSidebar,
  sidebarLabel = "Sidebar",
  detailLabel = "Detail",
}: SidebarDetailProps) {
  return (
    <div className="relative flex min-h-[calc(100vh-3.5rem)] bg-cream">
      {}
      <button
        type="button"
        aria-label="Close sidebar"
        onClick={onCloseSidebar}
        className={`fixed inset-0 z-30 bg-ink/40 md:hidden ${
          sidebarOpen ? "block" : "hidden"
        }`}
        tabIndex={sidebarOpen ? 0 : -1}
      />

      <nav
        aria-label={sidebarLabel}
        className={`
          fixed inset-y-14 left-0 z-40 w-[80vw] max-w-[296px] border-r border-bone bg-bone
          transition-transform duration-200 ease-out
          md:sticky md:top-14 md:translate-x-0 md:h-[calc(100vh-3.5rem)] md:w-[296px] md:max-w-[296px] md:flex-shrink-0
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
        `}
        onKeyDown={(e) => {
          if (e.key === "Escape" && sidebarOpen) onCloseSidebar?.();
        }}
      >
        <div className="h-full overflow-y-auto">{sidebar}</div>
      </nav>

      <section
        aria-label={detailLabel}
        className="flex-1 min-w-0"
      >
        {detail}
      </section>
    </div>
  );
}
