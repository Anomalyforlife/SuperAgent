#!/usr/bin/env node
// ============================================================
//  SUPER-AGENT MCP SERVER v2.0
//  Each specialized agent is exposed as its own MCP tool so it
//  appears as a distinct subagent call in the Claude Code UI.
// ============================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { AGENTS } from "./src/agents.js";
import {
  callAgent,
  callAgentSafe,
  executePlan,
  formatOutput,
} from "./src/runner.js";
import {
  createSession,
  completeSession,
  failSession,
  listSessions,
} from "./src/orchestration/session.js";
import { WorkflowMetrics } from "./src/telemetry/metrics.js";

// ── Agent descriptions for tool metadata ─────────────────────────────────────
const AGENT_DESC = {
  programmer:       "Senior software engineer (15y). Writes clean, production-ready code. Integrates researcher/designer output.",
  cybersecurity:    "Security expert OSCP/CEH/CISSP. OWASP Top 10, Next.js, Stripe, Supabase, CVE scan. Red-team mindset.",
  web_researcher:   "Research specialist. Finds latest library versions, official docs via Context7, best practices, CVE data.",
  web_designer:     "UI/UX designer. Design systems, responsive layouts, WCAG 2.1, Tailwind, Figma-to-code.",
  tester:           "QA engineer. Unit/integration/e2e tests, bug reports, edge cases. Jest, Playwright, Cypress.",
  docs_writer:      "Technical writer. README, API docs, changelogs, inline docstrings in Markdown.",
  mobile_developer: "Mobile specialist. PWA, React Native, Flutter, iOS Swift, Android Kotlin. App-store submission.",
};

// ── Build individual tool definitions for each agent ─────────────────────────
const INDIVIDUAL_AGENT_TOOLS = Object.entries(AGENTS)
  .filter(([key]) => key !== "interpreter")
  .map(([key, agent]) => ({
    name: `${key}_agent`,
    description: `${agent.emoji} **${agent.name}** — ${AGENT_DESC[key] || agent.name}`,
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Task specifico per questo agente",
        },
        context: {
          type: "string",
          description: "Output di agenti precedenti da passare come contesto (opzionale)",
        },
        project_path: {
          type: "string",
          description: "Percorso assoluto del progetto (opzionale). L'agente opererà in questa directory.",
        },
      },
      required: ["task"],
    },
  }));

