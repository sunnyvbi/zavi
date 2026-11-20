import { cgoTestEndForRun, testEndUnix } from "@/services/growth/cgo-test-end";
import { armCreatedTestStop } from "@/services/growth/test-stops";
import {
  claimCampaignAccount,
  bindCampaign,
  getAccountBinding,
} from "@/services/ads-wallet/bindings";
import { assertAccountAvailableForNewCampaign } from "@/services/ads-wallet/accounts";
import {
  withBoundCampaign,
  currentBoundCampaign,
} from "@/services/ads-wallet/campaign-context";
import { withChatgptBudgetCampaign } from "@/services/ads-wallet/chatgpt-budget-identity";
import { resolveChatgptAccount } from "./account-binding";
import { adsFx, adsUsd, adsLocalMicros } from "@/services/ads-wallet/fx";
import { withChatgptWriteTracking } from "./write-tracking";
import { withApprovedChatgptDispatch } from "./growth-workspace-budget";
import { ExpectedToolError } from "@/services/tools/types";
import { checkAgentTier } from "@/services/agents/entitlement";
import { isChannelLockedStrict } from "@/services/channels/lock";
import { isOwnAdImagePath } from "@zavi/shared";
import { checkGeneratedAdImage } from "./generated-image";
import { checkOwnImageForVendor } from "@/services/chat-images/sign-own-image";
import { parseGrowthAction, growthCampaignBudget } from "./growth-actions";
import { adsNoFrictionEnabled } from "@/services/growth/ads-no-friction-flag";
import { WALLET_SHORT_CODE } from "@/services/ads-wallet/plan-funding";
import { campaignActionRequestId } from "./action-execution";
import {
  createCampaign,
  createAdGroup,
  saveAdCreative,
  readCampaign,
  readCampaignTree,
  readServerMadeTree,
  updateCampaign,
} from "./workspace";
import { launchCampaign, launchServerMadeCampaign, launchSnapshot, fullyActive, awaitingReview, untilSettled, launchTiming, READBACK_WAIT_MS, campaignWalletReserved } from "./launch";
import { dailyHoldEndsOn, utcStamp } from "@/services/growth/ad-plan-shape";
import {
  validateSchedule,
  fundingLimit,
  checkResources,
} from "./campaign-settings";
import { assertServingReady } from "./serving";
import { resolveTenantCampaignPrefix } from "./tenant-scope";
import { readChatgptFundingContext } from "@/services/channels/chatgpt-ads/funding-context";
import { fundingEnabled } from "@/services/channels/chatgpt-ads/wallet";
import {
  reserveAdSpend,
  budgetMustHold,
  noteAdSpendRef,
  noteAdSpendObject,
  commitAdSpend,
  dropAdSpendHold,
  releaseAdSpendForObject,
  rebaseAdSpendForObject,
  type AdSpendHold,
  lifetimeDailyUsd,
} from "@/services/decisions/ad-budget";
import { recordZaviAdChange } from "@/services/decisions/ad-changes";
import { logEvent } from "@/services/logging/logEvent";
import type { CreatedObject } from "@/services/channels/created-object";

