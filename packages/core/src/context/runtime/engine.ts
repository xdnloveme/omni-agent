import { throwIfAborted } from "../../execution";
import type {
  ContextEnginePort,
  ContextPolicyPort,
  ContextPreparationRequest,
} from "../contracts/ports";
import type {
  ContextComponentManifest,
  ContextDraft,
  PreparedModelContext,
} from "../contracts/types";
import { ContextAssembler, assertContextDraft } from "../assembly/assembler";
import { cloneContextDraft, createContextDraft } from "../assembly/draft";
import { createContextEnvelope } from "../policy/types";
import { assertContextPolicyResult } from "../policy/pipeline";
import { digestContextValue } from "../digest";
import { cloneTranscriptMessages } from "../../messages";

export class DefaultContextEngine implements ContextEnginePort {
  private readonly assembler = new ContextAssembler();

  constructor(private readonly policy: ContextPolicyPort) {}

  async prepare(request: ContextPreparationRequest): Promise<PreparedModelContext> {
    throwIfAborted(request.signal);
    let current = createContextDraft(request);
    const middlewareManifest: ContextComponentManifest[] = [];
    const options = {
      agentId: request.identity.agentId,
      sessionId: request.identity.sessionId,
      modelCallId: request.identity.modelCallId,
      signal: request.signal,
    };

    for (const middleware of request.middleware) {
      throwIfAborted(request.signal);
      assertComponent(middleware, "Context middleware");
      if (typeof middleware.transform !== "function") {
        throw new Error(`Context middleware transform is required: ${middleware.name}`);
      }
      const input = cloneContextDraft(current);
      const output = await middleware.transform(input, options);
      if (output === input) {
        throw new Error(`Context middleware must return a new draft: ${middleware.name}`);
      }
      assertContextDraft(output);
      current = cloneContextDraft(output);
      middlewareManifest.push({ name: middleware.name, version: middleware.version });
    }

    throwIfAborted(request.signal);
    const frame = createContextEnvelope({
      systemPrompt: current.systemPrompt,
      messages: current.messages,
      tools: current.tools,
      model: current.model,
      environment: request.environment,
    });
    const result = await this.policy.resolve(frame, {
      ...options,
      sessionRevision: request.identity.sessionRevision,
      middlewareDigest: digestContextValue(middlewareManifest),
      sourceMessages: cloneTranscriptMessages(current.messages),
      progress: request.progress,
    });
    assertContextPolicyResult(result);
    throwIfAborted(request.signal);

    return this.assembler.assemble({
      identity: request.identity,
      transformedDraft: current,
      result,
      middleware: middlewareManifest,
    });
  }
}

function assertComponent(
  component: { readonly name: string; readonly version: number },
  label: string,
): void {
  if (typeof component.name !== "string" || !component.name.trim()) {
    throw new Error(`${label} name is required`);
  }
  if (!Number.isInteger(component.version) || component.version < 1) {
    throw new Error(`${label} version must be a positive integer: ${component.name}`);
  }
}
