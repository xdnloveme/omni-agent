import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createClarificationEvaluationContract,
  createClarificationEvaluationContractDigest,
  digest,
} from "./contract";
import { createClarificationEvaluationReport } from "./evaluator";
import type { ClarificationEvaluationCase, ClarificationEvaluationResponse } from "./types";

const DEFAULT_CORPUS_PATH = fileURLToPath(new URL("./corpus.v1.jsonl", import.meta.url));

async function main(): Promise<void> {
  const cliArgs = process.argv.slice(2);
  if (cliArgs[0] === "--") cliArgs.shift();
  const [command, ...args] = cliArgs;
  if (command !== "render" && command !== "evaluate") throw usageError();
  const cases = await loadJsonLines<ClarificationEvaluationCase>(
    flag(args, "--corpus") ?? DEFAULT_CORPUS_PATH,
    parseCase,
  );
  validateCases(cases);
  const contract = createClarificationEvaluationContract();
  const evaluationContractDigest = createClarificationEvaluationContractDigest();
  const corpusDigest = digest(cases);

  if (command === "render") {
    const requests = cases.map((item) => ({
      id: item.id,
      evaluationContractDigest,
      corpusDigest,
      systemPrompt: contract.systemPrompt,
      messages: item.messages,
      tools: [contract.tool],
      purpose: "evaluation",
      cache: { retention: "none" },
    }));
    await emit(
      requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
      flag(args, "--output"),
    );
    return;
  }

  const responsesPath = flag(args, "--responses");
  if (!responsesPath) throw new Error("--responses is required for clarification evaluation");
  const responses = await loadJsonLines<ClarificationEvaluationResponse>(
    responsesPath,
    parseResponse,
  );
  const report = createClarificationEvaluationReport({
    cases,
    responses,
    evaluationContractDigest,
    corpusDigest,
  });
  await emit(JSON.stringify(report, null, 2) + "\n", flag(args, "--output"));
  if (!report.releaseEligible) process.exitCode = 1;
}

async function loadJsonLines<T>(path: string, parse: (value: unknown) => T): Promise<T[]> {
  const source = await readFile(path, "utf8");
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return parse(JSON.parse(line));
      } catch (error) {
        throw new Error(
          `Invalid JSONL entry on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
}

function parseCase(value: unknown): ClarificationEvaluationCase {
  if (!isRecord(value)) throw new Error("case must be an object");
  if (
    !isText(value.id) ||
    !Array.isArray(value.messages) ||
    value.messages.length === 0 ||
    !value.messages.every(isRecord)
  ) {
    throw new Error("case requires id and messages");
  }
  if (value.language !== "zh" && value.language !== "en") {
    throw new Error("case requires a supported language");
  }
  if (!isCategory(value.category)) throw new Error("case requires a supported category");
  if (value.expected !== "ask" && value.expected !== "proceed") {
    throw new Error("case requires an ask or proceed expectation");
  }
  return value as unknown as ClarificationEvaluationCase;
}

function isCategory(value: unknown): boolean {
  return [
    "material_choice",
    "discoverable_fact",
    "safe_default",
    "complete_instruction",
    "permission_boundary",
    "clarification_result",
  ].includes(String(value));
}

function parseResponse(value: unknown): ClarificationEvaluationResponse {
  if (!isRecord(value)) throw new Error("response must be an object");
  for (const field of [
    "id",
    "evaluationContractDigest",
    "corpusDigest",
    "provider",
    "model",
  ] as const) {
    if (!isText(value[field])) throw new Error(`response requires ${field}`);
  }
  if (!Array.isArray(value.toolCalls) || !value.toolCalls.every(isToolCall)) {
    throw new Error("response requires valid toolCalls");
  }
  if (value.manualReview !== undefined && !isManualReview(value.manualReview)) {
    throw new Error("response contains invalid manualReview");
  }
  if (value.continuationReview !== undefined && !isContinuationReview(value.continuationReview)) {
    throw new Error("response contains invalid continuationReview");
  }
  return value as unknown as ClarificationEvaluationResponse;
}

function validateCases(cases: readonly ClarificationEvaluationCase[]): void {
  if (cases.length === 0) throw new Error("Clarification evaluation corpus is empty");
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`Duplicate clarification evaluation case: ${item.id}`);
    ids.add(item.id);
  }
  if (!cases.some((item) => item.expected === "ask")) throw new Error("Corpus requires ask cases");
  if (!cases.some((item) => item.expected === "proceed")) {
    throw new Error("Corpus requires proceed cases");
  }
}

function isToolCall(value: unknown): boolean {
  return isRecord(value) && isText(value.name) && isRecord(value.arguments);
}

function isManualReview(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.decisionFocused === "boolean" &&
    typeof value.optionsMutuallyExclusive === "boolean" &&
    typeof value.recommendationAndTradeoffs === "boolean" &&
    typeof value.customInputHandledCorrectly === "boolean" &&
    (value.notes === undefined || typeof value.notes === "string")
  );
}

function isContinuationReview(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.continuedAppropriately === "boolean" &&
    (value.notes === undefined || typeof value.notes === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function emit(value: string, outputPath: string | undefined): Promise<void> {
  if (!outputPath) {
    process.stdout.write(value);
    return;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, value, "utf8");
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function usageError(): Error {
  return new Error(
    "Usage: pnpm eval:clarification -- render [--corpus path] [--output path] | evaluate --responses path [--corpus path] [--output path]",
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
