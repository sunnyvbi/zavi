import { useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useActiveTenant } from "../../features/workspaces/useActiveTenant";
import { useQueryClient } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { AppBottomSheet } from "../AppBottomSheet";
import { Icon } from "../Icon";
import { SkeletonBlock } from "../Skeleton";
import { OptionSheet } from "../OptionSheet";
import { CardButton } from "../reply/ui";
import { TextLink } from "../growth/StoryKit";
import { CampaignEditor } from "./CampaignEditor";
import { AdSheet, GroupSheet } from "./CampaignAssets";
import {
  MANAGE_ON_WEB,
  SPEC,
  adEditable,
  canEditHere,
  count,
  editBlocked,
  metricCards,
  money,
  percent,
  shortName,
  statusLabel,
  statusTone,
  type Campaign,
  type Dashboard,
  type Entity,
  type Metrics,
} from "../../features/channels/managedCampaigns";
import { useEntities, useReport, useWallet } from "../../features/channels/managedCampaignsHooks";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

type Tab = "campaigns" | "groups" | "ads";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "campaigns", label: "Campaigns" },
  { key: "groups", label: "Ad groups" },
  { key: "ads", label: "Ads" },
];

export async function openCampaignWeb() {
  const browserPackage =
    Platform.OS === "android"
      ? await WebBrowser.getCustomTabsSupportingBrowsersAsync()
          .then((b) => b.defaultBrowserPackage ?? b.preferredBrowserPackage ?? b.browserPackages[0])
          .catch(() => undefined)
      : undefined;
  return WebBrowser.openBrowserAsync(MANAGE_ON_WEB, { browserPackage });
}

