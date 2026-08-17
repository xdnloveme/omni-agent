import { createAbortError } from "../execution";
import { cloneData } from "../dataCopy";
import type { InteractionSurfacePort } from "../interaction/ports";
import type { InteractionRequest, InteractionResponse } from "../interaction/types";
import { validateInteractionRequest, validateInteractionResponse } from "../interaction/validation";

type ScriptedResponse =
  | InteractionResponse
  | ((request: InteractionRequest) => InteractionResponse | Promise<InteractionResponse>);

export class ScriptedInteractionSurface implements InteractionSurfacePort {
  private readonly scripted: ScriptedResponse[] = [];
  private readonly received: InteractionRequest[] = [];

  enqueue(response: ScriptedResponse): void {
    this.scripted.push(response);
  }

  requests(): readonly InteractionRequest[] {
    return cloneData(this.received);
  }

  async request(request: InteractionRequest, signal?: AbortSignal): Promise<InteractionResponse> {
    if (signal?.aborted) throw createAbortError(signal);
    validateInteractionRequest(request);
    const snapshot = cloneData(request);
    this.received.push(snapshot);
    const scripted = this.scripted.shift();
    if (!scripted) throw new Error("ScriptedInteractionSurface has no queued response");
    const response =
      typeof scripted === "function" ? await scripted(cloneData(snapshot)) : scripted;
    if (signal?.aborted) throw createAbortError(signal);
    validateInteractionResponse(request, response);
    return cloneData(response);
  }
}
