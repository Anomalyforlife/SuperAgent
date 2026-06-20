# Super-Agent MCP System v2.0

MCP server che trasforma Claude Code in una piattaforma professionale di agent orchestration. Ogni agente è un tool MCP indipendente, visibile come subagent separato nella UI di Claude Code. Usa il Claude Agent SDK — nessuna API key separata richiesta.

## Funzionalità v2

- **Subagent visibili** — ogni agente esposto come tool MCP indipendente (`programmer_agent`, `cybersecurity_agent`, ecc.)
- **Token optimization** — summarization automatica con Haiku dopo ogni step (~70% di riduzione nei token di contesto)
- **Feedback loops** — cicli automatici Programmer ↔ Cybersecurity e Programmer ↔ Tester con soglie di qualità configurabili
- **Session persistence** — ogni workflow salvato in `.superagent/sessions/` con checkpoint per step
- **Scoring euristico** — quality, completeness, security, maintainability, confidence per ogni output (zero costo LLM)
- **Telemetria completa** — token, costo stimato, durata e retry per agente, più execution graph ASCII
- **Resilienza** — circuit breaker per agente, retry con exponential backoff + jitter, timeout per tipo di agente

## Agenti disponibili

| Agente | Tool MCP | Modello | Strumenti |
|--------|----------|---------|-----------|
| 🧠 Interpreter | *(interno)* | Sonnet 4.6 | — |
| 💻 Programmer | `programmer_agent` | Sonnet 4.6 | Read, Glob, Grep, Edit, Write, Bash |
| 🔒 Cybersecurity | `cybersecurity_agent` | Sonnet 4.6 | Read, Glob, Grep, WebSearch, WebFetch |
| 📱 Mobile Developer | `mobile_developer_agent` | Sonnet 4.6 | Read, Glob, Grep, Edit, Write, Bash |
| 🔍 Web Researcher | `web_researcher_agent` | Haiku 4.5 | WebSearch, WebFetch, Context7 |
| 🎨 Web Designer | `web_designer_agent` | Haiku 4.5 | Read, Glob, Grep, Edit, Write |
| 🧪 Tester | `tester_agent` | Haiku 4.5 | Read, Glob, Grep, Bash |
| 📄 Docs Writer | `docs_writer_agent` | Haiku 4.5 | Read, Glob, Grep, Edit, Write |

## Installazione

```bash
cd SuperAgent
npm install
```

Aggiungi a Claude Code:

```bash
claude mcp add --scope user super-agent -- node /percorso/assoluto/SuperAgent/index.js
```

## Tool MCP disponibili

### Tool agente diretto — `{agent}_agent`

Ogni agente è disponibile come tool indipendente. Questi appaiono come chiamate distinte nella UI di Claude Code, rendendo ogni subagent visibile e tracciabile.

```
programmer_agent(task, context?, project_path?)
cybersecurity_agent(task, context?, project_path?)
web_researcher_agent(task, context?, project_path?)
web_designer_agent(task, context?, project_path?)
tester_agent(task, context?, project_path?)
docs_writer_agent(task, context?, project_path?)
mobile_developer_agent(task, context?, project_path?)
```

### `run_agents` — Workflow orchestrato

L'interpreter analizza la richiesta, crea il piano e lo esegue con parallelizzazione wave-based. Include summarization, feedback loops, scoring e telemetria.

**Parametri:**
- `request` — la richiesta da elaborare
- `project_path` — percorso assoluto del progetto (opzionale)
- `clarifications` — risposte alle domande dell'interpreter (secondo giro)
- `approved_plan` — piano JSON approvato (ultimo giro, avvia esecuzione)
- `options.skip_auto_security` — disabilita la security auto-inject dopo ogni programmer step
- `options.enable_summarization` — abilita/disabilita la Haiku summarization (default: `true`)
- `options.enable_feedback` — abilita/disabilita i feedback loops (default: `true`)
- `options.enable_scoring` — abilita/disabilita lo scoring output (default: `true`)

**Flusso a tre giri:**

```
Giro 1 → run_agents(request)
         L'interpreter risponde con domande O con il piano
         
Giro 2 → run_agents(request, clarifications?)
         Piano mostrato per approvazione
         
Giro 3 → run_agents(request, approved_plan=...)
         Esecuzione workflow completa
```

### `security_audit` — Audit di sicurezza

Analisi approfondita tramite l'agente Cybersecurity su: OWASP Top 10, Next.js (CVE-2025-29927, Server Actions esposte, `NEXT_PUBLIC_`), Stripe (firma webhook, prezzo server-side), Supabase (RLS, service role key), autenticazione, rate limiting, CSRF. CVE scan automatico su tutte le dipendenze del `package.json`.

