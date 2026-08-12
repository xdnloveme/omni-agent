import { createHash } from "node:crypto";
import path from "node:path";
import type { PersistentApprovalRequirement } from "@omni-agent/core";
import type { ShellCommandView } from "../parser";

const SIMPLE_EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export function executableRequirement(
  command: ShellCommandView,
): PersistentApprovalRequirement | null {
  const raw = command.executable?.value;
  if (!raw) return null;
  if (raw !== path.basename(raw)) return null;
  const executable = path.basename(raw);
  if (!SIMPLE_EXECUTABLE.test(executable)) return null;
  const key = `bash:executable:${createHash("sha256").update(executable).digest("hex")}`;
  return {
    approval: {
      key,
      kind: "bash_executable",
      label: `Always trust executable: ${executable}`,
    },
    satisfiedBy: [key, "tool:routine"],
  };
}