type Decision = {
  id: string;
  tenant_id: string;
  agent_run_id?: string | null;
  test_stop_pause?: true;
  decision_class: string;
  body: unknown;
  exec_source?: string;
  approved_by_source?: string | null;
  approved_by?: string | null;
};
const refuse = (message: string): never => {
  throw new ExpectedToolError("chatgpt_ads_conflict", message);
};
export async function assertGrowthExecutionAllowed(d: Decision) {
  if (d.test_stop_pause === true && d.decision_class === "chatgpt_ads.set_status" && (d.body as { status?: unknown } | null)?.status === "PAUSED") {
    if (await isChannelLockedStrict("chatgpt_ads")) refuse("ChatGPT Ads is unavailable for this workspace.");
    return;
  }
  if (
    !(await checkAgentTier(d.tenant_id, "chatgpt_ads")).allowed ||
    (await isChannelLockedStrict("chatgpt_ads"))
  )
    refuse("ChatGPT Ads is unavailable for this workspace.");
  if (d.approved_by_source === "cgo") {
    const { readChannelAutorun } =
      await import("@/services/growth/unattended-policy");
    const { cgoAdBudget } = await import("@/services/growth/cgo-ads");
    if (
      !(await readChannelAutorun(d.tenant_id, "chatgpt_ads")) ||
      !(await cgoAdBudget(d.tenant_id))
    )
      refuse("ChatGPT Autopilot permission or Growth budget was turned off.");
  } else if (!d.approved_by) refuse("This campaign change needs approval.");
}
async function executeApprovedChatgptGrowthAction(
  d: Decision,
): Promise<{
  ok: boolean;
  code?: string;
  error?: string;
  notice?: string;
  created?: CreatedObject;
}> {
  let hold: AdSpendHold = { status: "no_budget" };
  let sent = false;
  let campaignId: string | undefined;
  return withChatgptWriteTracking(
    () => {
      sent = true;
    },
    async () => {
      try {
        const action = parseGrowthAction(d.decision_class, d.body);
        await assertGrowthExecutionAllowed(d);
        const guard = () => assertGrowthExecutionAllowed(d);
        const stopping =
          action.kind === "status" && action.value.status === "PAUSED";

        const from = {
          table:
            d.exec_source === "channel_actions"
              ? ("channel_actions" as const)
              : ("decisions" as const),
          id: d.id,
        };
        if (action.kind === "create") {
          const bundle = action.value.bundle;
          for (const ad of bundle.ads) {
            if (ad.image_artifact_id) await checkGeneratedAdImage(d.tenant_id, ad.image_artifact_id);
            if (ad.image_path) await checkOwnImageForVendor(d.tenant_id, ad.image_path);
          }
          let testEnd: Awaited<ReturnType<typeof cgoTestEndForRun>> = null;
          try {
            testEnd = await cgoTestEndForRun(d.tenant_id, d.agent_run_id, new Date());
          } catch {
            refuse("Zavi could not read this test's end date, so nothing new was created on this attempt. Approve again in a minute.");
          }
          const testEndUnixAt = testEnd ? Math.min(bundle.campaign.end_time, testEndUnix(testEnd.ends_on)) : null;
          if (testEndUnixAt != null && testEndUnixAt <= Math.max(bundle.campaign.start_time, Math.floor(Date.now() / 1000)))
            refuse("This test would end before the campaign could start. Nothing was created.");
          const campaign = {
            ...bundle.campaign,
            name: `${bundle.campaign.name.slice(0, 740)} · ${d.id}`,
            ...(testEndUnixAt != null ? { end_time: testEndUnixAt } : {}),
          };
          const lifetime = campaign.lifetime_budget_micros ?? null;
          if (lifetime != null && !(await adsNoFrictionEnabled()))
            refuse("Lifetime ChatGPT campaigns are turned off. Propose a daily budget.");
          const budget = growthCampaignBudget(campaign);
          validateSchedule({ ...campaign, budget });
          const account = await claimCampaignAccount(
            d.tenant_id,
            "chatgpt",
            campaignActionRequestId(d.id, "growth-campaign"),
          );
          await assertAccountAvailableForNewCampaign(d.tenant_id, account);
          const resolved = await resolveChatgptAccount(d.tenant_id, account);
          await assertServingReady(resolved.key, account.funding_source);
          const fx = await adsFx(resolved.account.currency_code!);
          if (fx.currency !== action.value.currency)
            refuse(
              "Selected account currency changed. Propose this campaign again.",
            );
          await checkResources(d.tenant_id, campaign, {
            key: resolved.key,
            accountId: account.account_id,
          });
          if (
            bundle.ads.some(
              (a) =>
                a.image_path && !isOwnAdImagePath(d.tenant_id, a.image_path),
            )
          )
            refuse("An ad image does not belong to this workspace.");
          if (account.funding_source === "wallet") {
            if (!fundingEnabled())
              refuse("ChatGPT wallet funding is unavailable.");
            const wallet = await readChatgptFundingContext(d.tenant_id);
            const required = Math.ceil(
              fundingLimit({
                ...campaign,
                budget,
                created_at: Date.now() / 1000,
              }) / 10000,
            );
            if (action.value.top_up_authorized === false && (wallet.status !== "read" || wallet.available_cents < required))
              refuse("This campaign is wallet-only and the available balance no longer covers its schedule. Nothing launched; no card charge or top-up was attempted. Propose it again using the current wallet balance.");
            if (wallet.status === "read" && wallet.available_cents < required && d.exec_source === "channel_actions")
              await fundEnvelopeShortfall(d, required - wallet.available_cents);
            if (wallet.status !== "read" || wallet.available_cents < required)
              refuse(
                `Add enough prepaid ChatGPT balance to cover this campaign's schedule before launching (required coverage: $${(required / 100).toFixed(2)}).`,
              );
          }
          const lifetimeUsd = lifetime != null ? adsUsd(lifetime / 1e6, fx) : null;
          const dailyUsd = lifetime == null ? adsUsd(campaign.daily_budget_micros! / 1e6, fx) : 0;
          if (
            (lifetimeUsd == null && action.value.daily_budget_usd !== undefined && dailyUsd > action.value.daily_budget_usd) ||
            (lifetimeUsd != null && action.value.lifetime_budget_usd !== undefined && lifetimeUsd > action.value.lifetime_budget_usd)
          )
            refuse(
              "Converted budget increased since review. Propose this campaign again.",
            );
          const endsOn = dailyHoldEndsOn(campaign.end_time);
          hold = await reserveAdSpend(d, lifetimeUsd != null
            ? { platform: "chatgpt", op: "create", object_id: null, daily_delta_usd: lifetimeDailyUsd(lifetimeUsd, (campaign.end_time - Math.max(campaign.start_time, Date.now() / 1000)) / 86_400, 2), paused: false, lifetime_usd: lifetimeUsd }
            : { platform: "chatgpt", op: "create", object_id: null, daily_delta_usd: dailyUsd, paused: false, ends_on: endsOn });
          if (hold.status === "refused")
            return { ok: false, error: hold.error };
          if (hold.status === "held" && hold.over_cap)
            await (await import("@/services/growth/ad-plan-yes")).askBudgetRaiseOnce(d.tenant_id, null);
          const missing = budgetMustHold(d, hold);
          if (missing) return { ok: false, error: missing };
          const labelError = await noteAdSpendRef(hold, {
            kind: "chatgpt_campaign_name",
            name:
              (await resolveTenantCampaignPrefix(d.tenant_id)) + campaign.name,
            account_binding_id: account.id,
          });
          if (labelError) return { ok: false, error: labelError };
          await guard();
          let fallbackLine: string | null = null;
          let createdLifetimeUsd = lifetimeUsd;
          let made: Awaited<ReturnType<typeof createCampaign>>;
          try {
            made = await createCampaign(
              d.tenant_id,
              campaign,
              campaignActionRequestId(d.id, "growth-campaign"),
            );
          } catch (e) {
            const smaller = lifetimeUsd != null && e instanceof ExpectedToolError && e.code === "chatgpt_ads_lifetime_too_small" && fx.currency === "USD"
              ? await smallerLifetimeWithinEnvelope(d, lifetimeUsd, campaign, (e.meta?.min_usd as number | undefined) ?? null)
              : null;
            if (!smaller) throw e;
            await guard();
            made = await createCampaign(d.tenant_id, smaller.campaign, campaignActionRequestId(d.id, "growth-campaign-smaller"));
            fallbackLine = smaller.line;
            createdLifetimeUsd = smaller.campaign.lifetime_budget_micros! / 1e6;
          }
          campaignId = made.id;
          const providerCampaignId = made.id;
          const testEndProblem = testEndUnixAt != null && !(typeof made.end_time === "number" && made.end_time <= testEndUnixAt)
            ? `ChatGPT shows the campaign ending ${typeof made.end_time === "number" ? utcStamp(made.end_time * 1000) : "never"}, not by the test's end ${utcStamp(testEndUnixAt * 1000)}`
            : null;
          const binding = await bindCampaign(d.tenant_id, account, campaignId);
          const objectId =
            binding.funding_source === "provider" ? binding.id : campaignId;
          return await withBoundCampaign(binding, async () => {
            await noteAdSpendObject(hold, objectId);
            await commitAdSpend(hold, objectId);
            let turnedOn = false;
            const notLaunched = async (why: string) => {
              const undone = await undoUnlaunchedCreate(d, providerCampaignId, objectId);
              const reserved = binding.funding_source === "provider" ? false : await campaignWalletReserved(d.tenant_id, providerCampaignId);
              const walletLine = (reserved ?? turnedOn) && binding.funding_source !== "provider" ? " Your ChatGPT ads balance may keep a reservation for this campaign for 48 hours to cover late-reported spend, then gets it back." : "";
              return {
                ok: false,
                code: undone === "archived" || undone === "archived_hold_kept" ? "chatgpt_ads_launch_undone" : "exec_partial",
                error: undone === "archived"
                  ? `Zavi created ChatGPT campaign ${providerCampaignId} but could not launch it, so it was archived and its budget hold released. It is not running. Any spend from before it stopped shows in ChatGPT Ads within 48 hours.${walletLine} Ask again to start a new one. Why: ${why}`
                  : undone === "archived_hold_kept"
                    ? `Zavi created ChatGPT campaign ${providerCampaignId} but could not launch it, so it was archived. It is not running. Zavi could not confirm its budget hold was released, so it may still count against your ad budget for now; Zavi has been alerted to check it.${walletLine} Ask again to start a new one. Why: ${why}`
                  : undone === "archive_failed"
                    ? `Zavi created ChatGPT campaign ${providerCampaignId} but could not launch it, and could not archive it either, so it may be partly on. Check it in ChatGPT Ads. Why: ${why}`
                    : `Campaign ${providerCampaignId} was created, but launch was not completed. ${why} No duplicate will be created; the reservations remain until reconciled.`,
              };
            };
            let proof: Awaited<ReturnType<typeof readServerMadeTree>>;
            if (testEndProblem) return await notLaunched(testEndProblem);
            const stop = await armCreatedTestStop(d.tenant_id, d.id, testEnd, {
              platform: "chatgpt",
              level: "campaign",
              account_id: async () => (binding.funding_source === "provider" ? String(resolved.account.id) : `chatgpt:${d.tenant_id}`),
              object_id: objectId,
              billing_scope: "object",
              daily_usd: dailyUsd,
              lifetime_usd: createdLifetimeUsd,
              name: campaign.name,
            });
            if (!stop.ok) return await notLaunched(`Zavi could not set up the pause that guards this test's spend: ${stop.why}`);
            try {
              await guard();
              const group = await createAdGroup(
                d.tenant_id,
                providerCampaignId,
                bundle.group,
                campaignActionRequestId(d.id, "growth-group"),
              );
              const adIds: string[] = [];
              for (const [i, ad] of bundle.ads.entries()) {
                await guard();
                const saved = await saveAdCreative(
                  d.tenant_id,
                  providerCampaignId,
                  { ...ad, ad_group_id: group.id },
                  undefined,
                  campaignActionRequestId(d.id, `growth-ad:${i}`),
                  group.id,
                );
                adIds.push(saved.id);
              }
              const created = made;
              const manifest = {
                groupId: group.id,
                adIds,
                terms: { budget: created.budget, start_time: created.start_time, end_time: created.end_time, max_bid_micros: bundle.group.max_bid_micros ?? null },
              };
              const launched = await launchServerMadeCampaign(
                d.tenant_id,
                providerCampaignId,
                manifest,
                guard,
              );
              if ((launched.items ?? []).some((i) => i.status === "activated" || (i.kind === "campaign" && (i.status === "failed" || i.status === "already_active")))) turnedOn = true;
              if (!launched.ok) return await notLaunched((launched.items ?? []).find((i) => i.status === "failed")?.reason ?? launched.message ?? "ChatGPT did not confirm the launch.");
              const read = await untilSettled(() => readServerMadeTree(d.tenant_id, providerCampaignId, manifest), (t) => t.missing.length === 0 && fullyActive(t), launchTiming.now() + READBACK_WAIT_MS);
              if (!read.settled) return await notLaunched("The campaign launch could not be verified on readback.");
              proof = read.value;
            } catch (e) {
              return await notLaunched(e instanceof ExpectedToolError ? e.message : "ChatGPT did not confirm a step of the launch.");
            }
            try {
              await commitAdSpend(hold, objectId);
              await recordZaviAdChange(d.tenant_id, from, {
                platform: "chatgpt",
                object_id: objectId,
                campaign_id: objectId,
                level: "campaign",
                object_name: campaign.name,
                change_kind: "status",
                before_status: "PAUSED",
                after_status: "ACTIVE",
                before_daily_usd: dailyUsd,
                after_daily_usd: dailyUsd,
              });
            } catch (e) {
              void logEvent({ level: "error", source: "chatgpt-ads", code: "chatgpt_ads.post_live_bookkeeping_failed", tenant_id: d.tenant_id, meta: { failure_class: e instanceof ExpectedToolError ? e.code : "unexpected" } });
            }
            const live = proof.campaign;
            const liveTotal = typeof live.budget?.lifetime_spend_limit_micros === "number" ? live.budget.lifetime_spend_limit_micros / 1e6 : createdLifetimeUsd;
            const cap = liveTotal != null
              ? `It can spend at most $${liveTotal.toFixed(2)} in total`
              : `It runs at $${dailyUsd.toFixed(2)} a day`;
            const ends = typeof live.end_time === "number" ? ` and stops ${utcStamp(live.end_time * 1000)}` : "";
            const review = awaitingReview(proof) ? " It starts showing once ChatGPT finishes reviewing the ad." : "";
            return {
              ok: true,
              notice:
                `${fallbackLine ? `${fallbackLine} ` : ""}Your ChatGPT ad is on (campaign ${providerCampaignId}). ${cap}${ends}.${review}${stop.line ? ` ${stop.line}` : ""}`,
              created: {
                platform: "chatgpt",
                object_type: "campaign",
                id: objectId,
                status: "ACTIVE",
                activated_at: new Date().toISOString(),
              },
            };
          });
        }
        const value = action.value;
        campaignId =
          currentBoundCampaign()?.provider_campaign_id ?? value.campaign_id;
        const objectId =
          currentBoundCampaign()?.funding_source === "provider"
            ? currentBoundCampaign()!.id
            : campaignId;
        const tree = await readCampaignTree(d.tenant_id, campaignId);
        const c = tree.campaign;
        const fx = stopping
          ? null
          : await adsFx(tree.providerCurrency ?? "USD");
        if (!stopping) {
          const account = await getAccountBinding(
            d.tenant_id,
            tree.binding.account_binding_id,
          );
          const resolved = await resolveChatgptAccount(d.tenant_id, account);
          await assertServingReady(resolved.key, account.funding_source);
          if (account.funding_source === "wallet" && !fundingEnabled())
            refuse("ChatGPT wallet funding is unavailable.");
        }
        if (c.updated_at !== value.expected_updated_at)
          refuse(
            "Campaign changed after proposal. Refresh and propose the new version.",
          );
        const daily = c.budget?.daily_spend_limit_micros;
        if (!stopping && (!Number.isSafeInteger(daily) || daily < 25e6))
          refuse("This automatic operation requires a daily-budget campaign.");
        if (
          action.kind === "status" &&
          launchSnapshot(tree) !== action.value.snapshot
        )
          refuse("Campaign or creatives changed after proposal.");
        const dailyUsd = fx ? adsUsd(daily / 1e6, fx) : null;
        if (
          action.kind === "budget" &&
          dailyUsd !== action.value.expected_current_daily_budget_usd
        )
          refuse("Daily budget changed after proposal.");
        const delta =
          action.kind === "budget"
            ? action.value.daily_budget_usd - dailyUsd!
            : stopping
              ? 0
              : dailyUsd!;
        if (delta > 0) {
          hold = await reserveAdSpend(d, {
            platform: "chatgpt",
            op: action.kind === "budget" ? "raise" : "resume",
            object_id: objectId,
            daily_delta_usd: delta,
          });
          if (hold.status === "refused")
            return { ok: false, error: hold.error };
          const missing = budgetMustHold(d, hold);
          if (missing) return { ok: false, error: missing };
        }
        await guard();
        if (action.kind === "budget") {
          const updated = await updateCampaign(d.tenant_id, campaignId, {
            daily_budget_micros: adsLocalMicros(
              action.value.daily_budget_usd,
              fx!,
            ),
            expected_updated_at: value.expected_updated_at,
          });
          if (
            updated.budget?.daily_spend_limit_micros !==
            adsLocalMicros(action.value.daily_budget_usd, fx!)
          )
            refuse("Budget update not confirmed; reservation retained.");
          if (delta < 0)
            await rebaseAdSpendForObject(
              d.tenant_id,
              "chatgpt",
              objectId,
              action.value.daily_budget_usd,
              `${d.id}:rebase`,
              -delta,
            );
          await recordZaviAdChange(d.tenant_id, from, {
            platform: "chatgpt",
            object_id: objectId,
            level: "campaign",
            campaign_id: objectId,
            object_name: c.name,
            change_kind: "budget",
            before_status: c.status?.toUpperCase() ?? null,
            after_status: updated.status?.toUpperCase() ?? null,
            before_daily_usd: dailyUsd,
            after_daily_usd: action.value.daily_budget_usd,
          });
        } else {
          if (stopping) {
            await updateCampaign(d.tenant_id, campaignId, {
              status: "paused",
              expected_updated_at: value.expected_updated_at,
            });
            await releaseAdSpendForObject(d.tenant_id, "chatgpt", objectId);
          } else {
            const result = await launchCampaign(
              d.tenant_id,
              campaignId,
              {
                expected_updated_at: value.expected_updated_at,
                snapshot: action.value.snapshot,
              },
              guard,
            );
            if (!result.ok) {
              if (!sent) await dropAdSpendHold(hold);
              return {
                ok: false,
                code: sent ? "exec_partial" : "chatgpt_ads_preflight_refused",
                error: sent
                  ? "Launch was not fully verified. Check this campaign before retrying; its reservations remain."
                  : result.message,
              };
            }
            if (!fullyActive(await readCampaignTree(d.tenant_id, campaignId)))
              refuse("Launch was not fully verified; reservation retained.");
          }
          await recordZaviAdChange(d.tenant_id, from, {
            platform: "chatgpt",
            object_id: objectId,
            level: "campaign",
            campaign_id: objectId,
            object_name: c.name,
            change_kind: "status",
            before_status: c.status?.toUpperCase() ?? null,
            after_status: action.value.status,
            before_daily_usd: dailyUsd,
            after_daily_usd: dailyUsd,
          });
        }
        await commitAdSpend(hold, objectId);
        return { ok: true, notice: "ChatGPT campaign change confirmed." };
      } catch (e) {
        const definite = e instanceof ExpectedToolError && e.code === "chatgpt_ads_lifetime_too_small" && !campaignId;
        if (!sent || definite) await dropAdSpendHold(hold);
        if (definite) return { ok: false, code: "chatgpt_ads_lifetime_too_small", error: (e as Error).message };
        return {
          ok: false,
          code: sent
            ? campaignId
              ? "exec_partial"
              : "exec_outcome_unknown"
            : e instanceof ExpectedToolError && e.code === WALLET_SHORT_CODE
              ? WALLET_SHORT_CODE
              : "chatgpt_ads_preflight_refused",
          error:
            e instanceof ExpectedToolError
              ? e.message
              : sent
                ? "The provider outcome could not be verified. Check the campaign before retrying; reservations remain."
                : "ChatGPT campaign checks failed before any provider write.",
        };
      }
    },
  );
}
async function undoUnlaunchedCreate(d: Decision, providerCampaignId: string, objectId: string): Promise<"archived" | "archived_hold_kept" | "archive_failed" | "not_envelope"> {
  try {
    if (d.exec_source !== "channel_actions") return "not_envelope";
    const { readApprovalEnvelope } = await import("@/services/approvals/approval-envelope");
    const env = await readApprovalEnvelope(d.tenant_id, "channel_actions", d.id).catch(() => null);
    if (!env || env.tenant_id !== d.tenant_id) return "not_envelope";
  } catch {
    return "not_envelope";
  }
  await updateCampaign(d.tenant_id, providerCampaignId, { status: "archived" }).catch(() => null);
  const after = await untilSettled(() => readCampaign(d.tenant_id, providerCampaignId).catch(() => null), (c) => c?.status === "archived", launchTiming.now() + READBACK_WAIT_MS);
  if (!after.settled) return "archive_failed";
  const confirm = { confirm: true };
  if ((await releaseAdSpendForObject(d.tenant_id, "chatgpt", objectId, confirm)) || (await releaseAdSpendForObject(d.tenant_id, "chatgpt", objectId, confirm))) return "archived";
  return "archived_hold_kept";
}

