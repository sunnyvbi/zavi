"use client";

import { CreatorsTable } from "@/components/admin/creators/CreatorsTable";

export default function CreatorsPage() {
  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-sky-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Creators</h1>
        <p className="text-sm text-slate-600 mt-1">
          Every creator who has signed up. Disable takes a creator off the network: they disappear from Find
          creators and can no longer be booked. Jobs already in progress still finish and pay out.
        </p>
      </div>
      <CreatorsTable />
    </div>
  );
}
