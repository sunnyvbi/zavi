
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCAN_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const OWNED = ["actions/", "metrics/"];

const LEGACY_ALLOWLIST = new Set<string>([
  "build/LookPicker.tsx:LookTile",
  "build/PlanReviewCard.tsx:PlanReviewCard",
  "build/SiteDesignCard.tsx:SiteDesignCard",
  "build/TemplateGallery.tsx:TemplateCard",
  "chat/RuleSuggestionCard.tsx:RuleSuggestionCard",
  "receipts/NextActions.tsx:NextActionsCard",
  "settings/RulesCard.tsx:RulesCard",
  "ugc/InboxDrawer.tsx:InboxCard",
  "ugc/PublishCard.tsx:PublishCard",
  "website/AppUsageCard.tsx:AppUsageCard",
  "website/WebsiteBuildProgress.tsx:WaitingCard",
  "AutopilotGoalsPanel.tsx:GoalCard",
  "CalendarTab.tsx:PostCard",
  "ChatThread.tsx:DocumentCard",
  "CompetitorTab.tsx:SummaryCard",
  "EnvelopeCard.tsx:EnvelopeCard",
  "GettingStartedCard.tsx:BrainSetupCard",
  "GettingStartedCard.tsx:GettingStartedCard",
  "InlineActionCard.tsx:InlineActionCard",
  "ProposalCard.tsx:ProposalCard",
  "settings/UpgradePlanView.tsx:PlanCard",
  "settings/database/DatabaseCard.tsx:DatabaseCard",
  "email/EmailConnectTiles.tsx:ConnectTiles",
  "email/EmailConnectTiles.tsx:EmailConnectTiles",
  "email/EmailContactsSection.tsx:ListCard",
  "email/SentEmailsBlock.tsx:PlanTile",
  "SettingsTab.tsx:GithubConnectedCard",
  "SettingsTab.tsx:SocialConnectorTile",
  "SharedPageCard.tsx:SharedPageCard",
  "Skeleton.tsx:SkeletonConnectorTile",
  "Skeleton.tsx:SkeletonListCard",
  "Skeleton.tsx:SkeletonRichCard",
  "SlackWorkspacesPanel.tsx:WorkspaceCard",
  "TeamRosterCard.tsx:MemberCard",
  "TeamRosterCard.tsx:TeamRosterCard",
  "UiBlockArtifact.tsx:Card",
  "UiBlockArtifact.tsx:ChartCard",
  "UiBlockArtifact.tsx:HtmlCard",
  "UiBlockArtifact.tsx:KpiCard",
  "UiBlockArtifact.tsx:PostsCard",
  "UiBlockArtifact.tsx:TableCard",
  "agent/ChannelKpiCards.tsx:ChannelKpiCards",
  "agent/ConstraintCard.tsx:ConstraintCard",
  "agent/ContentDesignDashboard.tsx:AskCard",
  "agent/DisputeDetailTab.tsx:GridCard",
  "agent/DisputeDetailTab.tsx:RichCard",
  "agent/DisputeDetailTab.tsx:SubmitForReviewCard",
  "agent/EngineerDashboard.tsx:WarrantyCard",
  "agent/FundraisingDashboard.tsx:InvestorCard",
  "agent/GeoDashboard.tsx:ScoreCard",
  "agent/PerfMarketerTrendChart.tsx:MetricTile",
  "agent/PmHybridDashboard.tsx:StandupCard",
  "agent/QaDashboard.tsx:Card",
  "agent/QaDashboard.tsx:CounterTile",
  "agent/SeoGeoDashboard.tsx:TrendTile",
  "agent/dashboard-ui.tsx:AttentionCard",
  "agent/reddit/OverviewGlance.tsx:GlanceCard",
  "agent/reddit/OverviewTab.tsx:KpiCard",
  "agent/reddit/OpportunityCard.tsx:OpportunityCard",
  "agent/reddit/ui.tsx:SectionCard",
  "build/BuildModePane.tsx:PreviewCard",
  "chat/AgentSetupCard.tsx:AgentSetupCard",
  "chat/BuildConfirmCard.tsx:BuildConfirmCard",
  "chat/ConnectorRequestCard.tsx:ConnectorRequestCard",
  "chat/ClarifyingQuestionsCard.tsx:ClarifyingQuestionsCard",
  "chat/PausedOutOfCreditsCard.tsx:PausedOutOfCreditsCard",
  "geo/cards.tsx:ChecklistCard",
  "geo/cards.tsx:CrawlerHitsCard",
  "geo/cards.tsx:KpiCard",
  "geo/cards.tsx:ProgressCard",
  "geo/cards.tsx:ReadinessCard",
  "geo/cards.tsx:SiteFilesCard",
  "geo/cards.tsx:SourceMixCard",
  "geo/cards.tsx:TopSourcesCard",
  "geo/cards.tsx:VisibilityCard",
  "growth/GrowthCompanyCard.tsx:GrowthCompanyCard",
  "home/ActivityDigestCard.tsx:ActivityDigestCard",
  "home/AgentInventoryCard.tsx:AgentInventoryCard",
  "home/BuilderChatCard.tsx:BuilderChatCard",
  "home/CompanyBriefCard.tsx:Card",
  "home/CompanyBriefCard.tsx:CompanyBriefCard",
  "home/LiveAppCard.tsx:LiveAppCard",
  "home/RefinePipelineCard.tsx:RefinePipelineCard",
  "home/SpendCard.tsx:SpendCard",
  "home/StackInventoryCard.tsx:StackInventoryCard",
  "home/SuggestedNextCard.tsx:SuggestedNextCard",
  "home/calm/GoalsSection.tsx:GoalCard",
  "layout/ChannelsPanel.tsx:DecisionCard",
  "layout/FindingHandoff.tsx:Card",
  "legacy/ExplorerTree.tsx:AgentInfoCard",
  "runs/RunDetailIsland.tsx:LedgerRowCard",
  "runs/RunsIsland.tsx:RunCard",
  "settings/ConnectedApps.tsx:ConnectedAppTiles",
  "settings/ConnectorTile.tsx:ConnectorTile",
  "settings/EmailAllowlistPanel.tsx:Card",
  "settings/EmailTile.tsx:EmailTile",
  "settings/McpClientsPanel.tsx:ConnectCard",
  "settings/McpClientsPanel.tsx:TokensCard",
  "settings/PushPrefsCard.tsx:PushPrefsCard",
  "settings/UpgradePlanView.tsx:PlanCard",
  "settings/ReconnectTile.tsx:ReconnectTile",
  "settings/TeamsTile.tsx:TeamsTile",
  "website/WebsiteConsole.tsx:BuiltinUrlCard",
  "website/WebsiteConsole.tsx:CustomDomainsCard",
  "NextTiles.tsx:NextTiles",
  "analysis/AnalysisReport.tsx:KpiTile",
  "build/BuildFilesPane.tsx:CollectionCard",
  "build/BuildFilesPane.tsx:PhotoCard",
  "chat/CustomAgentDraftCard.tsx:CustomAgentDraftCard",
  "chat/CustomAgentDraftCard.tsx:DraftCard",
  "growth/GrowthConnections.tsx:ConnectorTile",
  "growth/HeadOfGrowth.tsx:HeadOfGrowthCard",
  "home/ExportToGithubButton.tsx:SuccessCard",
  "website/AppInitialTile.tsx:AppInitialTile",
]);

