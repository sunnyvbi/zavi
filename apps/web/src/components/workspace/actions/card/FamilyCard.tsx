"use client";

import type { ActionBodyProps } from "../types";
import { OrganicActionCard, organicWords } from "../organic/OrganicActionCard";
import { OrganicBody } from "../organic/OrganicBody";
import { PaidActionCard, paidWords } from "../paid/PaidActionCard";
import { PaidDoneBody } from "../paid/PaidDoneBody";
import { paidKind, simpleCard } from "../paid/paidSpec";
import { eyebrowKind } from "./cardKind";
import { isDoneCard } from "./cardModel";
import { DoneCard } from "./DoneCard";
import { channelFamily } from "./family";
import { useExecFailureToast } from "../ActionFooter";

export function FamilyCard(props: ActionBodyProps) {
  const a = props.action;
  const paid = channelFamily(a.channel_slug) === "paid";
  useExecFailureToast(a, props.platform?.name ?? "the ad platform", props.platform?.execCopy);
  if (isDoneCard(a)) {
    const words = paid ? paidWords(a) : organicWords(a, props.platform);
    return (
      <DoneCard
        a={a}
        kind={paid ? paidKind(a) : eyebrowKind(a)}
        done={(a.exec_status === "executed" ? props.platform?.execCopy?.doneFor?.(a) : null) ?? (a.executable ? words.executed(a) : a.done_label ?? "Done")}
        platformName={props.platform?.name ?? words.network}
        execCopy={props.platform?.execCopy}
        hideActions={props.hideActions}
        inlineStatus={paid}
        plainStatus={paid && simpleCard(a)}
        body={(copy) => (paid ? <PaidDoneBody a={a} copy={copy} /> : <OrganicBody a={a} copy={copy} edited={null} />)}
      />
    );
  }
  return paid ? <PaidActionCard {...props} /> : <OrganicActionCard {...props} />;
}
