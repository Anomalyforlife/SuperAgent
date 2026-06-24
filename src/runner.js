// ============================================================
//  RUNNER v2 — Orchestration engine with:
//  • Smart context window (summarized inputs)
//  • Retry + circuit breaker per agent
//  • Feedback loops (Programmer ↔ Security / Tester)
//  • Per-agent scoring + telemetry
//  • Session persistence (file-based checkpoints)
//  • Execution graph visualization
// ============================================================

import { query } from "@anthropic-ai/claude-agent-sdk";
import { AGENTS } from "./agents.js";
import { summarizeOutput } from "./optimization/summarizer.js";
import { buildSmartContext, computeSavings } from "./optimization/context.js";
import { WorkflowMetrics } from "./telemetry/metrics.js";
import { scoreOutput, formatScoreBadge } from "./telemetry/scoring.js";
import { buildExecutionGraph } from "./telemetry/graph.js";
import { CircuitBreaker, withRetry, getAgentTimeout } from "./resilience/retry.js";
import { checkpointStep } from "./orchestration/session.js";
import {
  FEEDBACK_RULES,
  needsFeedback,
  buildFeedbackTask,
  findReviewerStep,
} from "./orchestration/feedback.js";

const CONTEXT7_URL = "https://mcp.context7.com/mcp";

// Global circuit breakers per agent key
const CIRCUIT_BREAKERS = {};
function getCB(agentKey) {
  if (!CIRCUIT_BREAKERS[agentKey]) {
    CIRCUIT_BREAKERS[agentKey] = new CircuitBreaker(agentKey, 5, 60_000);
  }
  return CIRCUIT_BREAKERS[agentKey];
}

// Agent emoji helper
const agentEmoji = (key) => AGENTS[key]?.emoji || "⚙️";

// ── Low-level agent call (no resilience layer) ──────────────────────────────
export async function callAgent(agentKey, userMessage, context = "", cwd = undefined) {
  const agent = AGENTS[agentKey];
  if (!agent) throw new Error(`Agente "${agentKey}" non trovato`);

  const fullMessage = context
    ? `## Contesto dagli agenti precedenti:\n${context}\n\n## Il tuo task:\n${userMessage}`
    : userMessage;

  const tools = [...(agent.allowedTools ?? [])];
  const hasTools = tools.length > 0 || agent.useContext7;

  const options = {
    systemPrompt: agent.systemPrompt,
    model: agent.model ?? "claude-sonnet-4-6",
    tools,
    maxTurns: hasTools ? 15 : 1,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    persistSession: false,
  };

  if (cwd) options.cwd = cwd;
  if (agent.useContext7) {
    options.mcpServers = { context7: { type: "http", url: CONTEXT7_URL } };
  }

  let resultText = "";

  for await (const message of query({ prompt: fullMessage, options })) {
    if (message.type === "result") {
      if (message.subtype === "success") {
        resultText = message.result;
      } else {
        const errs = message.errors?.join(", ") ?? message.subtype;
        throw new Error(`[${agentKey}] Agent SDK error: ${errs}`);
      }
    }
  }

  return resultText;
}

// ── Resilient agent call (circuit breaker + exponential backoff) ────────────
export async function callAgentSafe(agentKey, userMessage, context = "", cwd = undefined, metricsRef = null) {
  const timeout = getAgentTimeout(agentKey);

  return getCB(agentKey).execute(() =>
    withRetry(() => callAgent(agentKey, userMessage, context, cwd), {
      maxAttempts: 3,
      baseDelay: 2_000,
      maxDelay: 20_000,
      timeout,
      onRetry: (attempt, err, delay) => {
        if (metricsRef) metricsRef.retries++;
        console.error(
          `  ↺ ${agentEmoji(agentKey)} ${agentKey}: retry ${attempt} in ${Math.round(delay / 1000)}s — ${err.message}`
        );
      },
    })
  );
}

