// ============================================================
//  FEEDBACK LOOPS — Automatic quality cycles between agents
//  Programmer ↔ Security   (score threshold: 72)
//  Programmer ↔ Tester     (score threshold: 68)
// ============================================================

const MAX_FEEDBACK_ITERATIONS = 3;

// Each rule defines a producer → reviewer pair with threshold and iteration cap
export const FEEDBACK_RULES = [
  {
    id: "security-review",
    producer: "programmer",
    reviewer: "cybersecurity",
    metric: "security",
    threshold: 72,
    maxIterations: MAX_FEEDBACK_ITERATIONS,
  },
  {
    id: "test-review",
    producer: "programmer",
    reviewer: "tester",
    metric: "quality",
    threshold: 68,
    maxIterations: 2,
  },
];

/**
 * Decide whether to trigger a feedback loop.
 * @param {string} reviewerOutput — text output of the reviewer agent
 * @param {object} rule           — FEEDBACK_RULES entry
 * @param {number} iteration      — current iteration count (starts at 0)
 */
export function needsFeedback(reviewerOutput, rule, iteration = 0) {
  if (iteration >= rule.maxIterations) return false;
  if (!reviewerOutput) return false;

  const score = extractRiskScore(reviewerOutput, rule.metric);
  return score < rule.threshold;
}

/**
 * Heuristic: derive a 0-100 risk score from reviewer output text.
 */
export function extractRiskScore(text, metric) {
  if (!text) return 100;
  const lower = text.toLowerCase();

  const criticals = (lower.match(/\bcritical\b/g) || []).length;
  const highs = (lower.match(/\bhigh\b/g) || []).length;
  const mediums = (lower.match(/\bmedium\b/g) || []).length;
  const bugs = (lower.match(/\bbug\b|\berror\b|\bfail\b|\bbroken\b|\bissue\b/g) || []).length;

  if (metric === "security") {
    if (criticals >= 3) return 22;
    if (criticals >= 1) return 48;
    if (highs >= 3) return 58;
    if (highs >= 1) return 67;
    if (mediums >= 3) return 74;
    return 88;
  }

  // quality / general
  if (bugs >= 5) return 38;
  if (bugs >= 3) return 55;
  if (bugs >= 1) return 72;
  if (criticals >= 1) return 45;
  return 82;
}

/**
 * Build the feedback task for the producer agent.
 * Incorporates the reviewer's findings as mandatory corrections.
 */
export function buildFeedbackTask(originalTask, reviewerOutput, iteration) {
  const iterLabel = iteration > 1 ? ` (iterazione ${iteration})` : "";
  return `## Task originale${iterLabel}:
${originalTask}

## ⚠️ Feedback obbligatorio dal revisore — CORREGGI TUTTO:
${reviewerOutput.slice(0, 4_000)}

## Istruzioni:
- Risolvi TUTTI i problemi segnalati prima di procedere.
- Non lasciare vulnerabilità critiche o bug gravi irrisolti.
- Se il revisore ha proposto codice corretto, usalo come base.
- Mostra esplicitamente ogni correzione applicata.`;
}

/** Find the reviewer step in the plan that follows a given producer step. */
export function findReviewerStep(producerStepNum, expandedPlan, reviewerAgent) {
  return expandedPlan.find(
    (s) =>
      s.agent === reviewerAgent &&
      s.depends_on.includes(producerStepNum)
  );
}
