// ============================================================
//  SMART CONTEXT WINDOW
//  Each agent receives ONLY what it needs — no full history
// ============================================================

/**
 * Build a focused context string for a given agent step.
 * Uses summaries (compressed) when available; falls back to full results.
 */
export function buildSmartContext(
  stepDependencies,
  results,
  summaries,
  expandedPlan,
  agentEmojis
) {
  if (!stepDependencies || stepDependencies.length === 0) return "";

  const parts = [];

  for (const depStep of stepDependencies) {
    const depInfo = expandedPlan.find((s) => s.step === depStep);
    if (!depInfo) continue;

    const emoji = agentEmojis[depInfo.agent] || "⚙️";
    const content = summaries[depStep] || results[depStep] || "_Nessun output disponibile_";

    parts.push(
      `### ${emoji} ${depInfo.agent} (step ${depStep}):\n${content}`
    );
  }

  return parts.join("\n\n");
}

/** Rough token estimation (4 chars ≈ 1 token) */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Compute token savings summary across a workflow */
export function computeSavings(results, summaries) {
  let fullTokens = 0;
  let compressedTokens = 0;

  for (const [step, text] of Object.entries(results)) {
    if (typeof text !== "string" || step.startsWith("_")) continue;
    fullTokens += estimateTokens(text);
    compressedTokens += estimateTokens(summaries[step] || text);
  }

  return {
    fullTokens,
    compressedTokens,
    saved: fullTokens - compressedTokens,
    pct: fullTokens > 0 ? Math.round(((fullTokens - compressedTokens) / fullTokens) * 100) : 0,
  };
}
