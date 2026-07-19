import type { Part } from "@opencode-ai/sdk";

type MessageWithParts = {
  info: { role: string; id: string; [key: string]: unknown };
  parts: Part[];
};

export function extractTextFromParts(parts: Part[] | unknown): string {
  if (!parts || !Array.isArray(parts)) return "";
  return (parts as unknown[])
    .map((p: unknown) => {
      if (typeof p === "string") return p;
      if (p && typeof p === "object") {
        const obj = p as { type?: string; text?: string };
        if (obj.type === "text" && obj.text) return obj.text;
      }
      return "";
    })
    .join(" ")
    .trim();
}

export function extractLatestUserMessage(
  messages: MessageWithParts[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role === "user") {
      const text = extractTextFromParts(msg.parts);
      if (text.length > 0) return text;
    }
  }
  return null;
}

export function extractMessageText(
  msg: MessageWithParts,
): string {
  return extractTextFromParts(msg.parts);
}