export function CampaignWorkspace({ dashboard, loading, days, onChanged }: { dashboard: Dashboard | null; loading: boolean; days: number; onChanged: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const tenant = useActiveTenant();
  const [tab, setTab] = useState<Tab>("campaigns");
  const [filter, setFilter] = useState("all");
  const [picking, setPicking] = useState(false);
  const [version, setVersion] = useState(0);
  const [editor, setEditor] = useState<{ id: string | null } | null>(null);
  const [report, setReport] = useState<Campaign | null>(null);
  const [group, setGroup] = useState<{ campaign: Campaign; editing: Entity | null } | null>(null);
  const [ad, setAd] = useState<{ campaign: Campaign; editing: Entity | null } | null>(null);
  const [savedNote, setSavedNote] = useState<{ tenant: string; text: string } | null>(null);

  const [created, setCreated] = useState<{ tenant: string; campaign: Campaign; setupStarted?: boolean } | null>(null);
  const [pending, setPending] = useState<{ tenant: string; campaignId: string; kind: "groups" | "ads"; id: string } | null>(null);
  const createdHere = created?.tenant === tenant ? created.campaign : null;
  const listed = dashboard?.campaigns ?? [];
  const campaigns = createdHere && !listed.some((c) => c.id === createdHere.id) ? [createdHere, ...listed] : listed;
  const currency = dashboard?.currency ?? null;
  const prefix = dashboard?.campaign_name_prefix;
  const shown = filter === "all" ? campaigns : campaigns.filter((c) => c.id === filter);
  const level = tab === "groups" ? "ad_group" : tab === "ads" ? "ad" : null;
  const entities = useEntities(shown, level, days, version);
  const groupsForAd = useEntities(ad ? [ad.campaign] : [], ad ? "ad_group" : null, days, version);
  const wallet = useWallet(!!dashboard);
  const cards = metricCards(dashboard);
  const totals = dashboard?.totals_across_your_campaigns_only ?? {};

  const changed = (note: string) => {
    setVersion((v) => v + 1);
    void queryClient.invalidateQueries({ queryKey: ["managed-campaign"] });
    setSavedNote({ tenant, text: note });
    onChanged();
  };

  if (!dashboard) {
    return loading ? (
      <View style={styles.wrap} accessibilityRole="progressbar" accessibilityLabel="Loading your ChatGPT Ads account">
        <View style={styles.tiles}>
          {[0, 1, 2, 3, 4].map((i) => (
            <View key={i} style={styles.tile}>
              <SkeletonBlock width={60} height={10} />
              <SkeletonBlock width={90} height={22} />
              <SkeletonBlock width={80} height={10} />
            </View>
          ))}
        </View>
        <SkeletonBlock height={72} radius={16} />
        <SkeletonBlock height={160} radius={16} />
      </View>
    ) : null;
  }
  const w = wallet.data;
  const pendingHere = pending?.tenant === tenant && tab === pending.kind && (filter === "all" || filter === pending.campaignId) && !(entities.data ?? []).some((e) => e.id === pending.id) ? pending : null;
  const byId = new Map(campaigns.map((c) => [c.id, c]));

  return (
    <View style={styles.wrap}>
      {dashboard.setup_notice ? <Text style={styles.notice}>{dashboard.setup_notice}</Text> : null}
      {dashboard.warning ? <Text style={styles.notice}>{dashboard.warning}</Text> : null}

      <View style={styles.tiles}>
        {cards.map((c) => (
          <View key={c.key} style={styles.tile} accessibilityLabel={`${c.label} ${c.value}`}>
            <Text style={styles.tileLabel}>{c.label}</Text>
            <Text style={styles.tileValue}>{c.value}</Text>
            <Text style={styles.small} numberOfLines={2}>{c.help}</Text>
          </View>
        ))}
      </View>

      <View style={[styles.card, styles.balance]}>
        <View style={styles.balanceText}>
          <Text style={styles.cardTitle}>Ads balance</Text>
          {wallet.isLoading ? <SkeletonBlock width={120} height={14} /> : <Text style={styles.body}>
            {w ? `${money(w.available_cents / 100, "USD")} available${w.reserved_cents ? ` · ${money(w.reserved_cents / 100, "USD")} reserved` : ""}` : "Balance unavailable"}
          </Text>}
        </View>
        <CardButton label="Add funds" onPress={() => void openCampaignWeb().then(() => wallet.refetch())} accessibilityLabel="Add funds on zaviagent.com" />
      </View>

      {savedNote?.tenant === tenant ? <Text style={styles.ok} accessibilityLiveRegion="polite">{savedNote.text}</Text> : null}
      {createdHere && !created?.setupStarted ? <View style={styles.card}>
        <Text style={styles.body}>Campaign created and paused. Next: add an ad group, then an ad. Review and launch on zaviagent.com when ready.</Text>
        <CardButton label="Add ad group" onPress={() => { setFilter(createdHere.id); setTab("groups"); setGroup({ campaign: createdHere, editing: null }); }} />
      </View> : null}
      {campaigns.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{SPEC.empty.title}</Text>
          <Text style={styles.body}>{SPEC.empty.body}</Text>
          <CardButton label={dashboard.draft ? "Review researched draft" : "Create a campaign"} onPress={() => setEditor({ id: null })} />
        </View>
      ) : (
        <>
          <View style={styles.tabRow}>
            <View style={styles.tabs}>
              {TABS.map((t) => (
                <Pressable key={t.key} style={[styles.utab, tab === t.key && styles.utabOn]} onPress={() => setTab(t.key)} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}>
                  <Text style={[styles.utabText, tab === t.key && styles.utabTextOn]}>{t.label}</Text>
                </Pressable>
              ))}
            </View>
            {tab === "campaigns" ? (
              <Pressable style={styles.newBtn} onPress={() => setEditor({ id: null })} accessibilityRole="button" accessibilityLabel="New campaign">
                <Icon name="plus" size={14} color={colors.ink} />
                <Text style={styles.newText}>New</Text>
              </Pressable>
            ) : null}
          </View>
          {tab !== "campaigns" ? (
            <Pressable style={styles.filter} onPress={() => setPicking(true)} accessibilityRole="button" accessibilityLabel="Filter by campaign">
              <Text style={styles.filterText} numberOfLines={1}>
                {filter === "all" ? "All campaigns" : shortName(byId.get(filter)?.name ?? "", prefix)}
              </Text>
              <Icon name="chevron" size={14} color={colors.muted} />
            </Pressable>
          ) : null}


          {tab === "campaigns" ? (
            <DataTable
              columns={[
                { label: "Name", width: 150 },
                { label: "Status", width: 84 },
                { label: "Spend", width: 80, right: true },
                { label: "Clicks", width: 64, right: true },
                { label: "Impressions", width: 100, right: true },
                { label: "Conversions", width: 104, right: true },
                { label: "CTR", width: 72, right: true },
                { label: "Type", width: 84 },
                { label: "Actions", width: 150 },
              ]}
              rows={campaigns.map((c) => ({
                key: c.id,
                cells: [
                  <Text key="n" style={styles.cellStrong} numberOfLines={2}>{shortName(c.name, prefix)}</Text>,
                  <Chip key="s" status={c.status} />,
                  money(c.spend, currency),
                  count(c.clicks),
                  count(c.impressions),
                  count(c.conversions),
                  percent(c.ctr),
                  <Text key="t" style={styles.cell}>{c.bidding_type ?? "—"}</Text>,
                  <Actions key="a" onReport={() => setReport(c)} onEdit={canEditHere(c) ? () => setEditor({ id: c.id }) : () => void openCampaignWeb()} webOnly={!canEditHere(c)} />,
                ],
              }))}
              footer={[`${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"}`, "", money(totals.spend, currency), count(totals.clicks), count(totals.impressions), count(totals.conversions), percent(totals.ctr), "", ""]}
            />
          ) : null}

          {level ? <View style={styles.row}>
            <CardButton label="Refresh" variant="secondary" onPress={() => { setVersion((v) => v + 1); onChanged(); }} />
          </View> : null}
          {pendingHere ? <Text style={styles.notice} accessibilityLiveRegion="polite">Saved paused (reference {pendingHere.id}). The provider has not listed this {pendingHere.kind === "groups" ? "ad group" : "ad"} yet. Refresh before creating another.</Text> : null}
          {level ? (
            entities.isLoading ? (
              <TableSkeleton />
            ) : entities.isError ? (
              <Text style={styles.error}>{entities.error instanceof Error ? entities.error.message : "Could not read this."}</Text>
            ) : (
              <>
                {filter === "all" ? (
                  <Text style={styles.small}>Pick one campaign above to add an ad group or ad.</Text>
                ) : byId.get(filter) && canEditHere(byId.get(filter)!) ? (
                  <View style={styles.row}>
                    {tab === "groups" ? (
                      <CardButton label="Add ad group" onPress={() => setGroup({ campaign: byId.get(filter)!, editing: null })} />
                    ) : (
                      <CardButton label="Add ad" onPress={() => setAd({ campaign: byId.get(filter)!, editing: null })} />
                    )}
                  </View>
                ) : (
                  <Text style={styles.small}>{editBlocked(byId.get(filter) ?? { status: null }) ?? ""}</Text>
                )}
                {(entities.data ?? []).length === 0 ? <Text style={styles.body}>Nothing here yet.</Text> : (
                  <DataTable
                    columns={[
                      { label: "Name", width: 180 },
                      { label: "Status", width: 90 },
                      { label: tab === "groups" ? "Campaign" : "Ad group", width: 150 },
                      { label: "Actions", width: 100 },
                      { label: "Impressions", width: 100, right: true },
                      { label: "Clicks", width: 70, right: true },
                      { label: "Spend", width: 90, right: true },
                      { label: "CTR", width: 80, right: true },
                    ]}
                    rows={(entities.data ?? []).map((e) => {
                      const parent = byId.get(e.campaign_id);
                      const editable = !!parent && canEditHere(parent) && (tab === "groups" ? e.status !== "archived" : adEditable(e));
                      const off = e.metrics_unavailable;
                      return {
                        key: e.id,
                        cells: [
                          <Text key="n" style={styles.cellStrong} numberOfLines={2}>{e.name}</Text>,
                          <Chip key="s" status={e.status} />,
                          <Text key="p" style={styles.cell} numberOfLines={2}>{e.parent_name}</Text>,
                          editable && parent ? (
                            <TextLink key="a" label="Edit" onPress={() => (tab === "groups" ? setGroup({ campaign: parent, editing: e }) : setAd({ campaign: parent, editing: e }))} />
                          ) : (
                            <Text key="a" style={styles.cell}>—</Text>
                          ),
                          off ? "—" : count(e.impressions),
                          off ? "—" : count(e.clicks),
                          off ? "—" : money(e.spend, currency),
                          off ? "—" : percent(e.ctr),
                        ],
                      };
                    })}
                  />
                )}
              </>
            )
          ) : null}

          <Text style={styles.small}>Activate, pause, launch, safety limits and funding are on zaviagent.com.</Text>
          <TextLink label="Manage on zaviagent.com" onPress={() => void openCampaignWeb()} />
        </>
      )}

      <OptionSheet
        open={picking}
        title="Campaign"
        options={[{ value: "all", label: "All campaigns" }, ...campaigns.map((c) => ({ value: c.id, label: shortName(c.name, prefix) }))]}
        value={filter}
        onPick={setFilter}
        onClose={() => setPicking(false)}
      />

      <CampaignEditor
        open={!!editor}
        existingId={editor?.id ?? null}
        draft={dashboard.draft}
        prefix={prefix}
        currency={currency}
        version={version}
        onClose={() => setEditor(null)}
        onSaved={(campaign) => {
          if (!editor?.id && campaign?.status === "paused") setCreated({ tenant, campaign });
          setEditor(null);
          changed("Campaign saved paused. Add an ad group and ad before reviewing launch on zaviagent.com.");
        }}
      />
      <GroupSheet
        open={!!group}
        campaign={group?.campaign}
        editing={group?.editing ?? null}
        draft={dashboard.draft}
        currency={currency}
        onClose={() => setGroup(null)}
        onSaved={(receipt) => {
          if (group && !group.editing && receipt.id) setPending({ tenant, campaignId: group.campaign.id, kind: "groups", id: receipt.id });
          setGroup(null);
          setCreated((previous) => previous ? { ...previous, setupStarted: true } : null);
          changed("Ad group saved paused. Choose Ads, then Add ad. If the group is not listed yet, refresh before continuing.");
        }}
      />
      <AdSheet
        open={!!ad}
        campaign={ad?.campaign}
        groups={groupsForAd.data ?? []}
        editing={ad?.editing ?? null}
        draft={dashboard.draft}
        onClose={() => setAd(null)}
        onSaved={(receipt) => {
          if (ad && !ad.editing && receipt.id) setPending({ tenant, campaignId: ad.campaign.id, kind: "ads", id: receipt.id });
          setAd(null);
          changed("Ad saved paused.");
        }}
      />
      <ReportSheet campaign={report} prefix={prefix} currency={currency} onClose={() => setReport(null)} />
    </View>
  );
}

