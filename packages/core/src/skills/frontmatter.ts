export interface ParsedSkillMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) {
    return { frontmatter: {}, body: raw.trim() };
  }

  return {
    frontmatter: parseSimpleYaml(match[1] ?? ""),
    body: raw.slice(match[0].length).trim(),
  };
}

function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");

  for (let i = 0; i < lines.length;) {
    const line = lines[i] ?? "";
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }

    const key = match[1] as string;
    let rawValue = (match[2] ?? "").trim();

    if (rawValue === "") {
      const values: string[] = [];
      i++;
      while (i < lines.length) {
        const item = lines[i] ?? "";
        const listMatch = item.match(/^\s*-\s*(.*)$/);
        if (!listMatch) break;
        values.push(unquote((listMatch[1] ?? "").trim()));
        i++;
      }
      result[key] = values;
      continue;
    }

    if (rawValue === "|" || rawValue === ">") {
      const blockLines: string[] = [];
      i++;
      while (i < lines.length && /^\s+/.test(lines[i] ?? "")) {
        blockLines.push((lines[i] ?? "").replace(/^\s{2}/, ""));
        i++;
      }
      result[key] = rawValue === "|" ? blockLines.join("\n") : blockLines.join(" ");
      continue;
    }

    result[key] = coerceScalar(rawValue);
    i++;
  }

  return result;
}

function coerceScalar(raw: string): string | boolean | number {
  const value = unquote(raw);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function unquote(value: string): string {
  return value.replace(/^["'](.*)["']$/, "$1");
}

export function getStringField(frontmatter: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = frontmatter[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function getBooleanField(
  frontmatter: Record<string, unknown>,
  defaultValue: boolean,
  ...keys: string[]
): boolean {
  for (const key of keys) {
    const value = frontmatter[key];
    if (typeof value === "boolean") return value;
  }
  return defaultValue;
}

export function getStringArrayField(frontmatter: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = frontmatter[key];
    if (Array.isArray(value)) {
      const strings = value.filter((item): item is string => typeof item === "string");
      return strings.length > 0 ? strings : undefined;
    }
    if (typeof value === "string" && value.trim()) {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  return undefined;
}
