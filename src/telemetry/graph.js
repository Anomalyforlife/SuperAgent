// ============================================================
//  EXECUTION GRAPH — ASCII visualization of workflow state
// ============================================================

const STATE_ICON = {
  PENDING:   "○",
  RUNNING:   "◉",
  COMPLETED: "✓",
  FAILED:    "✗",
  RETRYING:  "↺",
  SKIPPED:   "⊘",
};

const AGENT_EMOJI = {
  interpreter:       "🧠",
  programmer:        "💻",
  cybersecurity:     "🔒",
  web_researcher:    "🔍",
  web_designer:      "🎨",
  tester:            "🧪",
  docs_writer:       "📄",
  mobile_developer:  "📱",
};

/**
 * Build a text-based execution graph.
 * @param {Array}  expandedPlan   — list of step objects {step, agent, depends_on, _auto_injected}
 * @param {Object} stepStates     — { [step]: 'COMPLETED' | 'FAILED' | ... }
 * @param {Object} stepDurationsMs — { [step]: number }
 * @param {Object} stepTokens     — { [step]: number }
 */
export function buildExecutionGraph(
  expandedPlan,
  stepStates = {},
  stepDurationsMs = {},
  stepTokens = {}
) {
  const levels = buildLevels(expandedPlan);
  const lines = ["", "```", "Execution Graph"];

  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const isLastLevel = i === levels.length - 1;

    if (i > 0) {
      // Connector lines between levels
      const connectors = level.map(() => "  │  ").join("");
      lines.push(connectors);
    }

    // Build row for this parallel wave
    const rowParts = level.map((step) => {
      const state = stepStates[step.step] || "PENDING";
      const si = STATE_ICON[state] || "○";
      const emoji = AGENT_EMOJI[step.agent] || "⚙️";
      const dur = stepDurationsMs[step.step]
        ? `${(stepDurationsMs[step.step] / 1000).toFixed(1)}s`
        : "";
      const tok = stepTokens[step.step]
        ? `~${stepTokens[step.step]}tk`
        : "";
      const autoTag = step._auto_injected ? "[sec]" : "";
      const meta = [dur, tok].filter(Boolean).join(" ");
      return `${si}${emoji}${step.agent}#${step.step}${autoTag}${meta ? `(${meta})` : ""}`;
    });

    if (level.length === 1) {
      lines.push(`  ${rowParts[0]}`);
    } else {
      // Parallel wave
      lines.push(`  ┌─── ${rowParts.join("  │  ")} ───┐`);
      lines.push(`  │    Parallel execution (${level.length} agents)    │`);
      lines.push(`  └${"─".repeat(Math.max(30, rowParts.join("  │  ").length + 8))}┘`);
    }
  }

  lines.push("```", "");
  return lines.join("\n");
}

function buildLevels(plan) {
  const levels = [];
  const processed = new Set();

  while (processed.size < plan.length) {
    const ready = plan.filter(
      (s) => !processed.has(s.step) && s.depends_on.every((d) => processed.has(d))
    );
    if (ready.length === 0) break;
    levels.push(ready);
    ready.forEach((s) => processed.add(s.step));
  }

  return levels;
}

/** Summarize which agents ran and in how many waves */
export function graphSummary(expandedPlan, stepStates) {
  const levels = buildLevels(expandedPlan);
  const completed = Object.values(stepStates).filter((s) => s === "COMPLETED").length;
  const failed = Object.values(stepStates).filter((s) => s === "FAILED").length;
  const maxParallel = Math.max(...levels.map((l) => l.length), 1);

  return { waves: levels.length, completed, failed, maxParallel };
}
