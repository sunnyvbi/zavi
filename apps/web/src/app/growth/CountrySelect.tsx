"use client";

import { ChevronDown } from "lucide-react";
import { START_CARD_LOCALES, type StartCardLocale } from "@zavi/shared";
import { countryName } from "@/lib/start-card/api";

export function CountrySelect({ value }: { value?: StartCardLocale }) {
  return (
    <label className="relative flex items-center rounded-full border border-black/[0.08] bg-white pl-4 pr-3 shadow-[0_1px_2px_rgba(16,18,20,0.04)] hover:border-black/20">
      <span className="text-[14px] font-medium text-[#595959]">Country</span>
      <select
        name="country"
        aria-label="Country"
        defaultValue={value ?? ""}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="min-h-11 cursor-pointer appearance-none bg-transparent pl-2 pr-6 text-[14px] font-semibold outline-none"
      >
        <option value="">All countries</option>
        {START_CARD_LOCALES.map((c) => (
          <option key={c} value={c}>
            {countryName(c)}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-3 h-4 w-4 text-[#595959]" />
    </label>
  );
}