async function smallerLifetimeWithinEnvelope<C extends { lifetime_budget_micros?: number; start_time: number; end_time: number }>(
  d: Decision,
  askedUsd: number,
  campaign: C,
  statedMinUsd: number | null,
): Promise<{ campaign: C; line: string } | null> {
  if (d.exec_source !== "channel_actions" || !(await adsNoFrictionEnabled())) return null;
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const { data } = await tenantClient(asTenantId(d.tenant_id)).from("channel_actions").select("approval_envelope").eq("id", d.id).eq("tenant_id", d.tenant_id).maybeSingle();
  const { parseEnvelope, planFromEnvelope, createFitsEnvelope, createOf } = await import("@/services/approvals/approval-envelope");
  const env = parseEnvelope((data as { approval_envelope?: unknown } | null)?.approval_envelope);
  if (!env || env.tenant_id !== d.tenant_id || env.max_daily_usd != null) return null;
  const { directAskFallback } = await import("@/services/growth/direct-ad-ask");
  const plan = planFromEnvelope(env);
  const fb = directAskFallback({ ...plan, total_usd: Math.min(plan.total_usd, askedUsd) }, statedMinUsd);
  if (!fb || fb.total_usd > askedUsd) return null;
  const smaller = { ...campaign, lifetime_budget_micros: Math.round(fb.total_usd * 1e6), end_time: Math.min(campaign.end_time, campaign.start_time + fb.days * 86_400) };
  if (!createFitsEnvelope(env, createOf("chatgpt_ads.create_and_launch", { bundle: { campaign: smaller }, currency: "USD" }))) return null;
  const usd = (n: number) => `$${n.toFixed(2)}`;
  return {
    campaign: smaller,
    line: `ChatGPT refused ${usd(askedUsd)} as one total${statedMinUsd ? ` (its minimum is ${usd(statedMinUsd)})` : ""}, so I ran ${usd(fb.total_usd)} as one total for ${fb.days} day${fb.days === 1 ? "" : "s"} instead. It can never spend more.`,
  };
}

