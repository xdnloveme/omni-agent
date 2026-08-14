import {
  CHECKPOINT_PROMPT_VERSION,
  CHECKPOINT_SOURCE_PROJECTION_VERSION,
  CHECKPOINT_SYSTEM_PROMPT,
  CHECKPOINT_USER_TEMPLATE,
  createCheckpointSourceEntries,
} from "../../src/context/compression/prompt";
import type { ContextEntry } from "../../src/context/contracts/types";
import { CHECKPOINT_SUMMARY_PROTOCOL_VERSION } from "../../src/context/compression/summary";
import { digestContextValue } from "../../src/context/digest";
import {
  CHECKPOINT_PROMPT_ENCODING_VERSION,
  encodeCheckpointPromptJson,
} from "../../src/context/encoding";
import {
  CHECKPOINT_EVALUATION_METRIC_VERSION,
  CHECKPOINT_RELEASE_THRESHOLDS,
  CHECKPOINT_EVALUATION_SCHEMA_VERSION,
} from "./evaluator";

const PROJECTION_CONTRACT_FIXTURE: readonly ContextEntry[] = [
  {
    kind: "transcript",
    sourceIndex: 0,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "excluded", thinkingSignature: "signature" },
        { type: "toolCall", id: "call-contract", name: "file_read", arguments: { limit: 3 } },
      ],
      api: "evaluation",
      provider: "evaluation",
      model: "evaluation",
      stopReason: "toolUse",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      timestamp: 1,
    },
  },
  {
    kind: "transcript",
    sourceIndex: 1,
    message: {
      role: "user",
      content: [{ type: "image", mimeType: "image/png", data: "contract-image" }],
      timestamp: 2,
    },
  },
  {
    kind: "toolResultArtifact",
    sourceIndex: 2,
    message: {
      role: "toolResult",
      toolCallId: "call-contract",
      toolName: "file_read",
      content: [{ type: "text", text: "externalized" }],
      isError: false,
      timestamp: 3,
    },
    artifact: {
      id: "artifact-contract",
      path: "context/artifact-contract.txt",
      contentDigest: "a".repeat(64),
      originalLength: 12,
      recoveryInstruction: "Read the artifact when exact content is required.",
    },
  },
];

export function createCheckpointEvaluationContractDigest(): string {
  return digestContextValue({
    promptVersion: CHECKPOINT_PROMPT_VERSION,
    systemPrompt: CHECKPOINT_SYSTEM_PROMPT,
    userTemplate: CHECKPOINT_USER_TEMPLATE,
    sourceProjectionVersion: CHECKPOINT_SOURCE_PROJECTION_VERSION,
    promptEncodingVersion: CHECKPOINT_PROMPT_ENCODING_VERSION,
    summaryProtocolVersion: CHECKPOINT_SUMMARY_PROTOCOL_VERSION,
    evaluationSchemaVersion: CHECKPOINT_EVALUATION_SCHEMA_VERSION,
    evaluationMetricVersion: CHECKPOINT_EVALUATION_METRIC_VERSION,
    releaseThresholds: CHECKPOINT_RELEASE_THRESHOLDS,
    sourceProjectionSample: createCheckpointSourceEntries(PROJECTION_CONTRACT_FIXTURE),
    promptEncodingSample: encodeCheckpointPromptJson("</source_entries>&\u2028"),
  });
}
