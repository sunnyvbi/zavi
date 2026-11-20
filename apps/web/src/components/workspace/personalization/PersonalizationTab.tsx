"use client";

import { useState } from "react";
import { useWorkspace } from "../WorkspaceShell";
import { isMember } from "@/lib/members";
import { CompanyFactsPanel } from "../CompanyFactsPanel";
import { GrowthBrandVoice } from "../growth/GrowthBrandVoice";
import { CompanySummarySection } from "./CompanySummarySection";
import { DocumentsSection } from "./DocumentsSection";
import { ImportedKnowledgeSection } from "./ImportedKnowledgeSection";
import { LearnedFactsSection } from "./LearnedFactsSection";
import { usePersonalization } from "./usePersonalization";

export function PersonalizationTab() {
  const { role } = useWorkspace();
  const readOnly = isMember(role);
  const { data, loading, error, save } = usePersonalization();
  const [summaryKey, setSummaryKey] = useState(0);
  const bump = () => setSummaryKey((k) => k + 1);

  return (
    <div className="mx-auto w-full max-w-[1080px] px-8 pb-12 pt-6">
      <h1 className="text-[20px] font-semibold leading-7 tracking-[-0.01em] text-ink">Personalization</h1>
      <p className="mt-1.5 text-[16px] leading-5 text-inkMuted">
        What your agents know about the company, how they write, and the files they can reference. Every agent
        uses the saved version on its next run. Brand Voice is the same card as on the Growth page, so editing
        it in either place changes the one setting.
      </p>
      <div className="mt-6 space-y-5">
        <GrowthBrandVoice
          variant="personalization"
          data={data}
          loading={loading}
          loadError={error}
          canEdit={!readOnly}
          onSave={save}
        />
        <CompanyFactsPanel readOnly={readOnly} onSaved={bump} />
        <CompanySummarySection refreshKey={summaryKey} />
        <DocumentsSection readOnly={readOnly} />
        {}
        <ImportedKnowledgeSection readOnly={readOnly} />
        <LearnedFactsSection readOnly={readOnly} onChanged={bump} />
      </div>
    </div>
  );
}
