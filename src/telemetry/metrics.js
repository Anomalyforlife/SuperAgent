// ============================================================
//  TELEMETRY — Per-agent and workflow-level metrics
// ============================================================

// Pricing per 1M tokens (USD) — update as needed
const PRICING = {
  "claude-sonnet-4-6":        { input: 3.00,  output: 15.00 },
  "claude-haiku-4-5-20251001": { input: 0.80,  output: 4.00  },
  "claude-haiku-4-5":          { input: 0.80,  output: 4.00  },
  default:                     { input: 3.00,  output: 15.00 },
};

export class AgentMetrics {
  constructor(agentKey, agentName, model) {
    this.agentKey = agentKey;
    this.agentName = agentName;
    this.model = model || "claude-sonnet-4-6";
    this.startTime = null;
    this.endTime = null;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.retries = 0;
    this.status = "PENDING";
    this.score = null;
    this.error = null;
  }

  start() {
    this.status = "RUNNING";
    this.startTime = Date.now();
  }

  complete(outputText) {
    this.status = "COMPLETED";
    this.endTime = Date.now();
    if (outputText) {
      this.outputTokens = Math.ceil(outputText.length / 4);
    }
  }

  fail(err) {
    this.status = "FAILED";
    this.endTime = Date.now();
    this.error = err?.message ?? String(err);
  }

  get durationMs() {
    if (!this.startTime) return 0;
    return (this.endTime ?? Date.now()) - this.startTime;
  }

  get estimatedCostUSD() {
    const rates = PRICING[this.model] ?? PRICING.default;
    return (
      (this.inputTokens / 1_000_000) * rates.input +
      (this.outputTokens / 1_000_000) * rates.output
    );
  }

  get totalTokens() {
    return this.inputTokens + this.outputTokens;
  }

  toJSON() {
    return {
      agent: this.agentKey,
      model: this.model,
      status: this.status,
      duration_ms: this.durationMs,
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      total_tokens: this.totalTokens,
      estimated_cost_usd: this.estimatedCostUSD.toFixed(5),
      retries: this.retries,
      score: this.score,
      error: this.error,
    };
  }
}

export class WorkflowMetrics {
  constructor(workflowId) {
    this.workflowId = workflowId;
    this.startTime = Date.now();
    this.agentMetrics = [];
    this.summarizerInputTokens = 0;
    this.summarizerOutputTokens = 0;
  }

  createAgentMetrics(agentKey, agentName, model) {
    const m = new AgentMetrics(agentKey, agentName, model);
    this.agentMetrics.push(m);
    return m;
  }

  trackSummarizer(originalTokens, compressedTokens) {
    this.summarizerInputTokens += originalTokens;
    this.summarizerOutputTokens += compressedTokens;
  }

  get totalInputTokens() {
    return this.agentMetrics.reduce((s, m) => s + m.inputTokens, 0) + this.summarizerInputTokens;
  }

  get totalOutputTokens() {
    return this.agentMetrics.reduce((s, m) => s + m.outputTokens, 0) + this.summarizerOutputTokens;
  }

  get totalTokens() {
    return this.totalInputTokens + this.totalOutputTokens;
  }

  get totalCostUSD() {
    const agentCost = this.agentMetrics.reduce((s, m) => s + m.estimatedCostUSD, 0);
    const summCost =
      (this.summarizerInputTokens / 1_000_000) * PRICING["claude-haiku-4-5-20251001"].input +
      (this.summarizerOutputTokens / 1_000_000) * PRICING["claude-haiku-4-5-20251001"].output;
    return agentCost + summCost;
  }

  get elapsedMs() {
    return Date.now() - this.startTime;
  }

  toReport() {
    return {
      workflow_id: this.workflowId,
      execution_time_ms: this.elapsedMs,
      total_input_tokens: this.totalInputTokens,
      total_output_tokens: this.totalOutputTokens,
      total_tokens: this.totalTokens,
      total_cost_usd: this.totalCostUSD.toFixed(4),
      agents_used: this.agentMetrics.map((m) => m.toJSON()),
      summarizer: {
        input_tokens: this.summarizerInputTokens,
        output_tokens: this.summarizerOutputTokens,
        cost_usd: (
          (this.summarizerInputTokens / 1_000_000) * PRICING["claude-haiku-4-5-20251001"].input +
          (this.summarizerOutputTokens / 1_000_000) * PRICING["claude-haiku-4-5-20251001"].output
        ).toFixed(5),
      },
    };
  }

  formatSummary() {
    const r = this.toReport();
    const successCount = this.agentMetrics.filter((m) => m.status === "COMPLETED").length;
    const failCount = this.agentMetrics.filter((m) => m.status === "FAILED").length;

    return [
      `| Metrica | Valore |`,
      `|---------|--------|`,
      `| Token totali | ~${r.total_tokens.toLocaleString()} |`,
      `| Costo stimato | $${r.total_cost_usd} |`,
      `| Tempo esecuzione | ${(r.execution_time_ms / 1000).toFixed(1)}s |`,
      `| Agenti completati | ${successCount} ✓ · ${failCount} ✗ |`,
      `| Token summarizer | ${r.summarizer.input_tokens} → ${r.summarizer.output_tokens} |`,
    ].join("\n");
  }
}
