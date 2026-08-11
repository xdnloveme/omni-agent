import os from "node:os";
import path from "node:path";
import { parseShellCommand, shellWords, type ParsedShellCommand } from "../shell-parser";
import { classification, type ShellClassification } from "./types";

interface HardStopRule {
  id: string;
  reason: string;
  matches(context: HardStopContext): boolean;
}

interface HardStopContext {
  command: string;
  parsed: ParsedShellCommand;
  segments: ReturnType<typeof commandSegments>;
}

const HARD_STOP_RULES: readonly HardStopRule[] = [
  rule("shell.hard.no-preserve-root", "Disables root deletion protection", ({ segments }) =>
    segments.some(
      ({ executable, args }) => executable === "rm" && args.includes("--no-preserve-root"),
    ),
  ),
  rule("shell.hard.disk", "Modifies or erases disks", ({ segments }) =>
    segments.some(({ executable, args }) => {
      if (
        ["mkfs", "wipefs", "fdisk", "parted", "newfs"].some(
          (name) => executable === name || executable.startsWith(`${name}.`),
        )
      )
        return true;
      return executable === "diskutil" && /^(?:erase|partition|zeroDisk)/i.test(args[0] ?? "");
    }),
  ),
  rule("shell.hard.block-write", "Writes directly to a block device", ({ segments }) =>
    segments.some(
      ({ executable, args }) =>
        executable === "dd" && args.some((arg) => /^of=\/dev\/(?:disk|sd|nvme|vd|xvd)/i.test(arg)),
    ),
  ),
  rule("shell.hard.auth-file", "Writes a system authentication file", ({ parsed, segments }) => {
    const authPath = /\/etc\/(?:passwd|shadow|sudoers)\b/i;
    return (
      parsed.redirections.some(
        ({ operator, target }) => operator.includes(">") && authPath.test(target),
      ) ||
      segments.some(
        ({ executable, args }) => executable === "tee" && args.some((arg) => authPath.test(arg)),
      )
    );
  }),
  rule("shell.hard.persistence", "Installs system-level persistence", ({ segments }) =>
    segments.some(({ executable, args }) => {
      if (executable === "crontab" || executable === "launchctl") return true;
      if (executable === "systemctl") return ["enable", "mask"].includes(args[0] ?? "");
      return executable === "service" && args.includes("enable");
    }),
  ),
  rule(
    "shell.hard.reverse-shell",
    "Creates a reverse shell",
    ({ parsed, segments }) =>
      segments.some(({ executable, args }) => {
        if (["nc", "netcat", "ncat"].includes(executable)) return args.includes("-e");
        if (executable === "socat") return args.some((arg) => /(?:exec|system)/i.test(arg));
        return false;
      }) || parsed.redirections.some(({ target }) => /\/dev\/(?:tcp|udp)\//i.test(target)),
  ),
  rule(
    "shell.hard.download-execute",
    "Executes downloaded code",
    ({ command, parsed }) =>
      parsed.segments.length > 1 &&
      /\b(?:curl|wget)\b[^|;&]*\|\s*(?:(?:env|command|exec|nohup|time)(?:\s+(?:-[^\s]+|[A-Za-z_][A-Za-z0-9_]*=[^\s]+))*\s+)*(?:(?:ba|z|da)?sh|python(?:3)?|node|perl|ruby)\b/i.test(
        command,
      ),
  ),
  rule(
    "shell.hard.decode-execute",
    "Decodes and executes an opaque payload",
    ({ command, parsed }) =>
      parsed.segments.length > 1 &&
      /\b(?:base64|openssl)\b[^|;&]*\|\s*(?:(?:env|command|exec|nohup|time)\s+)*(?:(?:ba|z|da)?sh|python(?:3)?|node|perl|ruby)\b/i.test(
        command,
      ),
  ),
  rule(
    "shell.hard.credential-upload",
    "Uploads credential material",
    ({ command, parsed }) =>
      parsed.segments.length > 1 &&
      /(?:\.ssh|\.aws|\.gnupg|\.kube|\.env|\.npmrc)[^|;&]*\|[^\n]*\b(?:curl|wget|nc|scp)\b/i.test(
        command,
      ),
  ),
  rule("shell.hard.docker-host", "Grants a container host-level control", ({ segments }) =>
    segments.some(({ executable, args }) => {
      const runIndex = args.indexOf("run");
      if (executable !== "docker" || runIndex < 0) return false;
      return args
        .slice(runIndex + 1)
        .some(
          (arg, index, runArgs) =>
            arg === "--privileged" ||
            /^--cap-add=all$/i.test(arg) ||
            (arg === "--cap-add" && runArgs[index + 1]?.toLowerCase() === "all") ||
            /^--pid=host$/i.test(arg) ||
            (arg === "--pid" && runArgs[index + 1]?.toLowerCase() === "host") ||
            /^--volume=\/:/.test(arg) ||
            (["-v", "--volume"].includes(arg) && runArgs[index + 1]?.startsWith("/:") === true),
        );
    }),
  ),
  rule("shell.hard.security-disable", "Disables host security controls", ({ segments }) =>
    segments.some(({ executable, args }) => {
      const joined = args.join(" ").toLowerCase();
      return (
        (executable === "csrutil" && joined === "disable") ||
        (executable === "spctl" && joined === "--master-disable") ||
        (executable === "ufw" && joined === "disable") ||
        (executable === "setenforce" && joined === "0") ||
        (executable === "auditctl" && joined === "-e 0")
      );
    }),
  ),
  rule("shell.hard.setid", "Sets setuid or setgid permissions", ({ segments }) =>
    segments.some(
      ({ executable, args }) =>
        executable === "chmod" && args.some((arg) => /^(?:u\+s|g\+s|[2467][0-7]{3})$/i.test(arg)),
    ),
  ),
  rule(
    "shell.hard.fork-bomb",
    "Creates an unbounded process fork loop",
    ({ command, parsed }) =>
      parsed.segments.length > 1 && /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command),
  ),
];

