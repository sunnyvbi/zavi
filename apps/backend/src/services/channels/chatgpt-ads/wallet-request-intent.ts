export function asksForWalletBalance(text: unknown): boolean {
  if (typeof text !== "string" || text.length > 2000) return false;
  const t = text.toLowerCase().replace(/(?<!\b(?:why|how|when|where|what|who)\s+)\b(?:could|would)\s+you\s+(?:please\s+)?(?=(?:run|launch|start|spend|use)\b)/g, "");
  const fit = /^(?:(?:please|pls)\s+|(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:fit|keep|adjust|resize)\s+(?:it|this|that|the\s+(?:ad|campaign|proposal))(?:\s+.*)?\b(?:in|into|within|to)\s+(?:(?:the|my|our)\s+)?(?:(?:remaining|existing|current|wallet|av\w{3,9})\s+)?(?:wallet\s+)?balance\b/i.test(text.trim());
  if (fit && !/\b(don'?t|do not|never|not|if|why|whether|example|hypothetical)\b|["“”]|^\s*>/im.test(text)) return true;
  if (/\b(don'?t|do not|never|stop|pause|hypothetical|example|if|would|could|maybe)\b/.test(t) || /["“”]|^\s*>/m.test(t)) return false;
  return /\b(run|launch|start|spend|use)\b/.test(t)
    && /\b(ads?|campaign)\b/.test(t)
    && /\b(remaining|remining|available|leftover)\s+(?:ads?\s+)?wallet\s+balance\b|\b(?:what(?:'s| is)|money|funds)\s+left\s+in\s+(?:my|the|this)\s+wallet\b/.test(t);
}

export function asksForNewCampaign(text: unknown): boolean {
  if (typeof text !== "string" || text.length > 2000
    || /\b(don'?t|do not|never|not|if|why|whether|example|hypothetical)\b|["“”]|^\s*>/im.test(text)) return false;
  if (/\b(?:wallet|balance|top[ -]?up)\b/i.test(text)) return false;
  return /^(?:(?:please|pls)\s+|(?:can|could|would)\s+you\s+(?:please\s+)?|i\s+(?:want|need)\s+to\s+)?(?:create|start|launch|run|make|prepare|draft)\s+(?:(?:a|the)\s+)?(?:new|another|separate)\s+(?:chatgpt\s+)?(?:campaign|ad)\b/i.test(text.trim());
}
