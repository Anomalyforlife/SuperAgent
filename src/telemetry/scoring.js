// ============================================================
//  AGENT OUTPUT SCORING — Heuristic-based, zero LLM cost
// ============================================================

/**
 * Score an agent's output on 5 dimensions (0-100).
 * Returns { quality, completeness, security, maintainability, confidence }
 */
export function scoreOutput(agentKey, output) {
  if (!output || typeof output !== "string") {
    return { quality: 0, completeness: 0, security: 50, maintainability: 0, confidence: 0 };
  }

  const lower = output.toLowerCase();
  const words = output.split(/\s+/).length;
  const hasCode = /```[\w]*\n[\s\S]+?```/.test(output);
  const hasHeaders = /^#{1,4} /m.test(output);

  // --- Completeness: based on output volume ---
  const completeness = Math.min(100, Math.round(words / 6));

  // --- Quality: structure + code + explanation ---
  let quality = 40;
  if (hasCode) quality += 25;
  if (hasHeaders) quality += 15;
  if (words > 100) quality += 10;
  if (words > 300) quality += 10;
  quality = Math.min(100, quality);

  // --- Security: depends on agent type and findings ---
  let security = 75;
  if (agentKey === "cybersecurity" || agentKey === "security_audit") {
    const criticals = (lower.match(/\bcritical\b/g) || []).length;
    const highs = (lower.match(/\bhigh\b/g) || []).length;
    const hasRemediation =
      lower.includes("remediation") ||
      lower.includes("fix") ||
      lower.includes("correggi") ||
      lower.includes("soluzione");

    if (criticals >= 3) security = hasRemediation ? 40 : 20;
    else if (criticals >= 1) security = hasRemediation ? 55 : 35;
    else if (highs >= 3) security = hasRemediation ? 62 : 50;
    else if (highs >= 1) security = hasRemediation ? 70 : 60;
    else security = 88;
  } else if (agentKey === "programmer") {
    // Penalize if programmer output contains obvious red flags
    const redFlags = [
      "eval(",
      "dangerouslysetinnerhtml",
      "exec(",
      "sql injection",
      "password in plain",
    ];
    const found = redFlags.filter((f) => lower.includes(f)).length;
    security = Math.max(40, 90 - found * 15);
  }

  // --- Maintainability: comments, types, structure ---
  let maintainability = 55;
  if (hasCode) {
    if (/\/\/|\/\*|#/.test(output)) maintainability += 15;
    if (/interface |type |: \w+[\[\{]/.test(output)) maintainability += 12;
    if (hasHeaders) maintainability += 8;
    maintainability = Math.min(100, maintainability);
  }

  // --- Confidence: uncertainty and error signals ---
  let confidence = 82;
  const uncertainTerms = ["might", "maybe", "possibly", "unclear", "forse", "potrebbe", "non sono sicuro"];
  const errorTerms = ["error", "failed", "unable", "cannot", "errore", "fallito"];
  const uncertainCount = uncertainTerms.filter((t) => lower.includes(t)).length;
  const errorCount = errorTerms.filter((t) => lower.includes(t)).length;

  confidence -= uncertainCount * 5;
  confidence -= errorCount * 8;
  confidence = Math.max(10, Math.min(100, confidence));

  return {
    quality: Math.round(quality),
    completeness: Math.round(completeness),
    security: Math.round(security),
    maintainability: Math.round(maintainability),
    confidence: Math.round(confidence),
  };
}

const icon = (v) => (v >= 85 ? "🟢" : v >= 65 ? "🟡" : v >= 45 ? "🟠" : "🔴");

export function formatScoreBadge(score) {
  if (!score) return "";
  return (
    `> ${icon(score.quality)} Q:${score.quality} ` +
    `${icon(score.completeness)} C:${score.completeness} ` +
    `${icon(score.security)} S:${score.security} ` +
    `${icon(score.confidence)} conf:${score.confidence}`
  );
}

export function scoreTable(score) {
  if (!score) return "";
  return [
    `| Metrica | Score |`,
    `|---------|-------|`,
    `| Quality | ${icon(score.quality)} ${score.quality}/100 |`,
    `| Completeness | ${icon(score.completeness)} ${score.completeness}/100 |`,
    `| Security | ${icon(score.security)} ${score.security}/100 |`,
    `| Maintainability | ${icon(score.maintainability)} ${score.maintainability}/100 |`,
    `| Confidence | ${icon(score.confidence)} ${score.confidence}/100 |`,
  ].join("\n");
}
