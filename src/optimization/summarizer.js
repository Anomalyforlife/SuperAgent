// ============================================================
//  TOKEN OPTIMIZATION — Haiku-based output summarizer
//  Reduces downstream context tokens by ~70%
// ============================================================

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const SUMMARIZE_THRESHOLD = 600; // chars — skip summarization for short outputs

/**
 * Summarize an agent's output using Haiku (fast + cheap).
 * Returns { text, originalTokens, compressedTokens, compressionRatio }.
 */
export async function summarizeOutput(agentName, output, maxTokens = 380) {
  if (!output || output.length < SUMMARIZE_THRESHOLD) {
    const est = Math.ceil((output?.length ?? 0) / 4);
    return { text: output || "", originalTokens: est, compressedTokens: est, compressionRatio: 1 };
  }

  try {
    const inputSlice = output.slice(0, 12_000); // cap to avoid huge prompts to summarizer

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system:
        "You are a context compressor for a multi-agent AI system. Extract ONLY the information that downstream agents will need.",
      messages: [
        {
          role: "user",
          content: `Compress this ${agentName} agent output. Keep:
- Exact file paths created/modified
- Core technical decisions and specs (versions, configs, architecture)
- Vulnerabilities found (with location and severity)
- Errors or blockers
- Direct action items for the next agent

Remove: explanations, reasoning steps, verbose examples, already-implemented code.

Output to compress:
${inputSlice}`,
        },
      ],
    });

    const compressed = response.content[0].text;
    const originalTokens = response.usage?.input_tokens ?? Math.ceil(inputSlice.length / 4);
    const compressedTokens = response.usage?.output_tokens ?? Math.ceil(compressed.length / 4);

    return {
      text: compressed,
      originalTokens,
      compressedTokens,
      compressionRatio: compressedTokens / Math.max(originalTokens, 1),
    };
  } catch {
    // Graceful degradation: simple truncation
    const truncated = output.slice(0, 1_400);
    const origEst = Math.ceil(output.length / 4);
    const compEst = Math.ceil(truncated.length / 4);
    return {
      text: truncated + "\n\n[...riassunto non disponibile, troncato...]",
      originalTokens: origEst,
      compressedTokens: compEst,
      compressionRatio: compEst / Math.max(origEst, 1),
      fallback: true,
    };
  }
}
