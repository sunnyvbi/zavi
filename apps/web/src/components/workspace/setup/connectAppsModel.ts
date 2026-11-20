import type { ComposioToolkit } from "@/app/connectors/ComposioApps";
import type { ConnectorListRow } from "@/app/connectors/connectStrategies";
import { CONNECT_APPS_ALSO_CONNECTED, CONNECT_APPS_GROUPS, CONNECT_APPS_STARTERS } from "./connectAppsCopy";
import { filterConnectors, isConnected, type SetupConnector } from "./setupConnectors";

export type SetupApp = SetupConnector & { logo?: string };
export type SetupAppGroup = { title: string; apps: SetupApp[]; more: SetupApp[] };
export const CONNECT_CATALOG_PAGE = 50;

export function connectAppChoices(query: string, rows: readonly ConnectorListRow[], catalog: readonly ComposioToolkit[], limit: number) {
  const all = filterConnectors("All", "").concat(filterConnectors("Messaging", ""));
  const term = query.trim().toLowerCase();
  const native = term ? filterConnectors("All", term) : [
    ...CONNECT_APPS_STARTERS.flatMap((slug) => all.filter((app) => app.slug === slug)),
    ...all.filter((app) => !CONNECT_APPS_STARTERS.some((slug) => slug === app.slug) && isConnected(rows, app.slug)),
  ];
  const known = new Set(native.map((app) => app.slug));
  const matches: SetupApp[] = catalog.filter((app) =>
    (term.length >= 2 && `${app.name} ${app.slug}`.toLowerCase().includes(term)) ||
    (!term && isConnected(rows, `composio.${app.slug}`)),
  ).filter((app) => !all.some((item) => item.slug === app.slug) && !known.has(`composio.${app.slug}`) && !native.some((item) => isConnected([{ slug: `composio.${app.slug}` }], item.slug)))
    .map((app) => ({ slug: `composio.${app.slug}`, name: app.name, logo: app.logo, category: "Product & data", what: "From the app catalog", via: "launch" }));
  const catalogLogo = (slug: string) => {
    const base = slug.replace(/^composio\./, "");
    return catalog.find((t) => t.slug === base || t.slug === base.replace(/_ads$/, ""))?.logo;
  };
  const withLogo = native.map((app): SetupApp => ({ ...app, logo: catalogLogo(app.slug) }));
  const apps = [...withLogo, ...matches.slice(0, limit)];
  const groups: SetupAppGroup[] | null = term ? null : [
    ...CONNECT_APPS_GROUPS.map((group) => {
      const pick = (slugs: readonly string[]) => slugs.flatMap((slug) => apps.filter((app) => app.slug === slug));
      const extra = pick(group.more);
      const linked = (app: SetupApp) => isConnected(rows, app.slug);
      return { title: group.title, apps: [...pick(group.slugs), ...extra.filter(linked)], more: extra.filter((app) => !linked(app)) };
    }),
    { title: CONNECT_APPS_ALSO_CONNECTED, apps: apps.filter((app) => !CONNECT_APPS_STARTERS.some((slug) => slug === app.slug)), more: [] },
  ].filter((group) => group.apps.length > 0);
  return { apps, groups, hasMore: matches.length > limit };
}
