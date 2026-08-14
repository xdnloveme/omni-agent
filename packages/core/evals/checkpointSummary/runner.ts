import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECKPOINT_PROMPT_VERSION,
  CHECKPOINT_SYSTEM_PROMPT,
  CHECKPOINT_USER_TEMPLATE,
  createCheckpointSourceEntries,
  createCheckpointUserPrompt,
} from "../../src/context/compression/prompt";
import { CHECKPOINT_CORPUS_VERSION, loadCheckpointCorpus } from "./corpus";
import { createCheckpointEvaluationContractDigest } from "./contract";
import { createCheckpointEvaluationReport } from "./evaluator";
import type { CheckpointEvaluationResponse } from "./types";

const DEFAULT_CORPUS_PATH = fileURLToPath(new URL("./corpus.v2.jsonl", import.meta.url));

async function main(): Promise<void> {
  const cliArgs = process.argv.slice(2);
  if (cliArgs[0] === "--") cliArgs.shift();
  const [command, ...args] = cliArgs;
  if (command !== "render" && command !== "evaluate") throw usageError();
  const corpusPath = flag(args, "--corpus") ?? DEFAULT_CORPUS_PATH;
  const corpus = await loadCheckpointCorpus(corpusPath);
  const evaluationContractDigest = createCheckpointEvaluationContractDigest();

  if (command === "render") {
    const requests = corpus.cases.map((item) => ({
      id: item.id,
      promptVersion: CHECKPOINT_PROMPT_VERSION,
      evaluationContractDigest,
      corpusVersion: CHECKPOINT_CORPUS_VERSION,
      corpusDigest: corpus.digest,
      systemPrompt: CHECKPOINT_SYSTEM_PROMPT,
      userPrompt: createCheckpointUserPrompt({
        previousSummary: item.previousCheckpoint,
        entries: createCheckpointSourceEntries(item.sourceEntries),
        maxOutputTokens: item.maxOutputTokens,
      }),
      maxOutputTokens: item.maxOutputTokens,
      tools: [],
      purpose: "auxiliary",
      cache: { retention: "none" },
    }));
    await emit(
      requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
      flag(args, "--output"),
    );
    return;
  }

  const responsesPath = flag(args, "--responses");
  if (!responsesPath) throw new Error("--responses is required for checkpoint evaluation");
  const responses = await loadResponses(responsesPath);
  const expectedIds = new Set(corpus.cases.map((item) => item.id));
  const unknown = responses.find((response) => !expectedIds.has(response.id));
  if (unknown) throw new Error(`Unknown checkpoint evaluation response id: ${unknown.id}`);
  const report = createCheckpointEvaluationReport({
    cases: corpus.cases,
    responses,
    evaluationContractDigest,
    corpusVersion: CHECKPOINT_CORPUS_VERSION,
    corpusDigest: corpus.digest,
  });
  await emit(JSON.stringify(report, null, 2) + "\n", flag(args, "--output"));
  if (!report.releaseEligible) process.exitCode = 1;
}

async function loadResponses(path: string): Promise<CheckpointEvaluationResponse[]> {
  const source = await readFile(path, "utf8");
  const responses = source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return parseResponse(JSON.parse(line));
      } catch (error) {
        throw new Error(
          `Invalid checkpoint response on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  const ids = new Set<string>();
  for (const response of responses) {
    if (ids.has(response.id)) throw new Error(`Duplicate checkpoint response id: ${response.id}`);
    ids.add(response.id);
  }
  return responses;
}

function parseResponse(value: unknown): CheckpointEvaluationResponse {
  if (!isRecord(value)) throw new Error("expected an object");
  for (const field of [
    "id",
    "evaluationContractDigest",
    "corpusDigest",
    "response",
    "provider",
    "model",
  ] as const) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      throw new Error(`requires a non-empty ${field}`);
    }
  }
  if (value.responseModel !== undefined && typeof value.responseModel !== "string") {
    throw new Error("responseModel must be a string");
  }
  if (value.manualReview !== undefined) {
    if (
      !isRecord(value.manualReview) ||
      !Array.isArray(value.manualReview.fabricatedFacts) ||
      !value.manualReview.fabricatedFacts.every((item) => typeof item === "string") ||
      typeof value.manualReview.injectionFollowed !== "boolean" ||
      !Array.isArray(value.manualReview.semanticFailures) ||
      !value.manualReview.semanticFailures.every((item) => typeof item === "string") ||
      (value.manualReview.notes !== undefined && typeof value.manualReview.notes !== "string")
    ) {
      throw new Error("contains an invalid manualReview");
    }
  }
  return value as unknown as CheckpointEvaluationResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    "Usage: pnpm eval:checkpoint -- render [--corpus path] [--output path] | evaluate --responses path [--corpus path] [--output path]",
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
