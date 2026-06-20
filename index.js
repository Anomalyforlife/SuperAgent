#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { AGENTS } from "./src/agents.js";
import { callAgent, executePlan, formatOutput } from "./src/runner.js";

const TOOLS = [
  {
    name: "run_agents",
    description:
      "Analizza la richiesta, crea un piano con gli agenti specializzati necessari (programmer, cybersecurity, docs_writer, web_researcher, web_designer, tester, mobile_developer) ed esegue il workflow in modo automatico. Se la richiesta non è sufficientemente chiara, l'interpreter farà domande chiarificatrici prima di procedere. In quel caso, richiama il tool passando le risposte nel campo `clarifications`.",
    inputSchema: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "La richiesta completa da elaborare con il sistema super-agent",
        },
        project_path: {
          type: "string",
          description: "Percorso assoluto della directory del progetto su cui lavorare (opzionale). Gli agenti useranno questo come working directory e potranno leggere/modificare i file localmente.",
        },
        clarifications: {
          type: "string",
          description: "Risposte dell'utente alle domande chiarificatrici dell'interpreter (opzionale, usato nel secondo giro dopo che l'interpreter ha chiesto chiarimenti)",
        },
        approved_plan: {
          type: "string",
          description: "Il piano JSON approvato dall'utente (opzionale, usato nell'ultimo giro per avviare l'esecuzione dopo la preview)",
        },
      },
      required: ["request"],
    },
  },
  {
    name: "call_single_agent",
    description:
      "Chiama un singolo agente specializzato direttamente, senza passare per l'interpreter. Utile quando sai già quale agente ti serve.",
    inputSchema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          enum: ["programmer", "cybersecurity", "docs_writer", "web_researcher", "web_designer", "tester", "mobile_developer"],
          description: "L'agente da chiamare",
        },
        task: {
          type: "string",
          description: "Il task specifico per l'agente",
        },
        context: {
          type: "string",
          description: "Contesto opzionale da passare all'agente (es. codice già scritto, ricerche precedenti)",
        },
        project_path: {
          type: "string",
          description: "Percorso assoluto della directory del progetto su cui lavorare (opzionale). L'agente userà questo come working directory e potrà leggere/modificare i file localmente.",
        },
      },
      required: ["agent", "task"],
    },
  },
  {
    name: "list_agents",
    description: "Mostra tutti gli agenti disponibili con le loro specializzazioni",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "update_dependencies",
    description:
      "Fa analizzare al sistema super-agent le dipendenze del progetto, verifica le versioni più recenti tramite web_researcher e aggiorna package.json e node_modules tramite programmer.",
    inputSchema: {
      type: "object",
      properties: {
        approved_plan: {
          type: "string",
          description: "Il piano JSON approvato (opzionale, usato per avviare l'esecuzione dopo la preview)",
        },
      },
    },
  },
  {
    name: "security_audit",
    description:
      "Esegue un audit di sicurezza completo sul codice fornito usando l'agente cybersecurity. Analizza vulnerabilità OWASP, problemi specifici di Next.js, Supabase, Stripe, autenticazione, rate limiting, CSRF, esposizione dati sensibili e altro. Restituisce un report strutturato con livelli di rischio (Critical/High/Medium/Low) e remediation concrete.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Il codice sorgente da analizzare (incolla uno o più file rilevanti)",
        },
        stack: {
          type: "string",
          description: "Stack tecnologico del progetto (es. 'Next.js 15, Supabase, Stripe, Zustand')",
        },
        focus: {
          type: "string",
          description: "Area specifica su cui concentrare l'analisi (opzionale, es. 'autenticazione', 'pagamenti', 'admin routes')",
        },
        package_json: {
          type: "string",
          description: "Contenuto del package.json (opzionale ma consigliato: abilita il CVE scan automatico su tutte le dipendenze)",
        },
        project_path: {
          type: "string",
          description: "Percorso assoluto della directory del progetto (opzionale). Se fornito, l'agente cybersecurity leggerà direttamente i file sorgente senza che tu debba incollarli. Può essere usato insieme a 'code' o in alternativa.",
        },
      },
      required: [],
    },
  },
];