```
security_audit(code?, stack?, focus?, package_json?, project_path?)
```

### `update_dependencies` — Aggiorna dipendenze

Analizza `package.json`, verifica le versioni più recenti via web e aggiorna.

### `list_sessions` — Storico sessioni

Mostra le ultime sessioni di workflow con status e ID. I file JSON sono in `.superagent/sessions/`.

### `call_single_agent` — Agente singolo (legacy)

Chiama un agente direttamente. Preferire i tool `{agent}_agent` per la visibilità nella UI.

### `list_agents` — Lista agenti

Mostra tutti gli agenti con modello, tool name e descrizione.

## Architettura

```
index.js                        MCP Server v2 (13 tools)
src/
├── agents.js                   Definizioni agenti
├── runner.js                   Orchestration engine
├── optimization/
│   ├── summarizer.js           Compressione Haiku (~70% token savings)
│   └── context.js              Smart context window
├── orchestration/
│   ├── feedback.js             Loop automatici Programmer↔Security/Tester
│   └── session.js              Persistenza JSON per workflow
├── telemetry/
│   ├── metrics.js              Token/costo/durata per agente
│   ├── scoring.js              Scoring euristico (zero LLM)
│   └── graph.js                Execution graph ASCII
└── resilience/
    └── retry.js                CircuitBreaker + withRetry + timeout
```

### Flusso di esecuzione

```
run_agents(approved_plan)
    │
    ▼
createSession() → .superagent/sessions/{id}.json
    │
    ▼
buildExpandedPlan()           ← auto-inject cybersecurity dopo ogni programmer
    │
    ▼
Wave 1: step senza dipendenze → Promise.all()
    │  ├─ callAgentSafe() [circuit breaker + retry]
    │  ├─ scoreOutput()   [scoring euristico]
    │  ├─ summarizeOutput() [Haiku compression]
    │  └─ checkpointStep() [salva su disco]
    │
    ▼
Feedback check: score < threshold? → re-run con feedback
    │
    ▼
Wave 2, 3... → ripeti
    │
    ▼
formatOutput() → Markdown con execution graph + telemetria
```

### Feedback loops

```
Programmer
    │
    ▼
Cybersecurity ──── score < 72? ──→ buildFeedbackTask() ──→ Programmer (max 3 iter)
                                                               │
                                                               ▼
                                                          score ≥ 72 → ✅ Approved

Programmer
    │
    ▼
Tester ──── score < 68? ──→ buildFeedbackTask() ──→ Programmer (max 2 iter)
```

### Token optimization

```
Agent output (es. 1200 token)
        │
        ▼
summarizeOutput() con Haiku 4.5
        │
        ▼
Summary (es. 280 token)   ← passato agli agenti successivi
        │
        ▼
Saving: ~77% per step downstream
```

Il costo del summarizer Haiku è ~10x inferiore a Sonnet. Il ROI è positivo da 2+ agenti in pipeline.

### Resilienza

| Meccanismo | Configurazione |
|------------|---------------|
| CircuitBreaker | Apre dopo 5 fallimenti, reset dopo 60 s |
| Retry backoff | 2 s → 4 s → 8 s ± jitter, max 3 tentativi |
| Timeout Interpreter | 60 s |
| Timeout Web Researcher / Designer | 180 s |
| Timeout Programmer / Cybersecurity / Mobile | 360 s |

## Aggiungere un nuovo agente

1. Apri `src/agents.js` e aggiungi una entry nell'oggetto `AGENTS`
2. L'MCP server lo espone automaticamente come `{key}_agent` in `index.js`

```javascript
my_agent: {
  name: "My Agent",
  emoji: "🚀",
  model: "claude-sonnet-4-6",
  allowedTools: ["Read", "Glob", "Grep"],
  systemPrompt: `Sei un esperto di...`,
}
```

## Session files

Ogni workflow produce un file JSON in `.superagent/sessions/`:

```json
{
  "workflow_id": "uuid",
  "status": "completed",
  "results": { "1": "...", "2": "..." },
  "summaries": { "1": "summary compressa..." },
  "scores": { "1": { "quality": 85, "security": 90, "confidence": 78 } },
  "checkpoints": [{ "step": 1, "timestamp": "...", "tokens_estimate": 340 }],
  "final_metrics": { "total_tokens": 4820, "total_cost_usd": "0.0312" }
}
```

Consulta lo storico con `list_sessions` o ispeziona i file direttamente.