// ── Orchestration + utility tools ───────────────────────────────────────────
const ORCHESTRATION_TOOLS = [
  {
    name: "run_agents",
    description:
      "Orchestratore principale. Analizza la richiesta, pianifica gli agenti necessari ed esegue il workflow. " +
      "Funzionalità: summarization automatica (~70% token savings), feedback loops Programmer↔Security/Tester, " +
      "scoring per agente, session persistence, telemetria completa, execution graph.",
    inputSchema: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "La richiesta completa da elaborare",
        },
        project_path: {
          type: "string",
          description: "Percorso assoluto del progetto (opzionale)",
        },
        clarifications: {
          type: "string",
          description: "Risposte dell'utente alle domande chiarificatrici (opzionale, secondo giro)",
        },
        approved_plan: {
          type: "string",
          description: "Piano JSON approvato (opzionale, ultimo giro — avvia esecuzione)",
        },
        options: {
          type: "object",
          description: "Opzioni avanzate (opzionale)",
          properties: {
            skip_auto_security:   { type: "boolean", description: "Disabilita security auto-inject dopo programmer" },
            enable_summarization: { type: "boolean", description: "Abilita summarization Haiku (default: true)" },
            enable_feedback:      { type: "boolean", description: "Abilita feedback loops (default: true)" },
            enable_scoring:       { type: "boolean", description: "Abilita scoring output (default: true)" },
          },
        },
      },
      required: ["request"],
    },
  },
  {
    name: "call_single_agent",
    description:
      "Chiama un singolo agente direttamente, senza orchestrazione. " +
      "Preferisci i tool `{agent}_agent` per visibilità nativa in Claude Code.",
    inputSchema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          enum: ["programmer", "cybersecurity", "docs_writer", "web_researcher", "web_designer", "tester", "mobile_developer"],
          description: "Agente da chiamare",
        },
        task:         { type: "string" },
        context:      { type: "string" },
        project_path: { type: "string" },
      },
      required: ["agent", "task"],
    },
  },
  {
    name: "list_agents",
    description: "Mostra tutti gli agenti disponibili con specializzazioni, modelli e tool names.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "security_audit",
    description:
      "Security audit completo tramite l'agente Cybersecurity. " +
      "Analizza: OWASP Top 10, Next.js (CVE-2025-29927, Server Actions, NEXT_PUBLIC_), " +
      "Stripe (webhook sig, server-side pricing), Supabase (RLS, service role), Auth, General. " +
      "CVE scan su ogni dipendenza nel package.json. Output strutturato Critical/High/Medium/Low.",
    inputSchema: {
      type: "object",
      properties: {
        code:         { type: "string", description: "Codice sorgente da analizzare" },
        stack:        { type: "string", description: "Stack tecnologico (es. 'Next.js 15, Supabase, Stripe')" },
        focus:        { type: "string", description: "Area specifica (es. 'autenticazione', 'pagamenti')" },
        package_json: { type: "string", description: "Contenuto package.json per CVE scan (raccomandato)" },
        project_path: { type: "string", description: "Percorso progetto — l'agente leggerà i file direttamente" },
      },
    },
  },
  {
    name: "update_dependencies",
    description: "Analizza package.json, verifica versioni più recenti via web e aggiorna le dipendenze.",
    inputSchema: {
      type: "object",
      properties: {
        approved_plan: {
          type: "string",
          description: "Piano JSON approvato (opzionale, usato per avviare l'esecuzione)",
        },
      },
    },
  },
  {
    name: "list_sessions",
    description: "Mostra le ultime sessioni di workflow eseguite con status e ID.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Numero massimo di sessioni da mostrare (default: 10)" },
      },
    },
  },
];

const TOOLS = [...INDIVIDUAL_AGENT_TOOLS, ...ORCHESTRATION_TOOLS];

