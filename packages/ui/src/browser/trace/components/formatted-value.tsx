import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import markdownit from "markdown-it";
import { Check, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { modelMessageKind, parseEnvironmentContext } from "../format/content-format.js";
import { Hint, SectionHeader } from "./ui.js";

hljs.registerLanguage("json", json);
hljs.registerLanguage("xml", xml);
const markdown = markdownit({ html: false, linkify: true });
type DynamicObject = Record<string, unknown>;

export function ValueSection({
  title,
  value,
  mode,
  onModeChange,
}: {
  readonly title: string;
  readonly value: unknown;
  readonly mode: "formatted" | "json";
  readonly onModeChange: (mode: "formatted" | "json") => void;
}) {
  const source = formatValue(value);
  const empty =
    value === null || value === undefined || source === "" || source === "{}" || source === "[]";
  return (
    <section className="detail-section">
      <SectionHeader title={title}>
        {!empty && (
          <div className="detail-section-actions">
            <span className="format-toggle">
              <button
                type="button"
                className={mode === "formatted" ? "active" : ""}
                aria-pressed={mode === "formatted"}
                onClick={() => onModeChange("formatted")}
              >
                Formatted
              </button>
              <span aria-hidden="true">/</span>
              <button
                type="button"
                className={mode === "json" ? "active" : ""}
                aria-pressed={mode === "json"}
                onClick={() => onModeChange("json")}
              >
                JSON
              </button>
            </span>
            <CopyButton value={source} />
          </div>
        )}
      </SectionHeader>
      {empty ? (
        <div className="empty-value">No {title.toLowerCase()} captured for this operation.</div>
      ) : mode === "json" ? (
        <CodeSurface source={source} language="json" />
      ) : (
        <RichValue value={value} />
      )}
    </section>
  );
}

function RichValue({ value }: { readonly value: unknown }) {
  if (typeof value === "string") return <MessageCard text={value} />;
  if (isPrimitive(value)) return <TreeSurface value={value} />;
  if (Array.isArray(value)) {
    if (isEventList(value)) return <EventsTable events={value} />;
    return (
      <div className="rich-value">
        {value.map((item, index) => (
          <RichValue key={index} value={item} />
        ))}
      </div>
    );
  }
  if (!isObject(value)) return <TreeSurface value={value} />;
  if (isModelRequest(value)) {
    const messages = Array.isArray(value.messages) ? value.messages : [];
    return (
      <div className="rich-value">
        {typeof value.systemPrompt === "string" && (
          <MessageCard role="system" text={value.systemPrompt} />
        )}
        {messages.map((message, index) => {
          const item = isObject(message) ? message : {};
          const role = modelMessageKind(value, item, index);
          const text = contentText(item.content);
          if (role === "runtime-context" && text) {
            return <RuntimeContextCard key={index} source={text} />;
          }
          if (text !== null) return <MessageCard key={index} role={role} text={text} />;
          return <MessageContent key={index} role={role} content={item.content} />;
        })}
        <TreeSurface value={without(value, ["systemPrompt", "messages"])} />
      </div>
    );
  }
  if (isModelOutput(value)) {
    const completion = isObject(value.completion) ? value.completion : {};
    const usage = isObject(completion.usage) ? completion.usage : {};
    const badgeCandidates: Array<readonly [string, string] | null> = [
      completion.stopReason ? ["stop", String(completion.stopReason)] : null,
      completion.usage ? ["input", `${String(usage.input ?? 0)} tok`] : null,
      completion.usage ? ["output", `${String(usage.output ?? 0)} tok`] : null,
      usage.reasoning ? ["reasoning", `${String(usage.reasoning)} tok`] : null,
      usage.cacheRead ? ["cache read", `${String(usage.cacheRead)} tok`] : null,
      usage.cacheWrite ? ["cache write", `${String(usage.cacheWrite)} tok`] : null,
    ];
    const badges = badgeCandidates.filter(
      (badge): badge is readonly [string, string] => badge !== null,
    );
    return (
      <div className="rich-value">
        {badges.length > 0 && <BadgeRow values={badges} />}
        {Array.isArray(value.thinking) &&
          value.thinking.map((thought, index) => (
            <MessageCard key={`t-${index}`} role="thinking" text={String(thought)} />
          ))}
        {value.text !== undefined && <MessageCard role="assistant" text={String(value.text)} />}
        {completion.error !== undefined && (
          <MessageCard role="error" text={String(completion.error)} />
        )}
        <TreeSurface value={without(value, ["thinking", "text", "completion"])} />
      </div>
    );
  }
  const toolContent = toolResultContent(value);
  if (toolContent) {
    const result = isObject(value.result) ? value.result : {};
    const isError = result.isError === true || value.isError === true;
    const meta = result.meta ?? value.meta;
    return (
      <div className="rich-value">
        {toolContent.map((item, index) =>
          item.type === "text" && typeof item.text === "string" ? (
            <MessageCard key={index} role={isError ? "error" : "result"} text={item.text} />
          ) : (
            <TreeSurface key={index} value={item} />
          ),
        )}
        {!isEmpty(meta) && <LabeledTree label="Metadata" value={meta} />}
      </div>
    );
  }
  if (typeof value.input === "string") return <MessageCard role="user" text={value.input} />;
  if (isFlatObject(value)) return <KeyValueTable value={value} />;
  return <TreeSurface value={value} />;
}

function MessageContent({ role, content }: { readonly role: string; readonly content: unknown }) {
  if (!Array.isArray(content)) return <MessageCard role={role} text={formatValue(content)} />;
  return (
    <>
      {content.map((rawItem, index) => {
        const item = isObject(rawItem) ? rawItem : {};
        if (item.type === "text" && typeof item.text === "string") {
          return <MessageCard key={index} role={role} text={item.text} />;
        }
        if (item.type === "thinking" && typeof item.thinking === "string") {
          return <MessageCard key={index} role="thinking" text={item.thinking} />;
        }
        return (
          <LabeledTree
            key={index}
            label={item.type ? capitalize(String(item.type)) : "Message content"}
            value={item}
          />
        );
      })}
    </>
  );
}

function BadgeRow({ values }: { readonly values: readonly (readonly [string, string])[] }) {
  return (
    <div className="badge-row">
      {values.map(([key, value]) => (
        <span className="stat-badge" key={key}>
          <span>{key}</span> {value}
        </span>
      ))}
    </div>
  );
}

function LabeledTree({ label, value }: { readonly label: string; readonly value: unknown }) {
  return (
    <div className="labeled-tree">
      <p className="tree-caption">{label}</p>
      <TreeSurface value={value} />
    </div>
  );
}

function MessageCard({ role, text }: { readonly role?: string; readonly text: string }) {
  const [expanded, setExpanded] = useState(text.length <= 1200);
  const html = useMemo(
    () => DOMPurify.sanitize(markdown.render(text), { USE_PROFILES: { html: true } }),
    [text],
  );
  return (
    <div className="message-card">
      {role && <span className={`role-chip role-${role}`}>{role.toUpperCase()}</span>}
      <div className={`collapsible-content${expanded ? "" : " collapsed"}`}>
        <div className="message-body markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
        {text.length > 1200 && (
          <button
            type="button"
            className="expand-button"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : `Show all (${text.length.toLocaleString()} chars)`}
          </button>
        )}
      </div>
    </div>
  );
}