function Chip({ status }: { status: string | null }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const tone = statusTone(status);
  const bg = tone === "green" ? colors.status.greenBg : tone === "amber" ? colors.status.amberBg : colors.soft;
  const fg = tone === "green" ? colors.status.greenText : tone === "amber" ? colors.status.amberText : colors.textSecondary;
  return (
    <View style={[styles.chip, { backgroundColor: bg }]}>
      <Text style={[styles.chipText, { color: fg }]}>{statusLabel(status)}</Text>
    </View>
  );
}

const metricLine = (m: Metrics, currency: string | null) =>
  `${money(m.spend, currency)} spent · ${count(m.impressions)} impr. · ${count(m.clicks)} clicks · ${percent(m.ctr)} CTR`;

function Actions({ onReport, onEdit, webOnly }: { onReport: () => void; onEdit: () => void; webOnly: boolean }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.actions}>
      <TextLink label="Report" onPress={onReport} />
      <TextLink label={webOnly ? "Edit on web" : "Edit"} onPress={onEdit} />
    </View>
  );
}

function TableSkeleton() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.skel} accessibilityRole="progressbar" accessibilityLabel="Loading">
      <View style={styles.skelHead}>
        <SkeletonBlock width={60} height={10} />
        <SkeletonBlock width={50} height={10} />
        <SkeletonBlock width={70} height={10} />
        <SkeletonBlock width={40} height={10} />
      </View>
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.skelRow}>
          <SkeletonBlock width={96} height={14} />
          <SkeletonBlock width={54} height={20} radius={10} />
          <SkeletonBlock width={64} height={14} />
          <SkeletonBlock width={36} height={14} />
        </View>
      ))}
    </View>
  );
}

