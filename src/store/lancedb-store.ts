import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  VectorStore,
  VectorRecord,
  SearchResult,
} from "./vector-store.js";

const STORE_DIR = join(
  homedir(),
  ".config",
  "opencode",
  "plugins",
  "context-routing",
  ".vector-store",
);

let lancedb: any = null;
let lancedbReady = false;

async function loadLancedb(): Promise<void> {
  if (lancedbReady) return;
  const mod = await import("@lancedb/lancedb");
  lancedb = mod;
  lancedbReady = true;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function createLanceStore(
  projectDir: string,
): Promise<VectorStore> {
  await loadLancedb();

  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true });
  }

  const dbName = `ctx_${Buffer.from(projectDir)
    .toString("base64url")
    .slice(0, 16)}`;
  const dbPath = join(STORE_DIR, dbName);
  const db = await lancedb.connect(dbPath);

  const TABLE_NAME = "messages";

  async function getOrCreateTable(): Promise<any> {
    const tables: string[] = await db.tableNames();
    if (tables.includes(TABLE_NAME)) {
      return db.openTable(TABLE_NAME);
    }
    // LanceDB needs schema or seed row — provide minimal seed
    const seed = [{
      id: "__schema_seed__",
      sessionID: "",
      messageID: "",
      text: "",
      vector: new Array(384).fill(0),
      role: "",
      timestamp: 0,
    }];
    const table = await db.createTable(TABLE_NAME, seed, { existOk: true });
    // Delete the seed row
    try { await table.delete("id = '__schema_seed__'"); } catch {}
    return table;
  }

  return {
    async upsert(records: VectorRecord[]): Promise<void> {
      if (records.length === 0) return;
      const table = await getOrCreateTable();

      for (const record of records) {
        try {
          await table.delete(
            `messageID = '${record.messageID}' AND sessionID = '${record.sessionID}'`,
          );
        } catch {
          // ignore delete errors (row may not exist)
        }
      }

      const rows = records.map((r) => ({
        id: r.id,
        sessionID: r.sessionID,
        messageID: r.messageID,
        text: r.text.slice(0, 2000),
        vector: r.vector,
        role: r.role,
        timestamp: r.timestamp,
      }));

      await table.add(rows, { mode: "append" });
    },

    async search(
      sessionID: string,
      vector: number[],
      topK: number,
    ): Promise<SearchResult[]> {
      const table = await getOrCreateTable();

      let rows: any[];
      try {
        rows = await table
          .query()
          .filter(`sessionID = '${sessionID}'`)
          .nearestTo(vector)
          .distanceType("cosine")
          .limit(topK + 5)
          .toArray();
      } catch {
        return [];
      }

      return rows
        .map((row: any) => ({
          record: {
            id: row.id as string,
            sessionID: row.sessionID as string,
            messageID: row.messageID as string,
            text: row.text as string,
            vector: row.vector as number[],
            role: row.role as string,
            timestamp: row.timestamp as number,
          },
          score: 1 - (row._distance ?? 1),
        }))
        .filter((r: SearchResult) => r.score > 0);
    },

    async deleteBySession(sessionID: string): Promise<void> {
      try {
        const table = await getOrCreateTable();
        await table.delete(`sessionID = '${sessionID}'`);
      } catch {
        // ignore
      }
    },

    async deleteByMessage(
      sessionID: string,
      messageID: string,
    ): Promise<void> {
      try {
        const table = await getOrCreateTable();
        await table.delete(
          `sessionID = '${sessionID}' AND messageID = '${messageID}'`,
        );
      } catch {
        // ignore
      }
    },

    async count(sessionID: string): Promise<number> {
      try {
        const table = await getOrCreateTable();
        const rows = await table
          .query()
          .filter(`sessionID = '${sessionID}'`)
          .toArray();
        return rows.length;
      } catch {
        return 0;
      }
    },

    async close(): Promise<void> {
      try {
        db.close();
      } catch {
        // ignore
      }
    },
  };
}
