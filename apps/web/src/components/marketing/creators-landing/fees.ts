
import {
  BUSINESS_FEE_BPS,
  CREATOR_FEE_BPS,
  businessPaysCents,
  creatorReceivesCents,
  formatUsdCents,
} from "@zavi/shared";

const toCents = (dollars: number) => Math.round(dollars * 100);

export const FEES = {
  businessPct: BUSINESS_FEE_BPS / 100,
  creatorPct: CREATOR_FEE_BPS / 100,
};

export const money = (dollars: number) => formatUsdCents(toCents(dollars));

export const businessTotal = (price: number) => businessPaysCents(toCents(price)) / 100;

export const creatorGets = (price: number) => creatorReceivesCents(toCents(price)) / 100;

export const REVISION_ROUNDS = 2;
