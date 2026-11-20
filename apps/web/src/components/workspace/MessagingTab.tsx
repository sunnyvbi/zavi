"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { isMember } from "@/lib/members";
import { useWorkspace } from "./WorkspaceShell";
import { ConnectorRowView } from "./SettingsTab";
import { Banner } from "./settings/ConnectorTile";
import { ConnectorErrorHost } from "./settings/connectorErrorDialog";
import { SkeletonConnectorGrid } from "./Skeleton";
import {
  CHAT_SLUGS,
  chatConnectorRows,
  type ChatConnectorRow,
} from "./settings/chatConnectorRows";
import { TeamsTile } from "./settings/TeamsTile";
import { EmailTile } from "./settings/EmailTile";
import { McpClientsPanel } from "./settings/McpClientsPanel";

export function MessagingTab() {
  const { role } = useWorkspace();
  const readOnly = isMember(role);
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<ChatConnectorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const justConnectedSlack = searchParams.get("slack") === "connected";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoadError(false);
        const sb = createBrowserSupabase();
        const tenantId = await getActiveTenantId(sb);
        if (cancelled) return;
        if (!tenantId) {
          setLoadError(true);
          setLoading(false);
          return;
        }
        const res = await sb
          .from("connector_metadata")
          .select("slug, team_name, connected_at")
          .eq("tenant_id", tenantId)
          .in("slug", CHAT_SLUGS as unknown as string[]);
        if (cancelled) return;
        if (res.error) {
          setLoadError(true);
          setLoading(false);
          return;
        }
        setRows(chatConnectorRows(res.data ?? []));
        setLoading(false);
      } catch {
        if (cancelled) return;
        setLoadError(true);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const retry = useCallback(() => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      {}
      <ConnectorErrorHost />
      <div className="mx-auto w-full max-w-[900px] px-6 py-8">
        {}
        <div className="mb-5">
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight text-ink">
            Messaging
          </h1>
          <p className="mt-1 text-[16px] leading-6 text-inkMuted">
            Chat with Zavi in other messaging apps
          </p>
        </div>
        {loading ? (
          <SkeletonConnectorGrid />
        ) : (
          <div className="flex flex-col gap-8">
            {loadError && (
              <Banner tone="warning" title="Couldn’t load your messaging apps">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    Anything already connected still works. This is a display
                    hiccup, not a disconnection.
                  </span>
                  <button
                    type="button"
                    onClick={retry}
                    className="shrink-0 rounded-cta border border-amber-300 bg-white px-3 py-1.5 text-[13px] font-semibold text-amber-800 hover:bg-amber-100"
                  >
                    Retry
                  </button>
                </div>
              </Banner>
            )}

            {}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 [&>#connector-slack]:col-span-1">
              {rows.map((row) => (
                <ConnectorRowView
                  key={row.slug}
                  row={row}
                  flashConnected={row.slug === "slack" && justConnectedSlack}
                  readOnly={readOnly}
                  showConnectAffordance
                />
              ))}
              <TeamsTile readOnly={readOnly} />
              <EmailTile readOnly={readOnly} />
            </div>

            {}
            <section>
              <h2 className="text-[16px] font-semibold leading-6 tracking-tight text-ink">
                MCP
              </h2>
              <p className="mb-4 mt-1 text-[16px] leading-6 text-inkMuted">
                Run your agents from Claude Code, claude.ai or ChatGPT.
              </p>
              <McpClientsPanel showTokens={false} />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