function RuntimeContextCard({ source }: { readonly source: string }) {
  const context = parseEnvironmentContext(source);
  if (!context) return <CodeSurface source={source} language="xml" wrap />;
  return (
    <div className="message-card runtime-context-card">
      <div className="runtime-context-header">
        <span className="role-chip role-runtime-context">RUNTIME CONTEXT</span>
        <span className="context-revision">
          {context.revision ? `revision ${context.revision}` : "runtime facts"}
        </span>
      </div>
      <div className="runtime-context-grid">
        <ContextGroup
          title="Workspace"
          rows={[
            ["CWD", context.workspace.cwd],
            ["Roots", context.workspace.roots.join("\n")],
          ]}
        />
        <ContextGroup
          title="Time"
          rows={[
            ["Date", context.time.currentDate],
            ["Timezone", context.time.timezone],
          ]}
        />
        <ContextGroup
          title="Execution"
          rows={[
            ["Platform", context.execution.platform],
            ["Architecture", context.execution.arch],
            ["Shell", context.execution.shell],
            ["Kind", context.execution.kind],
          ]}
        />
      </div>
      {context.notice && <p className="runtime-context-notice">{context.notice}</p>}
      <details className="raw-disclosure">
        <summary>View raw XML</summary>
        <CodeSurface source={source} language="xml" wrap />
      </details>
    </div>
  );
}

function ContextGroup({
  title,
  rows,
}: {
  readonly title: string;
  readonly rows: readonly (readonly [string, string])[];
}) {
  return (
    <section className={`runtime-context-group context-${title.toLowerCase()}`}>
      <h3>{title}</h3>
      <dl>
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
    </section>
  );
}

