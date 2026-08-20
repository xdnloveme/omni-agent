import { XMLParser } from "fast-xml-parser";

/** Presentation-only parsing for model messages recorded in a trace. */

const environmentParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  trimValues: true,
});

interface EnvironmentContextView {
  readonly revision: string;
  readonly notice: string;
  readonly workspace: { readonly cwd: string; readonly roots: string[] };
  readonly time: { readonly currentDate: string; readonly timezone: string };
  readonly execution: {
    readonly platform: string;
    readonly arch: string;
    readonly shell: string;
    readonly kind: string;
  };
}

export function modelMessageKind(
  request: { readonly manifest?: { readonly environmentFingerprint?: unknown } } | null | undefined,
  message: { readonly role?: unknown } | null | undefined,
  index: number,
): string {
  if (
    index === 0 &&
    message?.role === "user" &&
    typeof request?.manifest?.environmentFingerprint === "string"
  ) {
    return "runtime-context";
  }
  return typeof message?.role === "string" ? message.role : "message";
}

export function parseEnvironmentContext(source: unknown): EnvironmentContextView | null {
  if (typeof source !== "string") return null;
  let parsed: unknown;
  try {
    parsed = environmentParser.parse(source);
  } catch {
    return null;
  }
  const rawContext = object(parsed).environment_context;
  if (!rawContext || typeof rawContext !== "object") return null;
  const context = object(rawContext);
  const workspace = object(context.workspace);
  const time = object(context.time);
  const execution = object(context.execution);
  const roots = object(workspace.roots)?.root;
  return {
    revision: text(context.revision),
    notice: text(context.notice),
    workspace: {
      cwd: text(workspace.cwd),
      roots: (Array.isArray(roots) ? roots : roots === undefined ? [] : [roots]).map(text),
    },
    time: {
      currentDate: text(time.current_date),
      timezone: text(time.timezone),
    },
    execution: {
      platform: text(execution.platform),
      arch: text(execution.arch),
      shell: text(execution.shell),
      kind: text(execution.kind),
    },
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}
