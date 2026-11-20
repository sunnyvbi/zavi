"use client";

import { LinkedInDraftStatus } from "./LinkedInDraftStatus";
import { ActionCardFrame } from "../card/ActionCardFrame";
import { blockingChip, eyebrowKind } from "../card/cardKind";
import { effortMeta } from "../card/cardModel";
import { isPostCard, primaryOf, type FamilyWords } from "../card/cardPrimary";
import { usePostComposer, type PostComposer } from "../card/usePostComposer";
import { channelName } from "../card/family";
import type { ActionBodyProps, ActionItem, PlatformSpec } from "../types";
import { OrganicBody } from "./OrganicBody";
import { PinBody } from "./blocks/PinFields";
import { organicChannel, organicSecondary } from "./organicSpec";

export function organicWords(a: ActionItem, platform?: PlatformSpec | null): FamilyWords {
  const network = channelName(a.channel_slug);
  return {
    network,
    manageUrl: platform?.manageUrl ?? null,
    composerUrl: platform?.composerUrl ?? null,
    composerLabel: platform?.composerLabel ?? null,
    directPublishOnly: platform?.directPublishOnly,
    executed: (x) => (x.channel_slug === "seo" || x.channel_slug === "geo" ? "Pull request opened" : "Approved"),
  };
}

function ComposedCard(props: ActionBodyProps) {
  return <OrganicFrame props={props} composer={usePostComposer(props)} />;
}

export function OrganicActionCard(props: ActionBodyProps) {
  return isPostCard(props.action) ? <ComposedCard {...props} /> : <OrganicFrame props={props} composer={null} />;
}

function OrganicFrame({ props, composer }: { props: ActionBodyProps; composer: PostComposer | null }) {
  const a = props.action;
  const ch = organicChannel(a.channel_slug);
  const words = organicWords(a, props.platform);
  const primary = primaryOf(a, composer?.handlers ?? props.handlers, words);
  const pin = props.platform?.pinCards === true;
  const stored = (a.body as { cost_credits?: unknown } | undefined)?.cost_credits;
  const credits = typeof stored === "number" && stored > 0 ? `${stored.toLocaleString("en-US")} credits, charged only when the video arrives` : null;
  const cost = a.channel_slug === "reddit_organic" ? null : typeof a.body?.cost === "string" ? a.body.cost : credits;
  const meta = pin ? [] : [cost ?? ch.meta ?? null, effortMeta(a)].filter((m): m is string => !!m);
  const spend = ch.creators && !!primary?.label.includes("$")
    ? { heading: `${primary.label}?`, body: "Zavi holds the money now and pays the creator after you approve the video." }
    : null;
  return (
    <ActionCardFrame
      props={props}
      words={words}
      composer={composer}
      spec={{
        kind: pin && a.blocking ? "Fix" : eyebrowKind(a),
        meta,
        chip: pin ? null : blockingChip(a),
        secondary: organicSecondary(a, primary, ch),
        spendConfirm: spend,
        plainSteps: ch.plainSteps,
        body: (copy, edited) => (<>{composer && <LinkedInDraftStatus action={a} canPublish={!!props.handlers.onPublish} />}{pin && a.action_type === "image_post" ? <PinBody a={a} copy={copy} edited={edited} mediaOverride={composer?.media} /> : <OrganicBody a={a} copy={copy} edited={edited} mediaOverride={composer?.media} />}</>),
      }}
    />
  );
}
