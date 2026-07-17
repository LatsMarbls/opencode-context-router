/**
 * Analytics — opt-in anonymous usage tracking.
 * When enabled, records skill load events to a local JSONL file.
 * No network calls. Data stays on disk for user inspection.
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ANALYTICS_DIR = join(homedir(), ".config", "opencode", "plugins", "context-routing");
const ANALYTICS_FILE = join(ANALYTICS_DIR, "analytics.jsonl");

export interface AnalyticsEvent {
  /** ISO timestamp */
  ts: string;
  /** Event type */
  type: "skill.loaded" | "skill.dropped" | "skill.evicted" | "session.created" | "session.deleted";
  /** Skill name (if applicable) */
  skill?: string;
  /** Trigger source */
  trigger?: string;
  /** Priority at time of event */
  priority?: number;
  /** Token estimate */
  tokens?: number;
  /** Session ID (hashed for privacy) */
  sessionHash?: string;
}

function hashSession(sessionID: string): string {
  // Simple hash — not cryptographic, just anonymizes
  let hash = 0;
  for (let i = 0; i < sessionID.length; i++) {
    const char = sessionID.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `s_${Math.abs(hash).toString(36)}`;
}

export function trackEvent(event: AnalyticsEvent): void {
  try {
    if (!existsSync(ANALYTICS_DIR)) {
      mkdirSync(ANALYTICS_DIR, { recursive: true });
    }
    appendFileSync(ANALYTICS_FILE, JSON.stringify(event) + "\n", "utf-8");
  } catch {
    // silently fail
  }
}

export function trackSkillLoaded(sessionID: string, skillName: string, trigger: string, priority: number, tokens: number): void {
  trackEvent({
    ts: new Date().toISOString(),
    type: "skill.loaded",
    skill: skillName,
    trigger,
    priority,
    tokens,
    sessionHash: hashSession(sessionID),
  });
}

export function trackSkillDropped(sessionID: string, skillName: string, priority: number, tokens: number): void {
  trackEvent({
    ts: new Date().toISOString(),
    type: "skill.dropped",
    skill: skillName,
    priority,
    tokens,
    sessionHash: hashSession(sessionID),
  });
}

export function trackSessionEvent(type: "session.created" | "session.deleted", sessionID: string): void {
  trackEvent({
    ts: new Date().toISOString(),
    type,
    sessionHash: hashSession(sessionID),
  });
}