// ── Expand plan: auto-inject cybersecurity after programmer steps only when security is in scope ──
export function buildExpandedPlan(plan, skipAutoSecurity = false) {
  const expanded = [];
  let cursor = 1;
  const remap = {};

  // Only auto-inject if the interpreter explicitly flagged cybersecurity as needed
  const securityInScope = !skipAutoSecurity && (plan.agents_needed ?? []).includes("cybersecurity");

  for (const step of plan.execution_plan) {
    const remappedDeps = step.depends_on.map((d) => remap[d] ?? d);
    const newStep = { ...step, step: cursor, depends_on: remappedDeps };
    remap[step.step] = cursor;
    expanded.push(newStep);
    cursor++;

    // Only auto-inject if security is in scope AND this step isn't already followed by an explicit cybersecurity step
    if (securityInScope && step.agent === "programmer") {
      const nextStep = plan.execution_plan.find((s) => s.depends_on.includes(step.step) && s.agent === "cybersecurity");
      if (!nextStep) {
        expanded.push({
          step: cursor,
          agent: "cybersecurity",
          task: `Revisiona il codice prodotto dal Programmer nello step precedente per il task: "${step.task}". Identifica vulnerabilità critiche, proponi remediation concrete.`,
          depends_on: [cursor - 1],
          _auto_injected: true,
        });
        cursor++;
      }
    }
  }

  return expanded;
}

