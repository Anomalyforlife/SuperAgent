# Super-Agent MCP System

MCP server che potenzia Claude Code con agenti specializzati in pipeline. Usa il Claude Agent SDK — nessuna API key separata richiesta.

## Agenti disponibili

| Agente | Modello | Strumenti |
|--------|---------|-----------|
| 🧠 Interpreter | Sonnet 4.6 | — |
| 💻 Programmer | Sonnet 4.6 | — |
| 🔒 Cybersecurity | Sonnet 4.6 | WebSearch, WebFetch |
| 📱 Mobile Developer | Sonnet 4.6 | — |
| 🔍 Web Researcher | Haiku 4.5 | WebSearch, WebFetch, Context7 |
| 🎨 Web Designer | Haiku 4.5 | — |
| 🧪 Tester | Haiku 4.5 | — |
| 📄 Docs Writer | Haiku 4.5 | — |

## Installazione

```bash
cd super-agent-mcp
npm install
```

Aggiungi a Claude Code:

```bash
claude mcp add --scope user super-agent -- node /percorso/assoluto/super-agent-mcp/index.js
```

## Tool MCP disponibili

### `run_agents` — Workflow automatico
L'interpreter analizza la richiesta, pianifica gli step e li esegue in catena con gli agenti giusti. Dopo ogni step del Programmer viene iniettato automaticamente un controllo Cybersecurity.

### `call_single_agent` — Agente singolo
Chiama un agente specifico direttamente.

### `list_agents` — Lista agenti
Mostra tutti gli agenti disponibili con le loro caratteristiche.

### `update_dependencies` — Aggiorna dipendenze
Aggiorna il sistema super-agent all'ultima versione.

### `security_audit` — Audit di sicurezza
Esegue un'analisi di vulnerabilità su codice o file di progetto.

## Come funziona

```
Richiesta utente
      │
      ▼
  🧠 Interpreter (crea il piano JSON)
      │
      ▼
  Step 1 → Step 2 → Step 3 → ...
  (ogni step può dipendere dall'output dei precedenti)
      │
      ▼
  Output finale formattato in Markdown
```

Dopo ogni step di tipo `programmer`, il sistema inietta automaticamente uno step `cybersecurity` per la revisione del codice.

## Aggiungere un nuovo agente

1. Apri `src/agents.js`
2. Aggiungi una nuova entry nell'oggetto `AGENTS`
3. Aggiungi il nome nell'enum del tool `call_single_agent` in `index.js`

```javascript
my_agent: {
  name: "My Agent",
  emoji: "🚀",
  model: "claude-sonnet-4-6",
  systemPrompt: `Sei un esperto di...`,
  useWebSearch: false,
  useWebFetch: false,
  useContext7: false,
}
```