export function classifyWholeCommandHardStop(
  command: string,
  cwd: string,
): ShellClassification | null {
  const parsed = parseShellCommand(command);
  const segments = commandSegments(parsed);
  const context = { command, parsed, segments };
  if (segments.some(({ executable }) => executable === "sudo")) {
    return classification(
      "privileged",
      "Privilege escalation is not allowed",
      "shell.hard.sudo",
      "hard_deny",
    );
  }
  if (segments.some(({ executable, args }) => isCatastrophicDelete(executable, args, cwd))) {
    return classification(
      "privileged",
      "Deletes a protected filesystem root",
      "shell.hard.catastrophic-delete",
      "hard_deny",
    );
  }
  for (const entry of HARD_STOP_RULES) {
    if (entry.matches(context)) {
      return classification("privileged", entry.reason, entry.id, "hard_deny");
    }
  }
  return null;
}

function rule(id: string, reason: string, matches: HardStopRule["matches"]): HardStopRule {
  return { id, reason, matches };
}

function commandSegments(parsed: ParsedShellCommand) {
  return parsed.segments.map((segment) => {
    const words = shellWords(segment);
    const index = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word));
    return {
      executable: index < 0 ? "" : path.basename(words[index]!).toLowerCase(),
      args: index < 0 ? [] : words.slice(index + 1),
    };
  });
}

function isCatastrophicDelete(executable: string, args: readonly string[], cwd: string): boolean {
  if (executable !== "rm") return false;
  const recursive = args.some((arg) => arg === "--recursive" || /^-[^-]*r/.test(arg));
  const forced = args.some((arg) => arg === "--force" || /^-[^-]*f/.test(arg));
  if (!recursive || !forced) return false;
  const protectedTargets = new Set([
    "/",
    "~",
    "$HOME",
    "${HOME}",
    "$PWD",
    "${PWD}",
    ".",
    path.resolve(cwd),
    os.homedir(),
  ]);
  return args.some((arg) => protectedTargets.has(arg.replace(/\/$/, "") || "/"));
}
