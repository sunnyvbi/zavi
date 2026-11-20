
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Input, Textarea } from "@/components/Input";
import { apiFetch } from "@/lib/api";

export default function NewRolePage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [jd, setJd] = useState("");
  const [mustAsk, setMustAsk] = useState<string[]>([""]);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    const res = await apiFetch("/api/roles", {
      method: "POST",
      body: JSON.stringify({
        slug,
        title,
        jd,
        must_ask_questions: mustAsk.filter((q) => q.trim().length > 0),
      }),
    });
    const out = await res.json();
    setSubmitting(false);
    if (out.role_id) router.push(`/roles/${out.role_id}/edit`);
  }

  return (
    <AppShell pageTitle="New role">
      <h1 className="text-2xl font-semibold mb-4">New role</h1>
      <Input className="mb-3" placeholder="Title (e.g. Founding Engineer)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Input className="mb-3" placeholder="URL slug (e.g. founding-engineer)" value={slug} onChange={(e) => setSlug(e.target.value)} />
      <Textarea className="mb-3 h-64 font-mono text-base" placeholder="Paste JD as markdown" value={jd} onChange={(e) => setJd(e.target.value)} />
      <h3 className="font-medium mb-2">Must-ask questions</h3>
      {mustAsk.map((q, i) => (
        <Input
          key={i}
          className="mb-2"
          placeholder="What's a recent system you've shipped end-to-end? Be specific."
          value={q}
          onChange={(e) => setMustAsk(mustAsk.map((x, j) => (i === j ? e.target.value : x)))}
        />
      ))}
      <button className="text-base text-slate-500" onClick={() => setMustAsk([...mustAsk, ""])}>+ Add another</button>
      <div className="mt-4">
        <button disabled={submitting} className="px-4 py-2 bg-slate-900 text-white rounded-cta disabled:opacity-50" onClick={submit}>
          {submitting ? "Generating Q set…" : "Create + draft Q set"}
        </button>
      </div>
    </AppShell>
  );
}
