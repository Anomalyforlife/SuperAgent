// ============================================================
//  SESSION PERSISTENCE — File-based workflow state store
// ============================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

const SESSIONS_BASE = join(process.cwd(), ".superagent", "sessions");

function sessionsDir() {
  if (!existsSync(SESSIONS_BASE)) mkdirSync(SESSIONS_BASE, { recursive: true });
  return SESSIONS_BASE;
}

function sessionPath(workflowId) {
  return join(sessionsDir(), `${workflowId}.json`);
}

/** Create a new session and persist it. Returns the session object. */
export function createSession(workflowData) {
  const session = {
    workflow_id: randomUUID(),
    session_id: randomUUID(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "running",
    workflow: workflowData,
    results: {},
    summaries: {},
    scores: {},
    metrics: { total_tokens: 0, total_cost: 0, steps_completed: 0, steps_failed: 0 },
    checkpoints: [],
  };

  _write(session);
  return session;
}

/** Persist the current session state. */
export function saveSession(session) {
  session.updated_at = new Date().toISOString();
  _write(session);
}

/** Load a session by workflow_id. Returns null if not found. */
export function loadSession(workflowId) {
  const path = sessionPath(workflowId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Save a completed step into the session.
 * Called after each agent finishes.
 */
export function checkpointStep(session, stepNumber, result, summary, score) {
  session.results[stepNumber] = result;
  if (summary !== undefined) session.summaries[stepNumber] = summary;
  if (score !== undefined) session.scores[stepNumber] = score;

  session.metrics.steps_completed++;
  session.checkpoints.push({
    step: stepNumber,
    timestamp: new Date().toISOString(),
    tokens_estimate: Math.ceil((result?.length ?? 0) / 4),
  });

  saveSession(session);
}

/** Mark the session as completed with final metrics. */
export function completeSession(session, finalMetrics) {
  session.status = "completed";
  session.completed_at = new Date().toISOString();
  session.final_metrics = finalMetrics;
  saveSession(session);
}

/** Mark the session as failed. */
export function failSession(session, err) {
  session.status = "failed";
  session.failed_at = new Date().toISOString();
  session.error = err?.message ?? String(err);
  saveSession(session);
}

/** List the last N sessions (sorted by creation time, newest first). */
export function listSessions(limit = 20) {
  try {
    const files = readdirSync(sessionsDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const s = JSON.parse(readFileSync(join(SESSIONS_BASE, f), "utf-8"));
          return { workflow_id: s.workflow_id, status: s.status, created_at: s.created_at };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);
    return files;
  } catch {
    return [];
  }
}

function _write(session) {
  writeFileSync(sessionPath(session.workflow_id), JSON.stringify(session, null, 2));
}
