import { basename, isAbsolute, relative, resolve } from "node:path";
import { throwIfAborted } from "../execution";
import { PromptContributionBudgetError } from "../promptBudget";
import { digestStableValue } from "../valueDigest";
import { renderEnvironmentContext } from "./render";
import type {
  EnvironmentContextRecord,
  EnvironmentContextControllerPort,
  EnvironmentCaptureResult,
  RuntimeEnvironmentProviderPort,
  RuntimeEnvironmentSnapshot,
  RuntimePlatform,
} from "./types";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EXECUTION_VALUE_LENGTH = 64;

export class EnvironmentContextError extends Error {
  readonly code: "environment_context_invalid" | "environment_context_unavailable";
  readonly field?: string;
  readonly retryable: boolean;

  constructor(input: {
    code: EnvironmentContextError["code"];
    message: string;
    field?: string;
    retryable: boolean;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "EnvironmentContextError";
    this.code = input.code;
    this.field = input.field;
    this.retryable = input.retryable;
  }
}

export class EnvironmentContextController implements EnvironmentContextControllerPort {
  constructor(private readonly provider: RuntimeEnvironmentProviderPort) {}

  async capture(
    latest: EnvironmentContextRecord | undefined,
    signal?: AbortSignal,
  ): Promise<EnvironmentCaptureResult> {
    throwIfAborted(signal);
    let captured: RuntimeEnvironmentSnapshot;
    try {
      captured = await this.provider.snapshot(signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof EnvironmentContextError) throw error;
      throw new EnvironmentContextError({
        code: "environment_context_unavailable",
        message: "Unable to capture the runtime environment.",
        retryable: true,
        cause: error,
      });
    }
    throwIfAborted(signal);
    const snapshot = normalizeEnvironmentSnapshot(captured);
    const fingerprint = digestStableValue(snapshot);
    if (latest?.fingerprint === fingerprint) return { changed: false };

    const context: EnvironmentContextRecord = {
      revision: (latest?.revision ?? 0) + 1,
      fingerprint,
      snapshot,
      capturedAt: Date.now(),
    };
    assertEnvironmentContextRenderable(context);
    return { changed: true, context };
  }
}

export function normalizeEnvironmentSnapshot(
  snapshot: RuntimeEnvironmentSnapshot,
): RuntimeEnvironmentSnapshot {
  if (!snapshot || typeof snapshot !== "object") invalid("snapshot", "Environment is required.");
  const cwd = normalizeAbsolutePath(snapshot.workspace?.cwd, "workspace.cwd");
  if (!Array.isArray(snapshot.workspace?.roots) || snapshot.workspace.roots.length === 0) {
    invalid("workspace.roots", "At least one workspace root is required.");
  }
  const roots = [
    ...new Set(
      snapshot.workspace.roots.map((root) => normalizeAbsolutePath(root, "workspace.roots")),
    ),
  ];
  if (!roots.some((root) => isWithin(cwd, root))) {
    invalid("workspace.cwd", "The working directory must be within a workspace root.");
  }
  if (!isValidCalendarDate(snapshot.time?.currentDate)) {
    invalid("time.currentDate", "Current date must be a valid YYYY-MM-DD calendar date.");
  }
  const timezone = normalizeTimezone(snapshot.time?.timezone);
  const platform = normalizePlatform(snapshot.execution?.platform);
  const arch = normalizeExecutionValue(snapshot.execution?.arch, "execution.arch");
  const shell = normalizeShell(snapshot.execution?.shell);
  if (snapshot.execution?.kind !== "host") {
    invalid("execution.kind", "Only the host execution environment is supported.");
  }
  return {
    workspace: { cwd, roots },
    time: { currentDate: snapshot.time.currentDate, timezone },
    execution: { platform, arch, shell, kind: "host" },
  };
}

export function assertEnvironmentContextRecord(
  value: unknown,
): asserts value is EnvironmentContextRecord {
  if (!value || typeof value !== "object") invalid("record", "Environment record is required.");
  const context = value as Partial<EnvironmentContextRecord>;
  if (!Number.isInteger(context.revision) || (context.revision ?? 0) < 1) {
    invalid("record.revision", "Environment revision must be a positive integer.");
  }
  if (!Number.isFinite(context.capturedAt) || (context.capturedAt ?? -1) < 0) {
    invalid("record.capturedAt", "Environment capture time is invalid.");
  }
  if (typeof context.fingerprint !== "string" || !context.snapshot) {
    invalid("record", "Environment record is incomplete.");
  }
  const normalized = normalizeEnvironmentSnapshot(context.snapshot);
  const fingerprint = digestStableValue(normalized);
  if (context.fingerprint !== fingerprint || digestStableValue(context.snapshot) !== fingerprint) {
    invalid("record.fingerprint", "Environment fingerprint does not match its snapshot.");
  }
  assertEnvironmentContextRenderable(context as EnvironmentContextRecord);
}

function assertEnvironmentContextRenderable(context: EnvironmentContextRecord): void {
  try {
    renderEnvironmentContext(context);
  } catch (error) {
    if (!(error instanceof PromptContributionBudgetError)) throw error;
    throw new EnvironmentContextError({
      code: "environment_context_invalid",
      message: `Environment context exceeds its ${error.maxTokens}-token prompt budget.`,
      field: "workspace.roots",
      retryable: false,
      cause: error,
    });
  }
}

function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

function normalizeAbsolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value)) {
    invalid(field, `${field} must be an absolute path.`);
  }
  return resolve(value);
}

function normalizeTimezone(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    invalid("time.timezone", "Timezone is required.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch (error) {
    throw new EnvironmentContextError({
      code: "environment_context_invalid",
      message: `Invalid IANA timezone: ${value}`,
      field: "time.timezone",
      retryable: false,
      cause: error,
    });
  }
  return value;
}

function normalizePlatform(value: unknown): RuntimePlatform {
  return value === "darwin" || value === "linux" || value === "win32" ? value : "other";
}

function normalizeExecutionValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(field, `${field} is required.`);
  const normalized = value.trim();
  if (normalized.length > MAX_EXECUTION_VALUE_LENGTH) {
    invalid(field, `${field} exceeds ${MAX_EXECUTION_VALUE_LENGTH} characters.`);
  }
  return normalized;
}

function normalizeShell(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "unknown";
  const normalized = basename(value.trim());
  return normalized && normalized.length <= MAX_EXECUTION_VALUE_LENGTH ? normalized : "unknown";
}

function isWithin(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function invalid(field: string, message: string): never {
  throw new EnvironmentContextError({
    code: "environment_context_invalid",
    message,
    field,
    retryable: false,
  });
}