function KeyValueTable({ value }: { readonly value: DynamicObject }) {
  return (
    <table className="kv-table">
      <tbody>
        {Object.entries(value).map(([key, child]) => (
          <tr key={key}>
            <td className="kv-key">{key}</td>
            <td className={`kv-value type-${valueType(child)}`}>{stringValue(child)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EventsTable({ events }: { readonly events: readonly DynamicObject[] }) {
  return (
    <table className="events-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Event</th>
          <th>Data</th>
        </tr>
      </thead>
      <tbody>
        {events.map((event, index) => {
          const data = without(event, ["timestamp", "kind", "name", "seq"]);
          return (
            <tr key={`${String(event.seq ?? event.timestamp)}:${index}`}>
              <td>{new Date(Number(event.timestamp)).toLocaleTimeString()}</td>
              <td>{String(event.kind ?? event.name ?? "")}</td>
              <td className="events-data">{isEmpty(data) ? "" : JSON.stringify(data)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TreeSurface({ value }: { readonly value: unknown }) {
  if ((Array.isArray(value) && value.length === 0) || (isObject(value) && isEmpty(value))) {
    return null;
  }
  return (
    <div className="tree-surface">
      <TreeNode value={value} depth={0} />
    </div>
  );
}

function TreeNode({ value, depth }: { readonly value: unknown; readonly depth: number }) {
  if (isPrimitive(value)) return <LeafValue value={value} />;
  const entries: readonly (readonly [string | number, unknown])[] = Array.isArray(value)
    ? value.map((child, index) => [index, child] as const)
    : Object.entries(isObject(value) ? value : {});
  return (
    <div className="tree-children">
      {entries.map(([key, child]) =>
        isPrimitive(child) ? (
          <div className="tree-row" key={key}>
            <span className="tree-key">{key}</span>
            <LeafValue value={child} />
          </div>
        ) : (
          <TreeBranch key={key} label={key} value={child} depth={depth} />
        ),
      )}
    </div>
  );
}

function TreeBranch({
  label,
  value,
  depth,
}: {
  readonly label: string | number;
  readonly value: object;
  readonly depth: number;
}) {
  const [open, setOpen] = useState(depth < 1);
  return (
    <details
      className="tree-branch"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="tree-key">{label}</span>
        <span className="tree-hint">
          {Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`}
        </span>
      </summary>
      <TreeNode value={value} depth={depth + 1} />
    </details>
  );
}

function LeafValue({ value }: { readonly value: unknown }) {
  return (
    <span className={`tree-value type-${valueType(value)}`}>
      {typeof value === "string" ? JSON.stringify(value) : String(value)}
    </span>
  );
}

function CodeSurface({
  source,
  language,
  wrap = false,
}: {
  readonly source: string;
  readonly language: "json" | "xml";
  readonly wrap?: boolean;
}) {
  const html = useMemo(
    () => hljs.highlight(source, { language, ignoreIllegals: true }).value,
    [source, language],
  );
  const lines = source.split("\n");
  return (
    <div className="code-surface">
      {!wrap && lines.length > 1 && (
        <pre className="code-gutter">{lines.map((_line, index) => index + 1).join("\n")}</pre>
      )}
      <pre className={`code-body${wrap ? " wrap" : ""}`}>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

function CopyButton({ value }: { readonly value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Hint label={copied ? "Copied" : "Copy raw value"}>
      <button
        type="button"
        className="copy-button"
        aria-label="Copy value"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <Check /> : <Copy />}
      </button>
    </Hint>
  );
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
}
function isObject(value: unknown): value is DynamicObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isModelRequest(value: DynamicObject): boolean {
  return typeof value.systemPrompt === "string" || Array.isArray(value.messages);
}
function isModelOutput(value: DynamicObject): boolean {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => ["text", "thinking", "completion"].includes(key));
}
function toolResultContent(value: DynamicObject): DynamicObject[] | null {
  const result = isObject(value.result) ? value.result : {};
  const content = value.result ? result.content : value.content;
  return Array.isArray(content) && content.every(isObject) ? content : null;
}
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return isObject(value) && Object.keys(value).length === 0;
}
function contentText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value.map((item) =>
    isObject(item) && item.type === "text" && typeof item.text === "string" ? item.text : null,
  );
  return parts.every((part) => part !== null) ? parts.join("\n") : null;
}
function isEventList(value: readonly unknown[]): value is DynamicObject[] {
  return (
    value.length > 0 &&
    value.every(
      (item) =>
        isObject(item) &&
        typeof item.timestamp === "number" &&
        (item.kind !== undefined || item.name !== undefined),
    )
  );
}
function isFlatObject(value: DynamicObject): boolean {
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([, child]) => isPrimitive(child));
}
function isPrimitive(
  value: unknown,
): value is null | undefined | string | number | boolean | bigint | symbol {
  return value === null || typeof value !== "object";
}
function valueType(value: unknown): string {
  return value === null ? "null" : typeof value;
}
function stringValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}
function without(value: DynamicObject, keys: readonly string[]): DynamicObject {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
