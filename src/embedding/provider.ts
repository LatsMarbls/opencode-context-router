export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  dimension(): number;
  name: string;
}
