import type { Embedder } from "../embedding/provider.js";
import type { VectorStore } from "../store/vector-store.js";

type MessageWithParts = {
  info: { role: string; id: string; [key: string]: unknown };
  parts: unknown[];
};

export interface SemanticResult {
  messageID: string;
  score: number;
}

export interface QueryEngine {
  search(
    sessionID: string,
    query: string,
    maxResults: number,
  ): Promise<SemanticResult[]>;
}

export function createQueryEngine(
  embedder: Embedder,
  store: VectorStore,
  minScore: number,
): QueryEngine {
  return {
    async search(
      sessionID: string,
      query: string,
      maxResults: number,
    ): Promise<SemanticResult[]> {
      if (query.length < 5) return [];

      const [queryVector] = await embedder.embed([query]);
      const results = await store.search(sessionID, queryVector, maxResults);

      return results
        .filter((r) => r.score >= minScore)
        .map((r) => ({
          messageID: r.record.messageID,
          score: r.score,
        }));
    },
  };
}

export function reorderMessages(
  messages: MessageWithParts[],
  relevant: SemanticResult[],
  options: {
    boostRecent: number;
  },
): MessageWithParts[] {
  const { boostRecent } = options;

  if (relevant.length === 0) return messages;

  const relevantMap = new Map<string, number>();
  for (const r of relevant) {
    relevantMap.set(r.messageID, r.score);
  }

  const recentCutoff = messages.length - boostRecent;
  const recent = messages.slice(recentCutoff);
  const older = messages.slice(0, recentCutoff);

  const sorted = [...older].sort((a, b) => {
    const scoreA = relevantMap.get(a.info.id) ?? 0;
    const scoreB = relevantMap.get(b.info.id) ?? 0;
    return scoreB - scoreA;
  });

  const relevantOlder = sorted.filter((m) => relevantMap.has(m.info.id));
  const irrelevantOlder = sorted.filter((m) => !relevantMap.has(m.info.id));

  return [...relevantOlder, ...irrelevantOlder, ...recent];
}
