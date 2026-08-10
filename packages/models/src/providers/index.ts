import type { VendorPlugin } from "../vendors/types";
import { anthropicVendorPlugin } from "./anthropic";
import { deepseekVendorPlugin } from "./deepseek";
import { googleVendorPlugin } from "./google";
import { mistralVendorPlugin } from "./mistral";
import { moonshotVendorPlugin } from "./moonshot";
import { openaiVendorPlugin } from "./openai";
import { openrouterVendorPlugin } from "./openrouter";
import { qwenVendorPlugin } from "./qwen";

/** Composition-only index. Provider implementations remain in their owning directories. */
export function builtinVendorPlugins(): VendorPlugin[] {
  return [
    openaiVendorPlugin(),
    anthropicVendorPlugin(),
    googleVendorPlugin(),
    mistralVendorPlugin(),
    deepseekVendorPlugin(),
    qwenVendorPlugin(),
    openrouterVendorPlugin(),
    moonshotVendorPlugin(),
  ];
}
