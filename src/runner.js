import { query } from "@anthropic-ai/claude-agent-sdk";
import { AGENTS } from "./agents.js";

const CONTEXT7_URL = "https://mcp.context7.com/mcp";
const MAX_CONTEXT_CHARS = 8000;

function truncateContext(context) {
  if (!context || context.length <= MAX_CONTEXT_CHARS) return context;
  const half = Math.floor(MAX_CONTEXT_CHARS / 2);
  return (
    context.slice(0, half) +
    "\n\n[... contesto troncato per ridurre i token ...]\n\n" +
    context.slice(-half)
  );
}

async function callAgent(agentKey, userMessage, context = "", cwd = undefined) {
  const agent = AGENTS[agentKey];
  if (!agent) throw new Error(`Agente "${agentKey}" non trovato`);

  const truncated = truncateContext(context);
  const fullMessage = truncated
    ? `## Contesto dagli agenti precedenti:\n${truncated}\n\n## Il tuo task:\n${userMessage}`
    : userMessage;

  const tools = [...(agent.allowedTools ?? [])];
  const hasTools = tools.length > 0 || agent.useContext7;

  const options = {
    systemPrompt: agent.systemPrompt,
    model: agent.model ?? "claude-sonnet-4-6",
    tools: tools,
    maxTurns: hasTools ? 15 : 1,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    persistSession: false,
  };

  if (cwd) options.cwd = cwd;

  if (agent.useContext7) {
    options.mcpServers = {
      context7: { type: "http", url: CONTEXT7_URL },
    };
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

async function executePlan(plan, originalRequest, { skipAutoSecurity = false, cwd = undefined } = {}) {
  const results = {};

  // Costruisci il piano espanso con security auto-inject
  const expandedPlan = [];
  let nextStep = 1;
  const stepRemap = {};

  for (const step of plan.execution_plan) {
    const remappedDepends = step.depends_on.map((d) => stepRemap[d] ?? d);
    const newStep = { ...step, step: nextStep, depends_on: remappedDepends };
    stepRemap[step.step] = nextStep;
    expandedPlan.push(newStep);
    nextStep++;

    if (!skipAutoSecurity && step.agent === "programmer") {
      const reviewStep = {
        step: nextStep,
        agent: "cybersecurity",
        task: `Revisiona il codice prodotto dal Programmer nello step precedente per il task: "${step.task}". Identifica vulnerabilità critiche e proponi remediation.`,
        depends_on: [nextStep - 1],
        _auto_injected: true,
      };
      expandedPlan.push(reviewStep);
      nextStep++;
    }
  }

  // Esecuzione: raggruppa gli step per wave in base alle dipendenze
  // Gli step senza dipendenze pendenti vengono eseguiti in parallelo
  const completed = new Set();

  while (completed.size < expandedPlan.length) {
    // Trova tutti gli step pronti (dipendenze soddisfatte, non ancora eseguiti)
    const ready = expandedPlan.filter(
      (s) => !completed.has(s.step) && s.depends_on.every((d) => completed.has(d))
    );

    if (ready.length === 0) {
      throw new Error("Dipendenze circolari o step non raggiungibili nel piano");
    }

    // Log degli step che partiranno in parallelo
    if (ready.length > 1) {
      const labels = ready.map((s) => `${AGENTS[s.agent]?.emoji || "⚙️"} ${s.agent}`).join(", ");
      console.error(`  ⚡ Esecuzione parallela: ${labels}`);
    }

    // Esegui in parallelo tutti gli step pronti
    await Promise.all(
      ready.map(async (step) => {
        const contextParts = step.depends_on
          .map((depStep) => {
            const depInfo = expandedPlan.find((s) => s.step === depStep);
            return depInfo
              ? `### Output di ${AGENTS[depInfo.agent]?.emoji || ""} ${depInfo.agent} (step ${depStep}):\n${results[depStep]}`
              : "";
          })
          .filter(Boolean);

        const context = contextParts.join("\n\n");
        const agent = AGENTS[step.agent];
        const label = step._auto_injected ? " [revisione sicurezza automatica]" : "";

        console.error(
          `  ${agent?.emoji || "⚙️"} Eseguendo step ${step.step}: ${step.agent} — ${step.task}${label}`
        );

        try {
          results[step.step] = await callAgent(step.agent, step.task, context, cwd);
        } catch (err) {
          results[step.step] = `[ERRORE nello step ${step.step}: ${err.message}]`;
        }

        completed.add(step.step);
      })
    );
  }

  results._expandedPlan = expandedPlan;
  return results;
}

function formatOutput(plan, results) {
  const lines = [
    `# 🧠 Piano di esecuzione: ${plan.understanding}`,
    `\n**Output atteso:** ${plan.final_output}\n`,
    "---",
  ];

  const stepsToRender = results._expandedPlan ?? plan.execution_plan;

  for (const step of stepsToRender) {
    const agent = AGENTS[step.agent];
    const label = step._auto_injected ? " *(revisione sicurezza automatica)*" : "";
    lines.push(
      `\n## ${agent?.emoji || "⚙️"} ${step.step}. ${agent?.name || step.agent}${label}`,
      `*Task: ${step.task}*\n`,
      results[step.step] || "_Nessun output_"
    );
  }

  return lines.join("\n");
}

export { callAgent, executePlan, formatOutput };
