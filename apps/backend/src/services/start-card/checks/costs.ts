
export const MODEL_CALL_EST_USD = 0.005;

export const ENRICH_SEARCH_EST_USD = 0.03;
export const ENRICH_MODELS_EST_USD = 0.08;

export const SERP_EST_USD = 0.004;

export const RANKED_KEYWORDS_EST_USD = 0.02;

export const ANCHOR_SESSION_EST_USD = 0.05;

export const PAGESPEED_EST_USD = 0;

export const SEO_FETCH_EST_USD = 0;

export const roundUsd = (n: number): number => Math.round(n * 10_000) / 10_000;