const CARD_NAME = /(Card|Cards|Tile|Tiles)$/;
const DECL = /\b(?:function|const|let|class)\s+([A-Z][A-Za-z0-9]*)\b/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function cardDeclarations(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(SCAN_ROOT)) {
    const rel = relative(SCAN_ROOT, file).split("\\").join("/");
    if (OWNED.some((d) => rel.startsWith(d))) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(DECL)) {
      if (CARD_NAME.test(m[1])) found.push(`${rel}:${m[1]}`);
    }
  }
  return [...new Set(found)].sort();
}

describe("no new action cards or metric tiles outside actions/ and metrics/", () => {
  const found = cardDeclarations();

  it("finds the legacy declarations (the scan is not blind)", () => {
    expect(found).toContain("agent/reddit/OverviewTab.tsx:KpiCard");
    expect(found).toContain("agent/ConstraintCard.tsx:ConstraintCard");
    expect(found).toContain("layout/ChannelsPanel.tsx:DecisionCard");
  });

  it("the two panels PR 2 moved define no card or tile of their own", () => {
    expect(found.filter((f) => f.startsWith("agent/google-ads/") || f.startsWith("agent/XAgentDashboard.tsx"))).toEqual([]);
  });

  it("defines no card or tile outside the legacy allowlist", () => {
    const added = found.filter((f) => !LEGACY_ALLOWLIST.has(f));
    expect(added, "Build it with components/workspace/actions (ACTION_BODY) or components/workspace/metrics (MetricCard) instead").toEqual([]);
  });

  it("keeps the allowlist honest: every entry still exists", () => {
    const stale = [...LEGACY_ALLOWLIST].filter((f) => !found.includes(f));
    expect(stale, "Remove deleted legacy components from LEGACY_ALLOWLIST").toEqual([]);
  });
});
