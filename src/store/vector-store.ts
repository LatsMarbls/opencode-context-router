export interface VectorRecord {
  id: string;
  sessionID: string;
  messageID: string;
  text: string;
  vector: number[];
  role: string;
  timestamp: number;
}

export interface SearchResult {
  record: VectorRecord;
  score: number;
}

export interface VectorStore {
  upsert(records: VectorRecord[]): Promise<void>;
  search(
    sessionID: string,
    vector: number[],
    topK: number,
  ): Promise<SearchResult[]>;
  deleteBySession(sessionID: string): Promise<void>;
  deleteByMessage(sessionID: string, messageID: string): Promise<void>;
  count(sessionID: string): Promise<number>;
  close(): Promise<void>;
}
