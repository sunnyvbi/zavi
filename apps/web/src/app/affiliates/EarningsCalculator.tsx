"use client";

import { useState } from "react";
import { AFFILIATE_PLANS, firstTwo, usd, yearOne, type PlanId } from "./terms";

const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e0f11]";

export const DEFAULT_PLAN: PlanId = "growth";
export const DEFAULT_CUSTOMERS = 10;
export const MAX_CUSTOMERS = 50;

export function estimate(price: number, count: number): { first: number; year: number } {
  return { first: firstTwo(price) * count, year: yearOne(price) * count };
}

export function EarningsCalculator() {
  const [plan, setPlan] = useState<PlanId>(DEFAULT_PLAN);
  const [count, setCount] = useState(DEFAULT_CUSTOMERS);
  const price = AFFILIATE_PLANS.find((p) => p.id === plan)?.price ?? 0;
  const { first, year } = estimate(price, count);

  return (
    <div className="mx-auto mt-10 max-w-[880px] overflow-hidden rounded-[24px] border border-[#0e0f11]/10 bg-white">
      <div className="grid gap-8 p-5 sm:p-8 lg:grid-cols-[1fr_280px] lg:items-center">
        <div className="flex min-w-0 flex-col gap-8">
          <div>
            <p id="calc-plan-label" className="text-[14px] font-semibold text-[#0e0f11]">
              Their plan
            </p>
            <div role="radiogroup" aria-labelledby="calc-plan-label" className="mt-3 grid grid-cols-3 gap-2">
              {AFFILIATE_PLANS.map((p) => {
                const on = p.id === plan;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setPlan(p.id)}
                    className={`${FOCUS} min-h-12 min-w-0 cursor-pointer rounded-xl border px-1 py-2 text-center transition-colors duration-150 ${
                      on ? "border-[#0e0f11] bg-[#0e0f11] text-white" : "border-[#0e0f11]/10 bg-white text-[#0e0f11] hover:bg-[#0e0f11]/[0.03]"
                    }`}
                  >
                    <span className="block text-[15px] font-semibold">{p.name}</span>
                    <span className={`block text-[12.5px] ${on ? "text-white/70" : "text-[#595959]"}`}>{usd(p.price)}/mo</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor="calc-customers" className="flex items-baseline justify-between text-[14px] font-semibold text-[#0e0f11]">
              Customers you refer
              <span className="text-[18px] text-[#027bff]" data-testid="calc-count">
                {count}
              </span>
            </label>
            <input
              id="calc-customers"
              type="range"
              min={1}
              max={MAX_CUSTOMERS}
              step={1}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="mt-3 h-2 w-full cursor-pointer accent-[#027bff]"
            />
            <span className="mt-1 flex justify-between text-[12px] text-[#595959]" aria-hidden="true">
              <span>1</span>
              <span>{MAX_CUSTOMERS}</span>
            </span>
          </div>
        </div>

        <div className="rounded-2xl bg-[#f9f9f9] p-6 text-center" aria-live="polite">
          <p className="text-[12px] font-semibold tracking-[0.1em] text-[#595959] uppercase">First 2 months</p>
          <p className="mt-1 text-[28px] leading-tight font-bold text-[#0e0f11]" data-testid="calc-first">
            {usd(first)}
          </p>
          <div className="mx-auto my-4 h-px w-16 bg-[#0e0f11]/10" />
          <p className="text-[12px] font-semibold tracking-[0.1em] text-[#595959] uppercase">Year one</p>
          <p className="mt-1 text-[36px] leading-none font-extrabold tracking-[-0.02em] break-words text-[#167f50] sm:text-[40px]" data-testid="calc-year">
            {usd(year)}
          </p>
          <p className="mt-3 text-[13px] text-[#595959]">
            {count} × {usd(yearOne(price))}
          </p>
        </div>
      </div>
      <p className="border-t border-[#0e0f11]/[0.06] px-5 py-4 text-[13px] text-[#595959] sm:px-8">
        Assumes they stay 12 months with no refunds.
      </p>
    </div>
  );
}
