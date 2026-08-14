import type { StoredCredential } from "../../credentials/types";
import type { ModelContextMessage } from "@omni-agent/core";
import type { ModelTransportEvent, ProviderCacheOptions } from "../../cache/contracts";

export interface CompatibleModelDefinition {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning?: boolean;
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
  ): AsyncIterable<ModelTransportEvent>;
}
