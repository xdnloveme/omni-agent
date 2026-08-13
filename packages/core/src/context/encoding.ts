import { serializeContextValue } from "./digest";

export function encodeCheckpointPromptJson(value: unknown): string {
  return serializeContextValue(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function escapeContextMarkupText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function escapeContextMarkupAttribute(value: string): string {
  return escapeContextMarkupText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