// ── Main execution engine ────────────────────────────────────────────────────
export async function executePlan(plan, originalRequest, opts = {}) {
  const {
    skipAutoSecurity = false,
    cwd = undefined,
    session = null,
    enableSummarization = true,
    enableFeedback = true,
    enableScoring = true,
    workflowMetrics = null,
  } = opts;

  const results = {};
  const summaries = {};
  const scores = {};
  const stepStates = {};
  const stepDurationsMs = {};
  const stepTokens = {};
  const feedbackIterations = {}; // track per (producerStep, ruleId)

  const metrics = workflowMetrics || new WorkflowMetrics("local");
  const expandedPlan = buildExpandedPlan(plan, skipAutoSecurity);
  const emojiMap = Object.fromEntries(
    Object.entries(AGENTS).map(([k, v]) => [k, v.emoji || "⚙️"])
  );

  const completed = new Set();

  while (completed.size < expandedPlan.length) {
    // Collect steps whose dependencies are all satisfied
    const ready = expandedPlan.filter(
      (s) => !completed.has(s.step) && s.depends_on.every((d) => completed.has(d))
    );

    if (ready.length === 0) {
      throw new Error("Dipendenze circolari o step non raggiungibili nel piano.");
    }

    if (ready.length > 1) {
      const labels = ready.map((s) => `${agentEmoji(s.agent)} ${s.agent}`).join(", ");
      console.error(`  ⚡ Parallelo: ${labels}`);
    }

    // Execute wave in parallel
    await Promise.all(
      ready.map(async (step) => {
        const agent = AGENTS[step.agent];
        const tag = step._auto_injected ? " [sec-auto]" : "";
        stepStates[step.step] = "RUNNING";

        const agentM = metrics.createAgentMetrics(step.agent, agent?.name || step.agent, agent?.model);
        agentM.start();

        console.error(
          `  ${agentEmoji(step.agent)} Step ${step.step}: ${step.agent}${tag} — ${step.task.slice(0, 80)}`
        );

        // Smart context: use summaries when available
        const context = buildSmartContext(
          step.depends_on,
          results,
          summaries,
          expandedPlan,
          emojiMap
        );
        agentM.inputTokens = Math.ceil((context.length + step.task.length) / 4);

        try {
          const output = await callAgentSafe(step.agent, step.task, context, cwd, agentM);

          results[step.step] = output;
          agentM.complete(output);
          stepStates[step.step] = "COMPLETED";
          stepDurationsMs[step.step] = agentM.durationMs;
          stepTokens[step.step] = agentM.totalTokens;

          // Score
          if (enableScoring) {
            const score = scoreOutput(step.agent, output);
            scores[step.step] = score;
            agentM.score = score;
            console.error(
              `  📊 ${step.agent} — Q:${score.quality} S:${score.security} conf:${score.confidence}`
            );
          }

          // Summarize for downstream context efficiency
          if (enableSummarization) {
            const sr = await summarizeOutput(agent?.name || step.agent, output);
            summaries[step.step] = sr.text;
            metrics.trackSummarizer(sr.originalTokens, sr.compressedTokens);
            if (sr.originalTokens > 100) {
              const saved = Math.round((1 - sr.compressionRatio) * 100);
              console.error(
                `  📉 ${step.agent}: ${sr.originalTokens}→${sr.compressedTokens} tok (${saved}% saved)`
              );
            }
          }

          // Persist checkpoint
          if (session) {
            checkpointStep(session, step.step, output, summaries[step.step], scores[step.step]);
          }
        } catch (err) {
          results[step.step] = `[ERRORE step ${step.step} (${step.agent}): ${err.message}]`;
          agentM.fail(err);
          stepStates[step.step] = "FAILED";
          stepDurationsMs[step.step] = agentM.durationMs;
          console.error(`  ❌ Step ${step.step} fallito: ${err.message}`);
        }

        completed.add(step.step);
      })
    );

    // ── Feedback loops after each wave ────────────────────────────────────
    if (enableFeedback) {
      for (const rule of FEEDBACK_RULES) {
        // Find producer steps in the just-completed wave
        const producerSteps = ready.filter((s) => s.agent === rule.producer);

        for (const producerStep of producerSteps) {
          const reviewerStep = findReviewerStep(
            producerStep.step,
            expandedPlan,
            rule.reviewer
          );
          if (!reviewerStep || !completed.has(reviewerStep.step)) continue;

          const iterKey = `${producerStep.step}:${rule.id}`;
          const iteration = feedbackIterations[iterKey] || 0;
          const reviewerOutput = results[reviewerStep.step];

          if (needsFeedback(reviewerOutput, rule, iteration)) {
            console.error(
              `  🔄 Feedback loop [${rule.id}]: ${rule.reviewer} → ${rule.producer} (iter ${iteration + 1})`
            );
            feedbackIterations[iterKey] = iteration + 1;

            const feedbackTask = buildFeedbackTask(
              producerStep.task,
              reviewerOutput,
              iteration + 1
            );

            try {
              const corrected = await callAgentSafe(rule.producer, feedbackTask, "", cwd);
              results[producerStep.step] = corrected;

              if (enableScoring) {
                scores[producerStep.step] = scoreOutput(rule.producer, corrected);
              }
              if (enableSummarization) {
                const sr = await summarizeOutput(rule.producer, corrected);
                summaries[producerStep.step] = sr.text;
              }
              if (session) {
                checkpointStep(session, producerStep.step, corrected, summaries[producerStep.step], scores[producerStep.step]);
              }
              console.error(`  ✅ Feedback loop completato per step ${producerStep.step}`);
            } catch (err) {
              console.error(`  ❌ Feedback loop fallito: ${err.message}`);
            }
          }
        }
      }
    }
  }

  const savings = computeSavings(results, summaries);
  console.error(
    `  💰 Context savings: ${savings.fullTokens}→${savings.compressedTokens} tokens (${savings.pct}% riduzione)`
  );

  return {
    ...results,
    _expandedPlan: expandedPlan,
    _summaries: summaries,
    _scores: scores,
    _stepStates: stepStates,
    _stepDurationsMs: stepDurationsMs,
    _stepTokens: stepTokens,
    _metrics: metrics,
    _graph: buildExecutionGraph(expandedPlan, stepStates, stepDurationsMs, stepTokens),
  };
}

// ── Output formatter ─────────────────────────────────────────────────────────
export function formatOutput(plan, results) {
  const expandedPlan = results._expandedPlan ?? plan.execution_plan;
  const scores = results._scores || {};
  const metrics = results._metrics;
  const graph = results._graph || "";

  const lines = [
    `# 🧠 ${plan.understanding}`,
    `\n**Output atteso:** ${plan.final_output}\n`,
  ];

  if (graph) lines.push(graph);
  lines.push("---");

  for (const step of expandedPlan) {
    const agent = AGENTS[step.agent];
    const label = step._auto_injected ? " *(security auto)*" : "";

    lines.push(`\n## ${agentEmoji(step.agent)} ${step.step}. ${agent?.name || step.agent}${label}`);
    lines.push(`*Task: ${step.task}*\n`);
    lines.push(results[step.step] || "_Nessun output_");

    const score = scores[step.step];
    if (score) lines.push("\n" + formatScoreBadge(score));
  }

  // Telemetry block
  if (metrics) {
    lines.push("\n---\n## 📊 Telemetria");
    lines.push(metrics.formatSummary());
  }

  return lines.join("\n");
}
