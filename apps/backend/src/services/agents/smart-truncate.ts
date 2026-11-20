
export const TRUNCATED_RESULT_INSTRUCTION = [
  "## Truncated tool results",
  'If a tool result contains `"_truncated": true`, the data was NOT lost — it was capped to fit the model budget and the full result is persisted server-side. The result is still valid JSON: the items you DID receive are complete and usable.',
  "Act on the `_hint` field: narrow the query (add filters, restrict scope, query a specific record) or paginate. Do NOT re-run the identical query expecting a different result, and do NOT tell the user the data is unavailable — use `_returned`/`_total` to report scope honestly (e.g. \"showing first N of M\").",
  "If a `_dropped_identity` array is present, those are the **identity-only projections** (id, name, slug, etc.) of rows that fell past the page cap — they DO exist in the source; the bodies were just dropped to fit the budget. Use these to answer existence questions (\"is X in the list?\") without re-querying: scan `_dropped_identity` for the name/id, then if present, paginate or filter by it for the full row. **NEVER claim an entity is deleted/archived/missing/renamed when the supporting list carried `_truncated: true`** — absence from the page is not proof of absence from the source.",
  "",
  "### Counting questions (how many / totals / tallies)",
  "NEVER answer a count by fetching a list and counting the rows — pages are capped, so row-counting silently undercounts. Follow this decision order:",
  '1. If a dedicated count tool exists for that source (e.g. `jira__count`), call THAT — it returns an exact number in one call without fetching items. Always prefer it for pure "how many" questions.',
  '2. Otherwise, if the result carries an exact total (`total`, `total_count`, `_total`, `agent_hints.total`, or a `count` the tool labels exact), report THAT number exactly — it is correct regardless of how many item bodies came back.',
  "3. Otherwise the source is paginated WITHOUT a total (true for many tools — Slack, Stripe, Linear, web search, etc.). Do NOT claim you cannot count, and do NOT state the page size as if it were the total. Report it honestly as a floor: \"at least N so far (more exist — the source paginates and does not expose an exact total)\" and offer to paginate to an exact figure or narrow the query. `_truncated:true` or a cursor/`nextPageToken`/`isLast:false`/`has_more:true` means more exist beyond what you see.",
  "Be honest about scope every time: distinguish an exact total from a floor. Never present a capped page count as the answer.",
  "",
  "### Aggregates (ROAS / CAC / spend / revenue / conversion totals)",
  'When a result carries a `totals` block, an ACCOUNT-LEVEL metric MUST come from `totals` — it was computed over EVERY row before the result was capped. NEVER derive an account-level metric by summing the visible rows of a `_truncated` result: you would be reporting a fraction of the account as the whole of it. Read `totals.scope` and `totals.complete`, and say the scope out loud in your answer ("1.35x across 21 campaigns"). `complete:false` means rows were missing BEFORE truncation (an unfollowed API cursor or row cap) — report those figures as a floor and say so.',
  'If a result is `_truncated` and carries NO `totals` block, you cannot state an account-level metric from it. Say what you can see and its scope ("the 2 campaigns shown spent $166"), never a total.',
].join("\n");

export const SANDBOX_EXEC_TRUNCATION_INSTRUCTION = [
  "## Truncated sandbox command output",
  'The sandbox exec tools (`run_bash`, `run_tests`, `git_diff`) cap very large stdout/stderr. When such a result carries `"_truncated": true`, the MIDDLE of the output was capped to fit the model budget — it was NOT lost. The result is still valid JSON: the head and tail you received are complete and accurate, and the `truncated` field reports what was elided.',
  "Act, don't blindly re-run: if an `_errors` array is present, those are the diagnostics already extracted FOR you (compiler errors like `error TS2345`, failing test assertions, lint errors, stack frames) — read them and fix the actual failure. To see omitted middle content, rerun a NARROWER command — for `run_bash`/`run_tests` pipe through `grep`/`head`/`tail` or target a specific path; for `git_diff` the result lists each unshown file under `omitted` (path + size), so call `git_diff({path: \"path/to/file\"})` to fetch that one file's COMPLETE diff (a single-file fetch gets a larger budget). Do NOT re-run the identical command expecting the full output; it will just truncate again and waste an iteration.",
  "NEVER claim a symbol, file, import, type, or error is absent just because a `_truncated` exec result didn't show it — the elided middle may contain it. Grep for it (`run_bash` with `grep -rn`) before concluding it isn't there.",
].join("\n");