async function fundEnvelopeShortfall(d: Decision, shortfallCents: number): Promise<void> {
  const { adsNoFrictionEnabled } = await import("@/services/growth/ads-no-friction-flag");
  if (!(await adsNoFrictionEnabled())) return;
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const { data } = await tenantClient(asTenantId(d.tenant_id)).from("channel_actions").select("approval_envelope, proposed_at").eq("id", d.id).eq("tenant_id", d.tenant_id).maybeSingle();
  const row = data as { approval_envelope?: unknown; proposed_at?: string | null } | null;
  const { parseEnvelope } = await import("@/services/approvals/approval-envelope");
  const env = parseEnvelope(row?.approval_envelope);
  if (!env || env.tenant_id !== d.tenant_id) return;
  const { fundApprovedPlan } = await import("@/services/ads-wallet/plan-funding");
  const f = await fundApprovedPlan(d.tenant_id, { action_id: d.id, actor_user_id: env.actor_user_id, shortfall_cents: shortfallCents, proposed_at_ms: Date.parse(row?.proposed_at ?? "") || Date.now() });
  throw new ExpectedToolError(WALLET_SHORT_CODE, f.line);
}
export function executeChatgptGrowthAction(d: Decision) {
  const action = parseGrowthAction(d.decision_class, d.body);
  return withApprovedChatgptDispatch(d.tenant_id, () =>
    action.kind === "create"
      ? executeApprovedChatgptGrowthAction(d)
      : withChatgptBudgetCampaign(d.tenant_id, action.value.campaign_id, () =>
          executeApprovedChatgptGrowthAction(d),
        ),
  );
}
