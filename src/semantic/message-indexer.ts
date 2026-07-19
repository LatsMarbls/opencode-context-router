import type { Embedder } from "../embedding/provider.js";
import type { VectorStore, VectorRecord } from "../store/vector-store.js";
import { extractTextFromParts } from "./text-extractor.js";
import type { Part } from "@opencode-ai/sdk";

let messageCounter = 0;

function makeId(sessionID: string, messageID: string): string {
  return `${sessionID}:${messageID}:${++messageCounter}`;
}

export interface MessageIndexer {
  indexMessage(
    sessionID: string,
    parts: Part[],
    messageID: string,
    role: string,
  ): Promise<void>;
  indexMessages(
    sessionID: string,
    messages: Array<{
      info: { role: string; id: string; [key: string]: unknown };
      parts: Part[];
    }>,
  ): Promise<void>;
}

export function createMessageIndexer(
  embedder: Embedder,
  store: VectorStore,
): MessageIndexer {
  const indexed = new Set<string>();

  return {
    async indexMessage(
      sessionID: string,
      parts: Part[],
      messageID: string,
      role: string,
    ): Promise<void> {
      const key = `${sessionID}:${messageID}`;
      if (indexed.has(key)) return;

      const text = extractTextFromParts(parts);
      if (text.length < 10) return;

      const [vector] = await embedder.embed([text]);
      const record: VectorRecord = {
        id: makeId(sessionID, messageID),
        sessionID,
        messageID,
        text: text.slice(0, 2000),
        vector,
        role,
        timestamp: Date.now(),
      };

      await store.upsert([record]);
      indexed.add(key);
    },

    async indexMessages(
      sessionID: string,
      messages: Array<{
        info: { role: string; id: string; [key: string]: unknown };
        parts: Part[];
      }>,
    ): Promise<void> {
      const toIndex: Array<{ text: string; msg: (typeof messages)[0] }> = [];

      for (const msg of messages) {
        const key = `${sessionID}:${msg.info.id}`;
        if (indexed.has(key)) continue;

        const text = extractTextFromParts(msg.parts);
        if (text.length < 10) continue;

        toIndex.push({ text, msg });
      }

      if (toIndex.length === 0) return;

      const texts = toIndex.map((t) => t.text.slice(0, 8000));
      const vectors = await embedder.embed(texts);

      const records: VectorRecord[] = toIndex.map((t, i) => ({
        id: makeId(sessionID, t.msg.info.id),
        sessionID,
        messageID: t.msg.info.id,
        text: t.text.slice(0, 2000),
        vector: vectors[i],
        role: t.msg.info.role,
        timestamp: Date.now(),
      }));

      await store.upsert(records);

      for (const t of toIndex) {
        indexed.add(`${sessionID}:${t.msg.info.id}`);
      }
    },
  };
}