// ============================================================
//  MCP SERVER SETUP
// ============================================================

const server = new Server(
  { name: "super-agent-system", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // ── Tool: list_agents ──────────────────────────────────
    if (name === "list_agents") {
      const list = Object.entries(AGENTS)
        .filter(([key]) => key !== "interpreter")
        .map(([key, agent]) => `${agent.emoji} **${agent.name}** (\`${key}\`)`)
        .join("\n");

      return {
        content: [{ type: "text", text: `# Agenti disponibili\n\n${list}` }],
      };
    }

    // ── Tool: call_single_agent ────────────────────────────
    if (name === "call_single_agent") {
      const { agent, task, context, project_path } = args;
      const agentInfo = AGENTS[agent];

      console.error(`🎯 Chiamata diretta a ${agentInfo?.emoji} ${agent}${project_path ? ` (cwd: ${project_path})` : ""}`);
      const result = await callAgent(agent, task, context || "", project_path);

      return {
        content: [
          {
            type: "text",
            text: `## ${agentInfo?.emoji} ${agentInfo?.name}\n\n${result}`,
          },
        ],
      };
    }

    // ── Tool: run_agents (orchestrated) ───────────────────
    if (name === "run_agents") {
      const { request, clarifications, approved_plan, project_path } = args;

      // GIRO 3: l'utente ha approvato il piano → eseguilo direttamente
      if (approved_plan) {
        let plan;
        try {
          plan = typeof approved_plan === "string" ? JSON.parse(approved_plan) : approved_plan;
        } catch {
          return {
            content: [{ type: "text", text: `❌ Il piano approvato non è un JSON valido.` }],
          };
        }

        console.error(`▶️  Piano approvato, esecuzione in corso...${project_path ? ` (cwd: ${project_path})` : ""}`);
        console.error(`📋 ${plan.execution_plan.length} step con agenti: ${plan.agents_needed.join(", ")}`);

        const results = await executePlan(plan, request, { cwd: project_path });
        const output = formatOutput(plan, results);
        return { content: [{ type: "text", text: output }] };
      }

      // Componi il messaggio per l'interpreter: richiesta originale + eventuali risposte
      const interpreterInput = clarifications
        ? `## Richiesta originale:\n${request}\n\n## Risposte dell'utente alle domande chiarificatrici:\n${clarifications}`
        : request;

      console.error(`\n🧠 Analisi della richiesta in corso...`);

      // GIRO 1/2: l'interpreter valuta se ha abbastanza info o fa domande
      const planRaw = await callAgent("interpreter", interpreterInput);

      let parsed;
      try {
        const cleaned = planRaw.replace(/```json\n?|\n?```/g, "").trim();
        parsed = JSON.parse(cleaned);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `❌ L'interpreter non ha prodotto un JSON valido:\n\n${planRaw}`,
            },
          ],
        };
      }

      // GIRO 1: l'interpreter ha bisogno di chiarimenti → mostra le domande
      if (parsed.needs_clarification) {
        const questionLines = parsed.questions.map((q, i) => {
          const opts = q.options && q.options.length > 0
            ? `\n   Opzioni: ${q.options.join(" / ")}`
            : "";
          return `**${i + 1}. ${q.question}**\n   _(${q.why})_${opts}`;
        });

        const clarificationText = [
          `## 🧠 Interpreter — Chiarimenti necessari`,
          ``,
          `> ${parsed.note || "Ho bisogno di alcune informazioni per creare il piano migliore."}`,
          ``,
          `**Ho capito finora:** ${parsed.partial_understanding}`,
          ``,
          `**Rispondi a queste domande, poi richiama \`run_agents\` passando le risposte nel campo \`clarifications\`:**`,
          ``,
          ...questionLines,
        ].join("\n");

        return { content: [{ type: "text", text: clarificationText }] };
      }

      // GIRO 2: l'interpreter ha il piano → mostralo per approvazione
      const plan = parsed;
      const agentEmojis = {
        programmer: "💻", cybersecurity: "🔒", docs_writer: "📄",
        web_researcher: "🔍", web_designer: "🎨", tester: "🧪", mobile_developer: "📱",
      };

      const stepLines = plan.execution_plan.map((s) => {
        const emoji = agentEmojis[s.agent] || "⚙️";
        const deps = s.depends_on.length > 0 ? ` _(dopo step ${s.depends_on.join(", ")})_` : "";
        return `**Step ${s.step}** — ${emoji} \`${s.agent}\`${deps}\n   → ${s.task}`;
      });

      const previewText = [
        `## 🧠 Piano proposto dall'Interpreter`,
        ``,
        `**Obiettivo:** ${plan.understanding}`,
        `**Output finale:** ${plan.final_output}`,
        ``,
        `**Agenti coinvolti:** ${plan.agents_needed.map((a) => `${agentEmojis[a] || "⚙️"} ${a}`).join("  ·  ")}`,
        ``,
        `### Step di esecuzione`,
        ``,
        ...stepLines,
        ``,
        `---`,
        `✅ **Se vuoi procedere**, richiama \`run_agents\` con gli stessi parametri e aggiungi:`,
        `\`\`\``,
        `approved_plan: ${JSON.stringify(plan)}`,
        `\`\`\``,
        `❌ **Per modificare il piano**, descrivi cosa vuoi cambiare e richiama \`run_agents\` con una nuova richiesta.`,
      ].join("\n");

      return { content: [{ type: "text", text: previewText }] };
    }

    // ── Tool: security_audit ──────────────────────────────
    if (name === "security_audit") {
      const { code, stack, focus, package_json, project_path } = args;

      if (!code && !project_path) {
        return {
          content: [{ type: "text", text: `❌ Fornisci almeno uno tra \`code\` (codice da analizzare) e \`project_path\` (percorso del progetto).` }],
          isError: true,
        };
      }

      const focusLine = focus ? `\n\nArea di focus richiesta: **${focus}**` : "";
      const stackLine = stack ? `\nStack tecnologico: **${stack}**` : "";
      const pkgSection = package_json
        ? `\n\n## package.json (usa questo per il CVE scan):\n\`\`\`json\n${package_json}\n\`\`\``
        : "";
      const cveInstruction = package_json
        ? `- **CVE scan**: per ogni dipendenza nel package.json esegui una ricerca web per CVE note. Usa web_search e web_fetch su NIST NVD e GitHub Advisory Database. Riporta CVE ID, CVSS score, versione affetta, fixed-in e comando di aggiornamento.`
        : `- **CVE scan**: non è stato fornito un package.json. Se riesci a dedurre le dipendenze dallo stack o dal codice, cerca comunque CVE per i framework principali rilevati.${project_path ? " Usa Glob per trovare il package.json nel progetto e leggilo." : ""}`;

      const codeSection = project_path
        ? `## Progetto da analizzare:\nPercorso: ${project_path}\nUsa i tool Read, Glob e Grep per esplorare autonomamente il codice sorgente. Inizia con Glob per ottenere la struttura dei file, poi leggi i file più rilevanti per la sicurezza (route, auth, pagamenti, API, config).`
        : `## Codice da analizzare:\n\n${code}`;

      const task = [
        `Esegui un security audit completo.${stackLine}${focusLine}`,
        ``,
        `Per ogni vulnerabilità trovata:`,
        `- Indica il livello di rischio: Critical / High / Medium / Low`,
        `- Cita il file e il numero di riga specifico quando possibile`,
        `- Spiega come un attaccante potrebbe sfruttarla`,
        `- Fornisci la remediation concreta con codice corretto`,
        ``,
        `Verifica obbligatoriamente (se applicabile allo stack):`,
        `- Next.js: Server Actions esposte, variabili NEXT_PUBLIC_, CVE-2025-29927, IDOR`,
        `- Stripe: verifica firma webhook, prezzo server-side, success page, idempotency, chiavi esposte`,
        `- Supabase: RLS mancante, service role key, admin CRUD via client, anon key in .env.example`,
        `- Auth: rate limiting, CSRF protection`,
        `- General: error message leakage, logging in produzione, input validation`,
        cveInstruction,
        ``,
        `Struttura il report con queste sezioni:`,
        `1. ## 🚨 Vulnerabilità nel codice (ordinate per rischio)`,
        `2. ## 📦 CVE Scan Dipendenze`,
        `3. ## 📊 Tabella riepilogativa`,
        ``,
        codeSection,
        pkgSection,
      ].join("\n");

      console.error(`🔒 Security audit in corso...${project_path ? ` (cwd: ${project_path})` : ""}`);
      const result = await callAgent("cybersecurity", task, "", project_path);

      return {
        content: [
          {
            type: "text",
            text: `## 🔒 Security Audit Report\n\n${result}`,
          },
        ],
      };
    }

    // ── Tool: update_dependencies ─────────────────────────
    if (name === "update_dependencies") {
      const { approved_plan } = args;

      const UPDATE_REQUEST =
        "Analizza il file package.json del progetto, usa web_researcher per trovare le versioni più recenti di ogni dipendenza su npm, poi aggiorna package.json con le versioni aggiornate ed esegui `npm install` per installare i pacchetti. Riporta un riepilogo delle versioni precedenti e nuove.";

      if (approved_plan) {
        let plan;
        try {
          plan = typeof approved_plan === "string" ? JSON.parse(approved_plan) : approved_plan;
        } catch {
          return {
            content: [{ type: "text", text: `❌ Il piano approvato non è un JSON valido.` }],
          };
        }

        console.error(`▶️  Aggiornamento dipendenze in corso...`);
        const results = await executePlan(plan, UPDATE_REQUEST);
        const output = formatOutput(plan, results);
        return { content: [{ type: "text", text: output }] };
      }

      console.error(`\n🧠 Pianificazione aggiornamento dipendenze...`);
      const planRaw = await callAgent("interpreter", UPDATE_REQUEST);

      let parsed;
      try {
        const cleaned = planRaw.replace(/```json\n?|\n?```/g, "").trim();
        parsed = JSON.parse(cleaned);
      } catch {
        return {
          content: [{ type: "text", text: `❌ L'interpreter non ha prodotto un JSON valido:\n\n${planRaw}` }],
        };
      }

      const agentEmojis = {
        programmer: "💻", cybersecurity: "🔒", docs_writer: "📄",
        web_researcher: "🔍", web_designer: "🎨", tester: "🧪", mobile_developer: "📱",
      };

      const stepLines = parsed.execution_plan.map((s) => {
        const emoji = agentEmojis[s.agent] || "⚙️";
        const deps = s.depends_on.length > 0 ? ` _(dopo step ${s.depends_on.join(", ")})_` : "";
        return `**Step ${s.step}** — ${emoji} \`${s.agent}\`${deps}\n   → ${s.task}`;
      });

      const previewText = [
        `## 📦 Piano aggiornamento dipendenze`,
        ``,
        `**Obiettivo:** ${parsed.understanding}`,
        `**Output finale:** ${parsed.final_output}`,
        ``,
        `**Agenti coinvolti:** ${parsed.agents_needed.map((a) => `${agentEmojis[a] || "⚙️"} ${a}`).join("  ·  ")}`,
        ``,
        `### Step di esecuzione`,
        ``,
        ...stepLines,
        ``,
        `---`,
        `✅ **Per procedere**, richiama \`update_dependencies\` con:`,
        `\`\`\``,
        `approved_plan: ${JSON.stringify(parsed)}`,
        `\`\`\``,
      ].join("\n");

      return { content: [{ type: "text", text: previewText }] };
    }

    return {
      content: [{ type: "text", text: `Tool "${name}" non riconosciuto.` }],
      isError: true,
    };
  } catch (err) {
    console.error(`❌ Errore nel tool "${name}":`, err);
    return {
      content: [{ type: "text", text: `Errore: ${err.message}` }],
      isError: true,
    };
  }
});

// ============================================================
//  AVVIO
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("✅ Super-Agent MCP Server avviato");
}

main().catch((err) => {
  console.error("Errore fatale:", err);
  process.exit(1);
});
