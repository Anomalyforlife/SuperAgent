# 🤖 Super-Agent MCP System

Sistema super-agent specializzato per potenziare Claude Code con agenti esperti in domini specifici.

## Agenti disponibili

| Agente | Specializzazione |
|--------|-----------------|
| 🧠 Interpreter | Analizza la richiesta e crea il piano di esecuzione |
| 💻 Programmer | Senior software engineer, best practice, architetture |
| 🔒 Cybersecurity | Vulnerability assessment, OWASP, secure coding |
| 📄 Docs Writer | README, API docs, documentazione tecnica |
| 🔍 Web Researcher | Ricerche web reali, sintesi, fonti aggiornate |
| 🎨 Web Designer | UI/UX, HTML/CSS, accessibilità, responsive design |
| 🧪 Tester | Unit/integration testing, bug finding, edge cases |

## Installazione

```bash
# 1. Clona/scarica la cartella
cd super-agent-mcp

# 2. Installa le dipendenze
npm install

# 3. Crea il file .env
cp .env.example .env
# Modifica .env e inserisci la tua ANTHROPIC_API_KEY

# 4. Aggiungi a Claude Code (globale, disponibile in tutti i progetti)
claude mcp add --scope user super-agent -- node /percorso/assoluto/super-agent-mcp/index.js
```

> ⚠️ Sostituisci `/percorso/assoluto/` con il path reale della cartella sul tuo sistema.

## Tool disponibili in Claude Code

### `run_agents` — Workflow automatico
Analizza la richiesta, crea il piano e lo esegue con gli agenti giusti in catena.

```
Usa run_agents per: "Crea un'API REST con autenticazione JWT, documentala e trova eventuali vulnerabilità"
```

### `call_single_agent` — Agente singolo
Chiama un agente specifico direttamente.

```
Usa call_single_agent con agent=tester per analizzare questo codice: [codice]
```

### `list_agents` — Lista agenti
Mostra tutti gli agenti disponibili.

## Come funziona il workflow in catena

```
Richiesta utente
      │
      ▼
  🧠 Interpreter
  (crea il piano JSON)
      │
      ▼
  Step 1: web_researcher ──────────────────┐
  Step 2: programmer (usa output step 1) ──┤
  Step 3: cybersecurity (usa step 2)       │ risultati
  Step 4: tester (usa step 2)              │ in catena
  Step 5: docs_writer (usa step 2+3+4) ────┘
      │
      ▼
  Output finale formattato
```

## Esempio di output del piano (JSON interno)

```json
{
  "understanding": "creare un sistema di autenticazione sicuro",
  "agents_needed": ["web_researcher", "programmer", "cybersecurity", "tester", "docs_writer"],
  "execution_plan": [
    { "step": 1, "agent": "web_researcher", "task": "best practice JWT 2024", "depends_on": [] },
    { "step": 2, "agent": "programmer", "task": "implementa auth con JWT", "depends_on": [1] },
    { "step": 3, "agent": "cybersecurity", "task": "analizza vulnerabilità", "depends_on": [2] },
    { "step": 4, "agent": "tester", "task": "scrivi test unitari", "depends_on": [2] },
    { "step": 5, "agent": "docs_writer", "task": "documenta l'API", "depends_on": [2, 3] }
  ],
  "final_output": "implementazione JWT completa, sicura, testata e documentata"
}
```

## Aggiungere un nuovo agente

1. Apri `src/agents.js`
2. Aggiungi una nuova entry nell'oggetto `AGENTS`
3. Aggiungi il nuovo agente nell'enum del tool `call_single_agent` in `index.js`

```javascript
my_agent: {
  name: "My Agent",
  emoji: "🚀",
  systemPrompt: `Sei un esperto di...`,
  useWebSearch: false  // true se deve fare ricerche web
}
```

## Variabili d'ambiente

| Variabile | Descrizione |
|-----------|-------------|
| `ANTHROPIC_API_KEY` | La tua API key Anthropic (obbligatoria) |