function bytes(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

const IDENTITY_KEYS: readonly string[] = [
  "id",
  "_id",
  "external_id",
  "external_key",
  "campaign_id",
  "name",
  "campaign_name",
  "slug",
  "title",
  "key",
] as const;

const PER_ROW_IDENTITY_CAP = 256;

function projectIdentity(item: unknown): Record<string, unknown> | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const src = item as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of IDENTITY_KEYS) {
    const v = src[k];
    if (v === null || v === undefined) continue;
    if (typeof v === "string") {
      out[k] = v.length > PER_ROW_IDENTITY_CAP
        ? v.slice(0, PER_ROW_IDENTITY_CAP) + "…"
        : v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

const ELIDED_MARKER = "[elided]";

const STRING_PREVIEW_CHARS = 200;

const ELIDED_NAMES_BUDGET_BYTES = 256;

function objectTruncationEnvelope(
  keptFields: number,
  totalFields: number,
  elidedKeys: string[],
): Record<string, unknown> {
  const names: string[] = [];
  let used = 0;
  for (const k of elidedKeys) {
    const cost = bytes(JSON.stringify(k)) + 1;
    if (used + cost > ELIDED_NAMES_BUDGET_BYTES) break;
    used += cost;
    names.push(k);
  }
  const unnamed = elidedKeys.length - names.length;
  const elidedCount = elidedKeys.length;
  return {
    _truncated: true,
    _returned_fields: keptFields,
    _total_fields: totalFields,
    ...(names.length > 0 ? { _elided_fields: names } : {}),
    ...(unnamed > 0 ? { _elided_fields_unnamed: unnamed } : {}),
    _hint:
      `Result capped to fit the model budget. ${keptFields} of ${totalFields} nested ` +
      `field(s) shown in full` +
      (elidedCount > 0
        ? `; ${elidedCount} elided for size (see _elided_fields). An elided field is ` +
          `NOT empty — do not report its contents as absent. `
        : `. `) +
      `The full result is NOT lost, it is persisted server-side.`,
  };
}

function truncationEnvelope(
  returned: number,
  total: number | undefined,
): Record<string, unknown> {
  const known = typeof total === "number" && total >= returned;
  return {
    _truncated: true,
    _returned: returned,
    ...(known ? { _total: total } : {}),
    _hint: known
      ? `Result capped to fit the model budget. ${returned} of ${total} items shown. ` +
        `Narrow the query (add filters / restrict scope) or paginate to see the rest — the full result is NOT lost, it is persisted server-side.`
      : `Result capped to fit the model budget. First ${returned} items shown; more exist. ` +
        `Narrow the query (add filters / restrict scope) or paginate — the full result is NOT lost, it is persisted server-side.`,
  };
}

const ITEM_KEYS: readonly string[] = [
  "issues",
  "messages",
  "items",
  "values",
  "results",
  "data",
  "rows",
  "campaigns",
  "ad_sets",
  "adsets",
  "ads",
  "ad_groups",
  "users",
  "listings",
  "bookings",
  "trips",
  "events",
  "nodes",
  "edges",
  "records",
  "entries",
  "objects",
  "briefs",
  "collections",
  "tables",
  "pixels",
  "matches",
];

function findItemArray(
  v: unknown,
): { items: unknown[]; total?: number; key: string | null } | null {
  if (Array.isArray(v)) return { items: v, key: null };
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const total = typeof o.total === "number" ? o.total : undefined;
    for (const k of ITEM_KEYS) {
      if (Array.isArray(o[k])) {
        return { items: o[k] as unknown[], total, key: k };
      }
    }
  }
  return null;
}

export const SDK_PERSISTED_OUTPUT_RE = /<persisted-output>|Output too large \(/;

const DEFAULT_TOOL_RESULT_CAP_BYTES = 16 * 1024;
const PEER_CONTENT_READ_CAP_BYTES = 64 * 1024;

const CATALOG_INDEX_CAP_BYTES = 32 * 1024;

const TIKTOK_SCRAPE_CAP_BYTES = 24 * 1024;

const INSTAGRAM_SCRAPE_CAP_BYTES = 24 * 1024;

const ANALYST_BRIEF_CAP_BYTES = 32 * 1024;

const SEO_AUDIT_CAP_BYTES = 32 * 1024;

const WEB_SEARCH_CAP_BYTES = 48 * 1024;

const PAGE_READ_CAP_BYTES = 32 * 1024;
const PAGE_READ_TOOLS: ReadonlySet<string> = new Set([
  "web_fetch:fetch",
  "apify:rag_web_browser",
]);

const REDDIT_READ_CAP_BYTES = 24 * 1024;
const REDDIT_READ_TOOLS: ReadonlySet<string> = new Set([
  "reddit:thread_read",
  "apify:scrape_reddit",
]);

const PINTEREST_READ_CAP_BYTES = 24 * 1024;
const PINTEREST_SEARCH_CAP_BYTES = 32 * 1024;
const PINTEREST_READ_TOOLS: ReadonlySet<string> = new Set([
  "pinterest:public_pins",
  "pinterest:site_readiness",
]);

const PIXEL_HEALTH_CAP_BYTES = 24 * 1024;

const AD_LIST_CAP_BYTES = 24 * 1024;
const AD_LIST_TOOLS: ReadonlySet<string> = new Set([
  "meta_ads:list_campaigns",
  "meta_ads:list_ad_sets",
  "meta_ads:list_ads",
  "google_ads:list_campaigns",
  "google_ads:list_ad_groups",
]);

export function toolResultCapBytes(
  server_id: string,
  tool_name: string,
): number {
  return resolveToolResultCapBytes(server_id, tool_name);
}

function resolveToolResultCapBytes(
  server_id: string,
  tool_name: string,
): number {
  if (server_id === "apify" && tool_name === "scrape_tiktok") {
    return TIKTOK_SCRAPE_CAP_BYTES;
  }
  if (server_id === "apify" && tool_name === "scrape_instagram") {
    return INSTAGRAM_SCRAPE_CAP_BYTES;
  }
  if (server_id === "praxis_corpus" && tool_name === "read_run_output") {
    return PEER_CONTENT_READ_CAP_BYTES;
  }
  if (server_id === "operator_db" && tool_name === "catalog") {
    return CATALOG_INDEX_CAP_BYTES;
  }
  if (server_id === "meta_ads" && tool_name === "analyst_brief") {
    return ANALYST_BRIEF_CAP_BYTES;
  }
  if (server_id === "meta_ads" && tool_name === "pixel_health") {
    return PIXEL_HEALTH_CAP_BYTES;
  }
  if (AD_LIST_TOOLS.has(`${server_id}:${tool_name}`)) {
    return AD_LIST_CAP_BYTES;
  }
  if (server_id === "growth" && tool_name === "seo_audit") {
    return SEO_AUDIT_CAP_BYTES;
  }
  if (server_id === "web_search" && tool_name === "search") {
    return WEB_SEARCH_CAP_BYTES;
  }
  if (PAGE_READ_TOOLS.has(`${server_id}:${tool_name}`)) {
    return PAGE_READ_CAP_BYTES;
  }
  if (REDDIT_READ_TOOLS.has(`${server_id}:${tool_name}`)) {
    return REDDIT_READ_CAP_BYTES;
  }
  if (server_id === "apify" && tool_name === "scrape_pinterest") {
    return PINTEREST_SEARCH_CAP_BYTES;
  }
  if (PINTEREST_READ_TOOLS.has(`${server_id}:${tool_name}`)) {
    return PINTEREST_READ_CAP_BYTES;
  }
  return DEFAULT_TOOL_RESULT_CAP_BYTES;
}

export function smartTruncateThenWrap(
  content: string,
  capBytes: number,
  wrap: (body: string) => string,
): string {
  const wrapped = wrap(content);
  if (bytes(wrapped) <= capBytes) return wrapped;

  let reserve = Math.max(0, bytes(wrap("x")) - 1);
  for (let pass = 0; pass < 3; pass++) {
    const room = Math.max(0, capBytes - reserve);
    const candidate = wrap(smartTruncateToolResult(content, room));
    if (bytes(candidate) <= capBytes) return candidate;
    reserve += bytes(candidate) - capBytes;
  }
  return smartTruncateToolResult(wrap(content), capBytes);
}

export function smartTruncateToolResult(
  content: string,
  capBytes: number,
): string {
  if (bytes(content) <= capBytes) return content;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const note = `\n\n[truncated: original was ${bytes(content)} bytes, capped to fit model budget. Full content persisted server-side in agent_runs.tool_calls.]`;
    const room = Math.max(0, capBytes - bytes(note));
    return content.slice(0, room) + note;
  }

  const found = findItemArray(parsed);

  if (found) {
    const env = truncationEnvelope(
      0,
      found.total ?? found.items.length,
    ) as Record<string, unknown>;
    const siblings: Record<string, unknown> = {};
    if (found.key !== null && parsed && typeof parsed === "object") {
      const SIBLING_BUDGET = 512;
      for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
        if (k === found.key) continue;
        const enc = JSON.stringify(val);
        if (enc !== undefined && bytes(enc) <= SIBLING_BUDGET) {
          siblings[k] = val;
        }
      }
    }
    const overhead = bytes(JSON.stringify({ ...siblings, ...env })) + 32;
    const rawItemBudget = capBytes - overhead;

    const IDENTITY_HARD_CAP = 1024;
    const reservedIdentity = Math.min(
      IDENTITY_HARD_CAP,
      Math.max(0, Math.floor(rawItemBudget * 0.3)),
    );
    const itemBudget = Math.max(0, rawItemBudget - reservedIdentity);

    const kept: unknown[] = [];
    if (itemBudget > 0) {
      let accumulatedBytes = 2;
      for (const item of found.items) {
        const itemBytes = bytes(JSON.stringify(item));
        const separator = kept.length > 0 ? 1 : 0;
        if (accumulatedBytes + separator + itemBytes > itemBudget) break;
        accumulatedBytes += separator + itemBytes;
        kept.push(item);
      }
    }
    const finalEnv = truncationEnvelope(
      kept.length,
      found.total ?? found.items.length,
    );

    const droppedItems = found.items.slice(kept.length);
    const identityRows: Record<string, unknown>[] = [];
    if (droppedItems.length > 0) {
      const baseOut =
        found.key === null
          ? { items: kept, ...siblings, ...finalEnv }
          : { [found.key]: kept, ...siblings, ...finalEnv };
      const usedSoFar = bytes(JSON.stringify(baseOut));
      const realResidual = Math.max(0, capBytes - usedSoFar);
      const identityBudget = Math.min(
        IDENTITY_HARD_CAP,
        Math.max(reservedIdentity, realResidual),
      );
      if (identityBudget > 0) {
        for (const item of droppedItems) {
          const proj = projectIdentity(item);
          if (!proj) continue;
          const trial = JSON.stringify({
            _dropped_identity: [...identityRows, proj],
          });
          if (bytes(trial) > identityBudget) break;
          identityRows.push(proj);
        }
      }
    }
    const composeOut = (idRows: Record<string, unknown>[]): Record<string, unknown> => {
      const di = idRows.length > 0 ? { _dropped_identity: idRows } : {};
      return found.key === null
        ? { items: kept, ...siblings, ...finalEnv, ...di }
        : { [found.key]: kept, ...siblings, ...finalEnv, ...di };
    };
    let out = composeOut(identityRows);
    let s = JSON.stringify(out);
    while (bytes(s) > capBytes && identityRows.length > 0) {
      identityRows.pop();
      out = composeOut(identityRows);
      s = JSON.stringify(out);
    }

    if (bytes(s) > capBytes) {
      let netIds = [...identityRows];
      const composeNet = (idRows: Record<string, unknown>[]): Record<string, unknown> => ({
        ...truncationEnvelope(0, found.total ?? found.items.length),
        _note: "Result too large even after trimming; query a specific record or add filters. Exact total is in _total.",
        ...(idRows.length > 0 ? { _dropped_identity: idRows } : {}),
      });
      s = JSON.stringify(composeNet(netIds));
      while (bytes(s) > capBytes && netIds.length > 0) {
        netIds.pop();
        s = JSON.stringify(composeNet(netIds));
      }
    }
    return s;
  }

  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    const slim: Record<string, unknown> = {};
    const nested: { key: string; enc: string; size: number }[] = [];
    const longStrings: { key: string; full: string }[] = [];
    for (const [k, val] of Object.entries(o)) {
      if (val === null || ["string", "number", "boolean"].includes(typeof val)) {
        if (typeof val === "string" && val.length > STRING_PREVIEW_CHARS) {
          slim[k] = val.slice(0, STRING_PREVIEW_CHARS) + "…";
          longStrings.push({ key: k, full: val });
        } else {
          slim[k] = val;
        }
      } else {
        const enc = JSON.stringify(val);
        if (enc === undefined) {
          slim[k] = ELIDED_MARKER;
          continue;
        }
        nested.push({ key: k, enc, size: bytes(enc) });
      }
    }

    nested.sort((a, b) => a.size - b.size || a.key.localeCompare(b.key));

    const kept = new Set<string>();
    const partial = new Map<string, { items: unknown[]; total: number }>();
    const render = (keptKeys: Set<string>) => {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(slim)) body[k] = v;
      const elidedKeys: string[] = [];
      const partialFields: { field: string; returned: number; total: number }[] = [];
      for (const n of nested) {
        const part = partial.get(n.key);
        if (keptKeys.has(n.key)) {
          body[n.key] = JSON.parse(n.enc);
        } else if (part) {
          body[n.key] = part.items;
          partialFields.push({ field: n.key, returned: part.items.length, total: part.total });
        } else {
          body[n.key] = ELIDED_MARKER;
          elidedKeys.push(n.key);
        }
      }
      return JSON.stringify({
        ...body,
        ...objectTruncationEnvelope(keptKeys.size, nested.length, elidedKeys),
        ...(partialFields.length > 0 ? { _partial_fields: partialFields } : {}),
      });
    };
    let best = render(kept);
    for (const n of nested) {
      const trial = new Set(kept).add(n.key);
      const candidate = render(trial);
      if (bytes(candidate) > capBytes) continue;
      kept.add(n.key);
      best = candidate;
    }

    if (bytes(best) <= capBytes) {
      for (const n of nested) {
        if (kept.has(n.key)) continue;
        const arr = JSON.parse(n.enc) as unknown;
        if (!Array.isArray(arr) || arr.length < 2) continue;
        let lo = 0;
        let hi = arr.length - 1;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          partial.set(n.key, { items: arr.slice(0, mid), total: arr.length });
          if (bytes(render(kept)) <= capBytes) lo = mid;
          else hi = mid - 1;
        }
        if (lo > 0) {
          partial.set(n.key, { items: arr.slice(0, lo), total: arr.length });
          best = render(kept);
        } else {
          partial.delete(n.key);
        }
      }
      for (const ls of longStrings) {
        let lo = STRING_PREVIEW_CHARS;
        let hi = ls.full.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          slim[ls.key] = mid >= ls.full.length ? ls.full : ls.full.slice(0, mid) + "…";
          if (bytes(render(kept)) <= capBytes) lo = mid;
          else hi = mid - 1;
        }
        slim[ls.key] = lo >= ls.full.length ? ls.full : ls.full.slice(0, lo) + "…";
        best = render(kept);
      }
    }

    if (bytes(best) > capBytes) {
      for (const ls of longStrings) slim[ls.key] = ls.full.slice(0, STRING_PREVIEW_CHARS) + "…";
      const scalarsOnly = JSON.stringify({
        ...slim,
        ...objectTruncationEnvelope(0, nested.length, nested.map((n) => n.key)),
      });
      if (bytes(scalarsOnly) <= capBytes) return scalarsOnly;
    }

    if (bytes(best) > capBytes) {
      return JSON.stringify(truncationEnvelope(0, undefined));
    }
    return best;
  }

  return JSON.stringify(String(parsed).slice(0, capBytes - 64) + "…");
}