// ── MCP Server setup ─────────────────────────────────────────────────────────
const server = new Server(
  { name: "super-agent-system", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // ── Individual agent tools  ({agent}_agent) ──────────────────────────
    // Each becomes a visible, distinct tool call in Claude Code's UI.
    const agentMatch = name.match(/^([a-z_]+)_agent$/);
    if (agentMatch) {
      const agentKey = agentMatch[1];
      if (!AGENTS[agentKey] || agentKey === "interpreter") {
        return {
          content: [{ type: "text", text: `❌ Agente "${agentKey}" non trovato.` }],
          isError: true,
        };
      }

      const { task, context = "", project_path } = args;
      const agent = AGENTS[agentKey];

      console.error(`${agent.emoji} [${agent.name}] → ${task.slice(0, 100)}`);
      const t0 = Date.now();

      const result = await callAgentSafe(agentKey, task, context, project_path);

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const tokEst = Math.ceil(result.length / 4);

      return {
        content: [
          {
            type: "text",
            text: `## ${agent.emoji} ${agent.name}\n\n${result}\n\n---\n> ⏱ ${elapsed}s · ~${tokEst} output tokens`,
          },
        ],
      };
    }

    // ── list_agents ──────────────────────────────────────────────────────
    if (name === "list_agents") {
      const lines = Object.entries(AGENTS)
        .filter(([k]) => k !== "interpreter")
        .map(([key, agent]) => {
          const toolName = `\`${key}_agent\``;
          const model = agent.model?.includes("haiku") ? "Haiku 4.5 ⚡" : "Sonnet 4.6 🧠";
          const toolCount = agent.allowedTools?.length ?? 0;
          return `${agent.emoji} **${agent.name}** — tool: ${toolName} · ${model} · ${toolCount} tools\n  ${AGENT_DESC[key] || ""}`;
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: [
              "# Super-Agent System v2.0 — Agenti disponibili",
              "",
              "Ogni agente è esposto come tool MCP indipendente nella UI di Claude Code.",
              "",
              lines,
              "",
              "## Tool di orchestrazione",
              "- `run_agents` — workflow completo con planner + esecuzione parallela",
              "- `call_single_agent` — chiamata diretta a un agente",
              "- `security_audit` — audit sicurezza dedicato",
              "- `update_dependencies` — aggiornamento dipendenze",
              "- `list_sessions` — storico sessioni",
            ].join("\n"),
          },
        ],
      };
    }

    // ── call_single_agent ────────────────────────────────────────────────
    if (name === "call_single_agent") {
      const { agent: agentKey, task, context = "", project_path } = args;
      const agentInfo = AGENTS[agentKey];

      console.error(`🎯 Direct: ${agentInfo?.emoji} ${agentKey}`);
      const result = await callAgentSafe(agentKey, task, context, project_path);

      return {
        content: [{ type: "text", text: `## ${agentInfo?.emoji} ${agentInfo?.name}\n\n${result}` }],
      };
    }

    // ── run_agents ───────────────────────────────────────────────────────
    if (name === "run_agents") {
      const {
        request,
        clarifications,
        approved_plan,
        project_path,
        options: runOpts = {},
      } = args;

      const {
        skip_auto_security   = false,
        enable_summarization = true,
        enable_feedback      = true,
        enable_scoring       = true,
      } = runOpts;

      // ── GIRO 3: piano approvato → esecuzione ────────────────────────
      if (approved_plan) {
        let plan;
        try {
          plan = typeof approved_plan === "string" ? JSON.parse(approved_plan) : approved_plan;
        } catch {
          return { content: [{ type: "text", text: "❌ Piano non valido (JSON malformato)." }] };
        }

        const stepCount = plan.execution_plan.length;
        const secCount  = plan.execution_plan.filter((s) => s.agent === "programmer").length;
        const totalEst  = stepCount + (skip_auto_security ? 0 : secCount);

        console.error(`\n▶️  Avvio workflow: ${plan.agents_needed?.join(", ")}`);
        console.error(`📋 ${stepCount} step pianificati (+${secCount} security auto) = ~${totalEst} totali`);

        const session        = createSession({ plan, request, project_path });
        const workflowMetrics = new WorkflowMetrics(session.workflow_id);

        console.error(`🔑 Session: ${session.workflow_id}`);

        try {
          const results = await executePlan(plan, request, {
            skipAutoSecurity:    skip_auto_security,
            cwd:                 project_path,
            session,
            enableSummarization: enable_summarization,
            enableFeedback:      enable_feedback,
            enableScoring:       enable_scoring,
            workflowMetrics,
          });

          completeSession(session, workflowMetrics.toReport());
          const output = formatOutput(plan, results);
          return { content: [{ type: "text", text: output }] };
        } catch (err) {
          failSession(session, err);
          throw err;
        }
      }

      // ── GIRO 1/2: interpreta richiesta ──────────────────────────────
      const interpreterInput = clarifications
        ? `## Richiesta originale:\n${request}\n\n## Risposte dell'utente:\n${clarifications}`
        : request;

      console.error(`\n🧠 Analisi richiesta...`);
      const planRaw = await callAgent("interpreter", interpreterInput);

      let parsed;
      try {
        const cleaned = planRaw.replace(/```json\n?|\n?```/g, "").trim();
        parsed = JSON.parse(cleaned);
      } catch {
        return {
          content: [{ type: "text", text: `❌ JSON non valido dall'interpreter:\n\n${planRaw}` }],
        };
      }

      // Needs clarification → show questions
      if (parsed.needs_clarification) {
        const qLines = parsed.questions.map((q, i) => {
          const opts = q.options?.length ? `\n   Opzioni: ${q.options.join(" / ")}` : "";
          return `**${i + 1}. ${q.question}**\n   _(${q.why})_${opts}`;
        });

        return {
          content: [
            {
              type: "text",
              text: [
                "## 🧠 Chiarimenti necessari",
                "",
                `> ${parsed.note || "Alcune informazioni aggiuntive migliorano il piano."}`,
                "",
                `**Capito finora:** ${parsed.partial_understanding}`,
                "",
                ...qLines,
                "",
                "*Rispondi e richiama `run_agents` con il campo `clarifications`.*",
              ].join("\n"),
            },
          ],
        };
      }

      // Plan ready → show preview for approval
      const plan = parsed;
      const emojiMap = Object.fromEntries(Object.entries(AGENTS).map(([k, v]) => [k, v.emoji || "⚙️"]));
      const autoSecCount = plan.execution_plan.filter((s) => s.agent === "programmer").length;

      const stepLines = plan.execution_plan.map((s) => {
        const deps = s.depends_on.length > 0 ? ` *(dopo ${s.depends_on.join(", ")})* ` : " ";
        return `**Step ${s.step}** — ${emojiMap[s.agent] || "⚙️"} \`${s.agent}\`${deps}\n   → ${s.task}`;
      });

      return {
        content: [
          {
            type: "text",
            text: [
              "## 🧠 Piano proposto dall'Interpreter",
              "",
              `**Obiettivo:** ${plan.understanding}`,
              `**Output finale:** ${plan.final_output}`,
              "",
              `**Agenti:** ${plan.agents_needed.map((a) => `${emojiMap[a] || "⚙️"} ${a}`).join("  ·  ")}`,
              `**Step totali (incl. ${autoSecCount} security auto-inject):** ~${plan.execution_plan.length + autoSecCount}`,
              "",
              "### Step di esecuzione",
              "",
              ...stepLines,
              "",
              "---",
              "✅ **Per procedere**, richiama `run_agents` con gli stessi parametri e aggiungi:",
              "```",
              `approved_plan: ${JSON.stringify(plan)}`,
              "```",
              "❌ **Per modificare**, descrivi le modifiche e richiama `run_agents` con nuova richiesta.",
            ].join("\n"),
          },
        ],
      };
    }

    // ── security_audit ───────────────────────────────────────────────────
    if (name === "security_audit") {
      const { code, stack, focus, package_json, project_path } = args;

      if (!code && !project_path) {
        return {
          content: [{ type: "text", text: "❌ Fornisci `code` o `project_path`." }],
          isError: true,
        };
      }

      const focusLine = focus ? `\n\nArea di focus: **${focus}**` : "";
      const stackLine = stack ? `\nStack: **${stack}**` : "";
      const pkgSection = package_json
        ? `\n\n## package.json:\n\`\`\`json\n${package_json}\n\`\`\``
        : "";
      const cveNote = package_json
        ? "- **CVE scan**: cerca CVE su NIST NVD e GitHub Advisory per ogni dipendenza del package.json."
        : `- **CVE scan**: deduci dipendenze da stack/codice.${project_path ? " Usa Glob per trovare package.json." : ""}`;

      const codeSection = project_path
        ? `## Progetto:\nPath: ${project_path}\nUsa Glob/Read/Grep per esplorare il codice sorgente. Inizia con Glob per la struttura.`
        : `## Codice:\n\n${code}`;

      const task = [
        `Esegui security audit completo.${stackLine}${focusLine}`,
        "",
        "Per ogni vulnerabilità: livello rischio (Critical/High/Medium/Low), file+riga, scenario attacco, remediation con codice corretto.",
        "",
        "Controlla obbligatoriamente:",
        "- Next.js: Server Actions, NEXT_PUBLIC_, CVE-2025-29927, IDOR",
        "- Stripe: verifica firma webhook, prezzo server-side, success page, idempotency, chiavi esposte",
        "- Supabase: RLS, service role key, admin CRUD via client, anon key in .env.example",
        "- Auth: rate limiting, CSRF protection",
        "- General: error message leakage, logging in produzione, input validation",
        cveNote,
        "",
        "Report strutturato in:",
        "1. ## 🚨 Vulnerabilità nel codice (ordinato per rischio)",
        "2. ## 📦 CVE Scan Dipendenze",
        "3. ## 📊 Tabella riepilogativa",
        "",
        codeSection,
        pkgSection,
      ].join("\n");

      console.error("🔒 Security audit...");
      const result = await callAgentSafe("cybersecurity", task, "", project_path);

      return {
        content: [{ type: "text", text: `## 🔒 Security Audit Report\n\n${result}` }],
      };
    }

    // ── update_dependencies ──────────────────────────────────────────────
    if (name === "update_dependencies") {
      const { approved_plan } = args;
      const UPDATE_REQUEST =
        "Analizza il file package.json del progetto, usa web_researcher per trovare le versioni più recenti di ogni dipendenza su npm, poi aggiorna package.json con le versioni aggiornate ed esegui `npm install`. Riporta un riepilogo delle versioni precedenti e nuove.";

      if (approved_plan) {
        let plan;
        try {
          plan = typeof approved_plan === "string" ? JSON.parse(approved_plan) : approved_plan;
        } catch {
          return { content: [{ type: "text", text: "❌ Piano non valido." }] };
        }
        console.error("▶️  Aggiornamento dipendenze...");
        const results = await executePlan(plan, UPDATE_REQUEST);
        return { content: [{ type: "text", text: formatOutput(plan, results) }] };
      }

      console.error("🧠 Pianificazione aggiornamento...");
      const planRaw = await callAgent("interpreter", UPDATE_REQUEST);
      let parsed;
      try {
        parsed = JSON.parse(planRaw.replace(/```json\n?|\n?```/g, "").trim());
      } catch {
        return { content: [{ type: "text", text: `❌ JSON non valido: ${planRaw}` }] };
      }

      const emojiMap = Object.fromEntries(Object.entries(AGENTS).map(([k, v]) => [k, v.emoji || "⚙️"]));
      const stepLines = parsed.execution_plan.map((s) => {
        const deps = s.depends_on.length > 0 ? ` *(dopo ${s.depends_on.join(", ")})*` : "";
        return `**Step ${s.step}** — ${emojiMap[s.agent] || "⚙️"} \`${s.agent}\`${deps}\n   → ${s.task}`;
      });

      return {
        content: [
          {
            type: "text",
            text: [
              "## 📦 Piano aggiornamento dipendenze",
              "",
              `**Agenti:** ${parsed.agents_needed.map((a) => `${emojiMap[a] || "⚙️"} ${a}`).join("  ·  ")}`,
              "",
              ...stepLines,
              "",
              "---",
              "✅ Richiama `update_dependencies` con:",
              "```",
              `approved_plan: ${JSON.stringify(parsed)}`,
              "```",
            ].join("\n"),
          },
        ],
      };
    }

    // ── list_sessions ────────────────────────────────────────────────────
    if (name === "list_sessions") {
      const limit = args?.limit ?? 10;
      const sessions = listSessions(limit);

      if (sessions.length === 0) {
        return {
          content: [{ type: "text", text: "Nessuna sessione trovata in `.superagent/sessions/`." }],
        };
      }

      const rows = sessions.map((s) => {
        const icon = s.status === "completed" ? "✓" : s.status === "failed" ? "✗" : "◉";
        return `${icon} \`${s.workflow_id.slice(0, 8)}\` — ${s.status} — ${s.created_at}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `## 📂 Ultime sessioni\n\n${rows.join("\n")}`,
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: `Tool "${name}" non riconosciuto.` }],
      isError: true,
    };
  } catch (err) {
    console.error(`❌ Errore tool "${name}":`, err);
    return {
      content: [{ type: "text", text: `Errore: ${err.message}` }],
      isError: true,
    };
  }
});

// ── Server startup ───────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const toolNames = TOOLS.map((t) => t.name).join(", ");
  console.error("✅ Super-Agent MCP Server v2.0 avviato");
  console.error(`🛠  ${TOOLS.length} tools registrati: ${toolNames}`);
}

main().catch((err) => {
  console.error("Errore fatale:", err);
  process.exit(1);
});
