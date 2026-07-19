import type { Embedder } from "./provider.js";

const MAX_CHARS = 8000;
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const MODEL_DIMENSIONS = 384;

let pipeline: any = null;
let pipelineReady: boolean = false;
let pipelinePromise: Promise<void> | null = null;

async function loadPipeline(): Promise<void> {
  if (pipelineReady) return;
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = (async () => {
    try {
      const { pipeline: loadPipeline } = await import("@huggingface/transformers");
      pipeline = await loadPipeline("feature-extraction", MODEL_ID, {
        dtype: "fp32",
      });
      pipelineReady = true;
    } catch (err) {
      pipelinePromise = null;
      throw new Error(
        `Failed to load ONNX embedding model: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();

  return pipelinePromise;
}

function truncate(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS);
}

function normalize(vector: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  const result = new Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    result[i] = vector[i] / norm;
  }
  return result;
}

export function createOnnxEmbedder(): Embedder {
  return {
    name: "onnx",
    dimension() {
      return MODEL_DIMENSIONS;
    },
    async embed(texts: string[]): Promise<number[][]> {
      await loadPipeline();

      const truncated = texts.map(truncate);
      const results: number[][] = [];

      for (const text of truncated) {
        const output = await pipeline(text, {
          pooling: "mean",
          normalize: true,
        });
        const vec = Array.from(output.data) as number[];
        results.push(normalize(vec));
      }

      return results;
    },
  };
}