type Col = { label: string; width: number; right?: boolean };

function DataTable({ columns, rows, footer }: { columns: Col[]; rows: Array<{ key: string; cells: Array<ReactNode> }>; footer?: string[] }) {
  const styles = useStyles(makeStyles);
  const line = (cells: ReactNode[], key: string, style?: object) => (
    <View key={key} style={[styles.tr, styles.rowDivider, style]}>
      {columns.map((c, i) => (
        <View key={c.label} style={[styles.td, i === 0 && styles.tdFirst, { width: c.width }]}>
          {typeof cells[i] === "string" ? <Text style={[styles.cell, c.right && styles.right]}>{cells[i] as string}</Text> : cells[i]}
        </View>
      ))}
    </View>
  );
  return (
    <View style={styles.tableCard}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false} style={styles.bleed} contentContainerStyle={styles.bleedInner}>
        <View style={styles.grid}>
          <View style={[styles.tr, styles.th]}>
            {columns.map((c, i) => (
              <View key={c.label} style={[styles.td, i === 0 && styles.tdFirst, { width: c.width }]}>
                <Text style={[styles.thText, c.right && styles.right]}>{c.label}</Text>
              </View>
            ))}
          </View>
          {rows.map((r) => line(r.cells, r.key))}
          {footer ? line(footer, "total", styles.tf) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function ReportSheet({ campaign, prefix, currency, onClose }: { campaign: Campaign | null; prefix: string | undefined; currency: string | null; onClose: () => void }) {
  const styles = useStyles(makeStyles);
  const [breakdown, setBreakdown] = useState<"daily" | "country">("daily");
  const [days, setDays] = useState(7);
  const q = useReport(campaign?.id ?? null, breakdown, days);
  return (
    <AppBottomSheet open={!!campaign} onClose={onClose} title={campaign ? `Report: ${shortName(campaign.name, prefix)}` : "Report"}>
      <View style={styles.sheet}>
        <View style={styles.buttons}>
          {(["daily", "country"] as const).map((b) => (
            <Pressable key={b} style={[styles.tab, breakdown === b && styles.tabOn]} onPress={() => setBreakdown(b)} accessibilityRole="button">
              <Text style={[styles.tabText, breakdown === b && styles.tabTextOn]}>{b === "daily" ? "By day" : "By country"}</Text>
            </Pressable>
          ))}
          {[7, 14, 30].map((d) => (
            <Pressable key={d} style={[styles.tab, days === d && styles.tabOn]} onPress={() => setDays(d)} accessibilityRole="button">
              <Text style={[styles.tabText, days === d && styles.tabTextOn]}>{`${d}d`}</Text>
            </Pressable>
          ))}
        </View>
        {q.isLoading ? <Text style={styles.body}>Reading performance…</Text> : null}
        {q.isError ? <Text style={styles.error}>{q.error instanceof Error ? q.error.message : "Performance could not be read."}</Text> : null}
        {q.data ? (
          <>
            <Text style={styles.small}>{`${q.data.period.from} to ${q.data.period.to} (${q.data.period.timezone})`}</Text>
            {q.data.rows.length === 0 ? <Text style={styles.body}>No performance in this period.</Text> : null}
            {q.data.rows.map((r) => (
              <View key={r.label} style={styles.reportRow}>
                <Text style={styles.cardTitle}>{r.label}</Text>
                <Text style={styles.small}>{metricLine(r, currency)}</Text>
              </View>
            ))}
          </>
        ) : null}
        <Text style={styles.small}>Spend reporting can be delayed.</Text>
      </View>
    </AppBottomSheet>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { gap: space.md, marginTop: space.md },
    sheet: { gap: space.md },
    body: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.textSecondary },
    small: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    error: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 19, color: colors.red },
    ok: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 19, color: colors.status.greenText },
    notice: { padding: space.md, borderRadius: radius.md, backgroundColor: colors.soft, fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.textSecondary },
    tiles: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
    tile: { flexGrow: 1, flexBasis: "30%", minWidth: 100, padding: space.md, gap: 2, borderWidth: 1, borderColor: colors.line, borderRadius: 14, backgroundColor: colors.panel },
    tileLabel: { fontFamily: font.family.medium, fontSize: 12, color: colors.muted },
    tileValue: { fontFamily: font.family.semi, fontSize: 18, color: colors.ink },
    card: { padding: space.lg, gap: space.sm, borderWidth: 1, borderColor: colors.line, borderRadius: 16, backgroundColor: colors.panel },
    cardTitle: { flex: 1, fontFamily: font.family.semi, fontSize: 14, lineHeight: 19, color: colors.ink },
    head: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
    chip: { alignSelf: "flex-start", paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill },
    chipText: { fontFamily: font.family.semi, fontSize: 11 },
    buttons: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.sm },
    tabRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
    tabs: { flexDirection: "row", gap: space.lg },
    utab: { paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: "transparent" },
    utabOn: { borderBottomColor: colors.ink },
    utabText: { fontFamily: font.family.medium, fontSize: 14, color: colors.muted },
    utabTextOn: { color: colors.ink },
    newBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, height: 34, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
    newText: { fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
    row: { flexDirection: "row", justifyContent: "flex-end" },
    tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line },
    tabOn: { borderColor: colors.ink, backgroundColor: colors.ink },
    tabText: { fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
    tabTextOn: { color: colors.onInk },
    filter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 40, justifyContent: "center", paddingHorizontal: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    filterText: { fontFamily: font.family.medium, fontSize: 14, color: colors.ink },
    balance: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
    balanceText: { flex: 1, minWidth: 0, gap: 2 },
    tableCard: {},
    skel: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, overflow: "hidden" },
    skelHead: { flexDirection: "row", alignItems: "center", gap: space.lg, paddingHorizontal: space.md, paddingVertical: 12, backgroundColor: colors.soft },
    skelRow: { flexDirection: "row", alignItems: "center", gap: space.lg, paddingHorizontal: space.md, paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    bleed: { marginHorizontal: -space.lg },
    bleedInner: { paddingHorizontal: space.lg },
    grid: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, overflow: "hidden", alignSelf: "flex-start" },
    tr: { flexDirection: "row" },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    th: { backgroundColor: colors.soft },
    tf: { backgroundColor: colors.soft },
    td: { paddingHorizontal: 6, paddingVertical: 9, gap: 3, justifyContent: "center" },
    tdFirst: { paddingLeft: 10 },
    thText: { fontFamily: font.family.semi, fontSize: 12, color: colors.ink },
    cell: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.ink },
    cellStrong: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 19, color: colors.ink },
    right: { textAlign: "right" },
    actions: { flexDirection: "row", gap: space.md },
    reportRow: { gap: 2, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  });
