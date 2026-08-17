import type { InteractionRequest, InteractionResponse } from "./types";

export interface InteractionSurfacePort {
  request(request: InteractionRequest, signal?: AbortSignal): Promise<InteractionResponse>;
}
