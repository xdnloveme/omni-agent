import { InteractionError } from "./errors";
import type { InteractionSurfacePort } from "./ports";
import type { InteractionRequest } from "./types";

export class RejectingInteractionSurface implements InteractionSurfacePort {
  async request(_request: InteractionRequest, _signal?: AbortSignal): Promise<never> {
    throw new InteractionError(
      "interaction_unavailable",
      "The current host does not provide an interaction surface",
    );
  }
}
