import type { StoredCredential } from "../../credentials/types";
import type { ModelContextMessage } from "@omni-agent/core";
import type { ModelTransportEvent, ProviderCacheOptions } from "../../cache/contracts";

export interface CompatibleModelDefinition {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning?: boolean;
  /** Explicit deployment capability; absence means unknown. */
  readonly supportsStrictMode?: boolean;
}

export interface ModelCatalogRefreshContext {
  readonly credential?: StoredCredential;
  readonly allowNetwork: boolean;
  readonly force?: boolean;
  readonly signal: AbortSignal;
}

export type CompatibleProtocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "mistral-conversations";

/** Validated pi-ai compatibility overrides supported by configured providers. */
export interface CompatibleProviderCompat {
  readonly supportsStrictMode?: boolean;
  readonly supportsUsageInStreaming?: boolean;
  readonly sendSessionAffinityHeaders?: boolean;
  readonly sessionAffinityFormat?: "openai" | "openai-nosession" | "openrouter";
  readonly supportsLongCacheRetention?: boolean;
  readonly cacheControlFormat?: "anthropic";
}

export interface ModelTransportModel {
  readonly id: string;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly contextWindow: number;
  readonly requestedOutputTokens: number;
}

export interface ModelTransportRequest {
  readonly systemPrompt?: string;
  readonly messages: readonly ModelContextMessage[];
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly schema: Readonly<Record<string, unknown>>;
    /** Already resolved by Models. A require request must be enforced by the transport. */
    readonly inputConstraint: "off" | "require";
  }[];
}

export interface ModelTransportOptions extends ProviderCacheOptions {
  readonly signal?: AbortSignal;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string | null>>;
}

export interface ModelTransport {
  stream(
    model: ModelTransportModel,
    request: ModelTransportRequest,
    options: ModelTransportOptions,
  ): AsyncIterable<Exclude<ModelTransportEvent, { type: "tool_constraint_report" }>>;
}
