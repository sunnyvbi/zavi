
"use client";
import { useState } from "react";
import { Textarea } from "@/components/Input";
import { apiFetch } from "@/lib/api";

type Q = { id: string; prompt: string; must_ask: boolean; allow_followup: boolean };

export function QuestionEditor({
  roleId,
  approvedQuestions,
  draftQuestions,
  publicSlug,
}: {
  roleId: string;
  approvedQuestions: Q[];
  draftQuestions: Q[];
  publicSlug: string;
}) {
  const [qs, setQs] = useState<Q[]>([...approvedQuestions, ...draftQuestions]);
  const [publishing, setPublishing] = useState(false);
  const [decisionId, setDecisionId] = useState<string | null>(null);

  async function publish() {
    setPublishing(true);
    const res = await apiFetch(`/api/roles/${roleId}/publish`, {
      method: "POST",
      body: JSON.stringify({ approved_questions: qs }),
    });
    const out = await res.json();
    setPublishing(false);
    setDecisionId(out.decision_id);
  }

  return (
    <div>
      <h3 className="font-medium mb-2">Approved + drafted questions</h3>
      <p className="text-xs text-slate-500 mb-4">
        Edit, delete, or reorder. The agent will ask ONLY what's here. Click Publish to send to Needs you. Zavi will only ask exactly these questions, ever.
      </p>
      <ul className="space-y-2 mb-4">
        {qs.map((q, i) => (
          <li key={q.id} className="border rounded-md p-3">
            <Textarea
              unstyled
              className="w-full border-0 outline-none text-base font-mono"
              rows={2}
              value={q.prompt}
              onChange={(e) => setQs(qs.map((x, j) => (i === j ? { ...x, prompt: e.target.value } : x)))}
            />
            <label className="text-xs flex gap-1 items-center mt-1">
              <input type="checkbox" checked={q.must_ask} onChange={(e) => setQs(qs.map((x, j) => (i === j ? { ...x, must_ask: e.target.checked } : x)))} />
              must-ask
            </label>
            <button className="text-xs text-red-600 mt-1" onClick={() => setQs(qs.filter((_, j) => j !== i))}>delete</button>
          </li>
        ))}
      </ul>
      <button disabled={publishing} className="px-4 py-2 bg-slate-900 text-white rounded-cta disabled:opacity-50" onClick={publish}>
        {publishing ? "Publishing…" : "Publish to Needs you"}
      </button>
      {decisionId && (
        <p className="text-base text-green-700 mt-3">
          Submitted. Approve it in Needs you to make this URL live: /c/&lt;your-slug&gt;/{publicSlug}
        </p>
      )}
    </div>
  );
}
