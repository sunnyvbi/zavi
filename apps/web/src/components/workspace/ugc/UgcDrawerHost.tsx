"use client";

import { ApplicantsDrawer } from "./ApplicantsDrawer";
import { BriefDrawer } from "./BriefDrawer";
import { FindDrawer } from "./FindDrawer";
import { HireDrawer } from "./HireDrawer";
import { InboxDrawer } from "./InboxDrawer";
import { JobDrawer } from "./JobDrawer";
import { ThreadDrawer } from "./ThreadDrawer";
import { useUgcDrawer, type DrawerName, type DrawerParams } from "./hub";

export function UgcDrawerHost() {
  const { name, params } = useUgcDrawer();
  const key = `${name}:${JSON.stringify(params)}`;
  const findOpen = name === "find" || (name !== null && params.over === "find");
  return (
    <>
      {findOpen && <FindDrawer key="find" under={name !== "find"} />}
      {top(name, params, key)}
    </>
  );
}

function top(name: DrawerName | null, params: DrawerParams, key: string) {
  switch (name) {
    case "find":
      return null;
    case "hire":
      return <HireDrawer key={key} />;
    case "applicants":
      return <ApplicantsDrawer key={key} />;
    case "brief":
      return <BriefDrawer key={key} />;
    case "thread":
      return <ThreadDrawer key="thread" />;
    case "review":
      return <JobDrawer key={key} review />;
    case "job":
      return <JobDrawer key={key} />;
    case "inbox":
      return <InboxDrawer key={key} />;
    default:
      return null;
  }
}
