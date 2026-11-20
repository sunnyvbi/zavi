import type { ArchetypeKit } from "@/services/agents/archetype-kits/types";

export const SAAS_DASHBOARD_KIT: ArchetypeKit = {
  slug: "saas-dashboard",
  title: "SaaS dashboard app",
  summary:
    "An authenticated SaaS web app: sign-in, a metrics overview home, a primary " +
    "resource the user manages (list + detail + create/edit), and account/settings/" +
    "billing. Gives the build a real app shell (sidebar nav, top bar, auth guard) " +
    "instead of a blank single page.",
  keywords: [
    "saas",
    "dashboard",
    "admin panel",
    "internal tool",
    "analytics",
    "metrics",
    "management",
    "tracker",
    "monitor",
    "console",
    "b2b",
    "workspace",
    "reporting",
    "kpi",
    "operations",
    "ops tool",
    "portal",
    "customer portal",
    "client portal",
  ],
  pages: [
    {
      route: "/login",
      name: "Sign in",
      purpose: "Email/password (and optional OAuth) auth entry point.",
      components: ["AuthForm", "OAuthButtons"],
    },
    {
      route: "/",
      name: "Overview",
      purpose: "At-a-glance metrics home: KPI cards + a primary trend chart + recent activity.",
      components: ["AppShell", "KpiCard", "TrendChart", "ActivityFeed"],
    },
    {
      route: "/[resource]",
      name: "Resource list",
      purpose: "Sortable/filterable table of the app's primary resource.",
      components: ["AppShell", "DataTable", "FilterBar", "CreateButton", "EmptyState"],
    },
    {
      route: "/[resource]/[id]",
      name: "Resource detail",
      purpose: "Single resource detail + inline edit + related items.",
      components: ["AppShell", "DetailHeader", "EditableFields", "RelatedList"],
    },
    {
      route: "/settings",
      name: "Settings & billing",
      purpose: "Profile, team members, plan/billing, and danger-zone actions.",
      components: ["AppShell", "SettingsTabs", "PlanCard", "MemberTable"],
    },
  ],
  components: [
    { id: "AppShell", description: "Sidebar nav + top bar + auth guard; wraps every signed-in page." },
    { id: "AuthForm", description: "Email/password sign-in with disabled-until-valid submit." },
    { id: "OAuthButtons", description: "Continue-with-Google/GitHub buttons (optional)." },
    { id: "KpiCard", description: "Single metric with value, delta vs prior period, sparkline." },
    { id: "TrendChart", description: "Primary time-series chart with range toggle." },
    { id: "ActivityFeed", description: "Recent events list with actor + timestamp." },
    { id: "DataTable", description: "Sortable, paginated table with row actions + bulk select." },
    { id: "FilterBar", description: "Search + status/date facet filters above the table." },
    { id: "CreateButton", description: "Primary create-new-resource action opening a form modal/page." },
    { id: "EmptyState", description: "Zero-rows state with a create CTA." },
    { id: "DetailHeader", description: "Resource title, status, and primary actions." },
    { id: "EditableFields", description: "Inline-editable key/value fields with optimistic save." },
    { id: "RelatedList", description: "List of items related to the current resource." },
    { id: "SettingsTabs", description: "Tabbed settings: profile / team / billing." },
    { id: "PlanCard", description: "Current plan + usage + upgrade CTA." },
    { id: "MemberTable", description: "Team members with role + invite/remove." },
  ],
  schema: [
    {
      name: "profiles",
      purpose: "Authenticated user, tied to the auth provider.",
      columns: {
        id: "uuid pk → auth user",
        email: "text",
        full_name: "text",
        role: "enum owner/admin/member",
        created_at: "timestamptz",
      },
    },
    {
      name: "resources",
      purpose: "The app's primary managed entity (renamed to the real domain noun at build).",
      columns: {
        id: "uuid pk",
        owner_id: "uuid → profiles",
        name: "text",
        status: "enum active/archived",
        metadata: "jsonb",
        created_at: "timestamptz",
        updated_at: "timestamptz",
      },
    },
    {
      name: "events",
      purpose: "Activity-feed entries powering the overview + audit.",
      columns: {
        id: "uuid pk",
        actor_id: "uuid → profiles",
        resource_id: "uuid → resources",
        kind: "text",
        created_at: "timestamptz",
      },
    },
  ],
  seedData: [
    "A demo user + a few resources across statuses so the table and detail pages are non-empty.",
    "30-60 days of synthetic metric points so the KPI cards show non-zero deltas and the chart renders a real curve.",
    "A handful of activity events so the overview feed and recent-activity panel populate.",
  ],
  responsive: [
    "AppShell: persistent sidebar on desktop collapses to a hamburger drawer under md.",
    "Overview: KPI cards 1-col mobile → 2 tablet → 4 desktop; chart full-width below the cards on mobile.",
    "DataTable: horizontal scroll on small screens, or column-priority collapse to stacked cards.",
  ],
  visualDirection: {
    mood: "clean, confident, data-first — calm neutrals with one accent for primary actions.",
    layout: "left sidebar nav + content area; cards over a subtle surface background.",
    accents: [
      "Consistent card radius + soft shadow for surface elevation.",
      "Numbers are the visual hierarchy peak on the overview.",
      "Single accent color reserved for primary CTAs and active nav.",
    ],
  },
};
