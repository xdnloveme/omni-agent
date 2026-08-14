import { serializeContextValue } from "./digest";
export {
  escapeMarkupAttribute as escapeContextMarkupAttribute,
  escapeMarkupText as escapeContextMarkupText,
} from "../markup";

export const CHECKPOINT_PROMPT_ENCODING_VERSION = 1;

export function encodeCheckpointPromptJson(value: unknown): string {
  return serializeContextValue(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
