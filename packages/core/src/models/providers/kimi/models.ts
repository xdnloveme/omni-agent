import type { ModelPreset } from "../../types";
import { getKimiCodeHeaders } from "./code-headers";

export const kimiPresets: ModelPreset[] = [
  {
    id: "kimi-k2.6-global",
    name: "Kimi K2.6",
    provider: "kimi",
    description: "Moonshot AI global (kimi-k2.6, 256k context)",
    api: "openai-completions",
    endpoint: "https://api.moonshot.ai/v1",
    model: "kimi-k2.6",
    maxTokens: 16384,
    contextWindow: 256000,
  },
  {
    id: "kimi-k2.6-cn",
    name: "Kimi K2.6 (CN)",
    provider: "kimi-cn",
    description: "Moonshot China Platform key (CN only, kimi-k2.6, 256k context)",
    api: "openai-completions",
    endpoint: "https://api.moonshot.cn/v1",
    model: "kimi-k2.6",
    maxTokens: 16384,
    contextWindow: 256000,
  },
  {
    id: "kimi-code-for-coding",
    name: "Kimi Code (For Coding)",
    provider: "kimi-code",
    description: "Kimi Code console membership key (kimi-for-coding, 256k context)",
    api: "openai-completions",
    endpoint: "https://api.kimi.com/coding/v1",
    model: "kimi-for-coding",
    maxTokens: 16384,
    contextWindow: 262144,
    headers: getKimiCodeHeaders,
  },
];
