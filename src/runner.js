import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AGENTS } from "./agents.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CONTEXT7_URL = "https://mcp.context7.com/mcp";

// Max characters of context passed between steps — prevents ballooning costs
const MAX_CONTEXT_CHARS = 8000;

// Singleton Context7 client — reused across all agent calls
let _c7Client = null;
let _c7Tools = null;

function mcpToolToAnthropic(tool) {
  return {
    name: tool.name,
    description: tool.description || "",
    input_schema: tool.inputSchema,
  };
}

async function getContext7Client() {
  if (_c7Client) return { client: _c7Client, tools: _c7Tools };
  const c7 = new Client({ name: "superagent-context7", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(CONTEXT7_URL));
  await c7.connect(transport);
  const { tools } = await c7.listTools();
  _c7Client = c7;
  _c7Tools = tools.map(mcpToolToAnthropic);
  return { client: _c7Client, tools: _c7Tools };
}

// Wraps a system prompt string with cache_control so Anthropic caches it
function cachedSystem(prompt) {
  return [{ type: "text", text: prompt, cache_control: { type: "ephemeral" } }];
}

// Truncates context to avoid sending huge accumulated outputs
function truncateContext(context) {
  if (!context || context.length <= MAX_CONTEXT_CHARS) return context;
  const half = Math.floor(MAX_CONTEXT_CHARS / 2);
  return (
    context.slice(0, half) +
    "\n\n[... contesto troncato per ridurre i token ...]\n\n" +
    context.slice(-half)
  );
}

// Per-agent max_tokens — avoids over-allocating for simpler agents
function getMaxTokens(agentKey) {
  const limits = {
    interpreter: 1024,
    docs_writer: 2048,
    tester: 2048,
    web_designer: 3072,
    web_researcher: 2048,
  };
  return limits[agentKey] ?? 4096;
}

/**
 * Chiama un agente che usa Context7 (e opzionalmente web_search) con agentic loop.
 */
async function callAgentWithContext7(agentKey, agent, userMessage, context) {
  const truncated = truncateContext(context);
  const fullMessage = truncated
    ? `## Contesto dagli agenti precedenti:\n${truncated}\n\n## Il tuo task:\n${userMessage}`
    : userMessage;

  const { client: c7, tools: c7Tools } = await getContext7Client();

  const tools = [
    ...(agent.useWebSearch ? [{ type: "web_search_20250305", name: "web_search" }] : []),
    ...c7Tools,
  ];

  const messages = [{ role: "user", content: fullMessage }];
  let finalText = "";

  while (true) {
    const response = await client.messages.create({
      model: agent.model ?? "claude-sonnet-4-6",
      max_tokens: getMaxTokens(agentKey),
      system: cachedSystem(agent.systemPrompt),
      messages,
      tools,
      betas: ["prompt-caching-2024-07-31"],
    });

    const textBlocks = response.content.filter((b) => b.type === "text");
    if (textBlocks.length > 0) {
      finalText = textBlocks.map((b) => b.text).join("\n");
    }

    const toolUseBlocks = response.content.filter(
      (b) => b.type === "tool_use" && b.name !== "web_search"
    );

    if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) break;

    messages.push({ role: "assistant", content: response.content });

    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        try {
          const result = await c7.callTool({ name: block.name, arguments: block.input });
          const text = result.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          return { type: "tool_result", tool_use_id: block.id, content: text };
        } catch (err) {
          return {
            type: "tool_result",
            tool_use_id: block.id,
            content: `Errore Context7: ${err.message}`,
            is_error: true,
          };
        }
      })
    );

    messages.push({ role: "user", content: toolResults });
  }

  return finalText;
}

/**
 * Chiama un singolo agente con il suo system prompt e un messaggio.
 */
async function callAgent(agentKey, userMessage, context = "") {
  const agent = AGENTS[agentKey];
  if (!agent) throw new Error(`Agente "${agentKey}" non trovato`);

  if (agent.useContext7) {
    return callAgentWithContext7(agentKey, agent, userMessage, context);
  }

  const truncated = truncateContext(context);
  const fullMessage = truncated
    ? `## Contesto dagli agenti precedenti:\n${truncated}\n\n## Il tuo task:\n${userMessage}`
    : userMessage;

  const tools = agent.useWebSearch
    ? [{ type: "web_search_20250305", name: "web_search" }]
    : undefined;

  const requestBody = {
    model: agent.model ?? "claude-sonnet-4-6",
    max_tokens: getMaxTokens(agentKey),
    system: cachedSystem(agent.systemPrompt),
    messages: [{ role: "user", content: fullMessage }],
    betas: ["prompt-caching-2024-07-31"],
  };
  if (tools) requestBody.tools = tools;

  const response = await client.messages.create(requestBody);

  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Esegue il piano prodotto dall'interpreter, rispettando le dipendenze.
 * @param {Object} plan - output JSON dell'interpreter
 * @param {string} originalRequest - richiesta originale dell'utente
 * @param {Object} [options]
 * @param {boolean} [options.skipAutoSecurity=false] - disabilita l'iniezione automatica di cybersecurity
 * @returns {Promise<Object>} - risultati di ogni step
 */
async function executePlan(plan, originalRequest, { skipAutoSecurity = false } = {}) {
  const results = {};

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

  for (const step of expandedPlan) {
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
      results[step.step] = await callAgent(step.agent, step.task, context);
    } catch (err) {
      results[step.step] = `[ERRORE nello step ${step.step}: ${err.message}]`;
    }
  }

  results._expandedPlan = expandedPlan;
  return results;
}

/**
 * Formatta l'output finale combinando tutti i risultati.
 */
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
