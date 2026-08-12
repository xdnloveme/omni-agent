import path from "node:path";
import { createShellCommandView, type ParsedShellCommand, type ShellCommandView } from "../parser";
import { classification, type ShellClassification } from "./types";

export function classifyWholeCommandHardStop(
  parsed: ParsedShellCommand,
  cwd: string,
  home: string,
): ShellClassification | null {
  for (const segment of parsed.segments) {
    const result = classifyCommandHardStop(createShellCommandView(segment), cwd, home);
    if (result) return result;
  }
  if (
    parsed.segments.length > 1 &&
    /\b(?:curl|wget)\b[^|;&]*\|\s*(?:(?:env|command|exec|nohup|time)(?:\s+(?:-[^\s]+|[A-Za-z_][A-Za-z0-9_]*=[^\s]+))*\s+)*(?:(?:ba|z|da)?sh|python(?:3)?|node|perl|ruby)\b/i.test(
      parsed.raw,
    )
  ) {
    return hardDeny("Executes downloaded code", "shell.hard.download-execute");
  }
  if (
    parsed.segments.length > 1 &&
    /\b(?:base64|openssl)\b[^|;&]*\|\s*(?:(?:env|command|exec|nohup|time)\s+)*(?:(?:ba|z|da)?sh|python(?:3)?|node|perl|ruby)\b/i.test(
      parsed.raw,
    )
  ) {
    return hardDeny("Decodes and executes an opaque payload", "shell.hard.decode-execute");
  }
  if (
    parsed.segments.length > 1 &&
    /(?:\.ssh|\.aws|\.gnupg|\.kube|\.env|\.npmrc)[^|;&]*\|[^\n]*\b(?:curl|wget|nc|scp)\b/i.test(
      parsed.raw,
    )
  ) {
    return hardDeny("Uploads credential material", "shell.hard.credential-upload");
  }
  if (parsed.segments.length > 1 && /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(parsed.raw)) {
    return hardDeny("Creates an unbounded process fork loop", "shell.hard.fork-bomb");
  }
  return null;
}

export function classifyCommandHardStop(
  command: ShellCommandView,
  cwd: string,
  home: string,
): ShellClassification | null {
  const executable = command.executableName;
  const args = command.argumentValues;
  if (executable === "sudo") {
    return hardDeny("Privilege escalation is not allowed", "shell.hard.sudo");
  }
  if (isCatastrophicDelete(executable, args, cwd, home)) {
    return hardDeny("Deletes a protected filesystem root", "shell.hard.catastrophic-delete");
  }
  if (executable === "rm" && args.includes("--no-preserve-root")) {
    return hardDeny("Disables root deletion protection", "shell.hard.no-preserve-root");
  }
  const assignmentNames = [
    ...command.segment.leadingAssignments.map(({ name }) => name),
    ...command.segment.words
      .map(({ value }) => value.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1])
      .filter((name): name is string => name !== undefined),
  ];
  if (assignmentNames.some((name) => /^(?:LD_PRELOAD|LD_AUDIT|DYLD_.+)$/i.test(name))) {
    return hardDeny("Injects code through the dynamic loader", "shell.hard.loader-injection");
  }
  if (
    ["mkfs", "wipefs", "fdisk", "parted", "newfs"].some(
      (name) => executable === name || executable.startsWith(`${name}.`),
    ) ||
    (executable === "diskutil" && /^(?:erase|partition|zeroDisk)/i.test(args[0] ?? ""))
  ) {
    return hardDeny("Modifies or erases disks", "shell.hard.disk");
  }
  if (
    executable === "dd" &&
    args.some((argument) => /^of=\/dev\/(?:disk|sd|nvme|vd|xvd)/i.test(argument))
  ) {
    return hardDeny("Writes directly to a block device", "shell.hard.block-write");
  }
  const authPath = /\/etc\/(?:passwd|shadow|sudoers)\b/i;
  if (
    command.segment.redirections.some(
      ({ operator, target }) => operator.includes(">") && authPath.test(target),
    ) ||
    (executable === "tee" && args.some((argument) => authPath.test(argument)))
  ) {
    return hardDeny("Writes a system authentication file", "shell.hard.auth-file");
  }
  if (
    executable === "crontab" ||
    executable === "launchctl" ||
    (executable === "systemctl" && ["enable", "mask"].includes(args[0] ?? "")) ||
    (executable === "service" && args.includes("enable"))
  ) {
    return hardDeny("Installs system-level persistence", "shell.hard.persistence");
  }
  if (
    (["nc", "netcat", "ncat"].includes(executable) && args.includes("-e")) ||
    (executable === "socat" && args.some((argument) => /(?:exec|system)/i.test(argument))) ||
    command.segment.redirections.some(({ target }) => /\/dev\/(?:tcp|udp)\//i.test(target))
  ) {
    return hardDeny("Creates a reverse shell", "shell.hard.reverse-shell");
  }
  if (isPrivilegedDocker(executable, args)) {
    return hardDeny("Grants a container host-level control", "shell.hard.docker-host");
  }
  if (disablesSecurity(executable, args)) {
    return hardDeny("Disables host security controls", "shell.hard.security-disable");
  }
  if (
    executable === "chmod" &&
    args.some((argument) => /^(?:u\+s|g\+s|[2467][0-7]{3})$/i.test(argument))
  ) {
    return hardDeny("Sets setuid or setgid permissions", "shell.hard.setid");
  }
  return null;
}

function isCatastrophicDelete(
  executable: string,
  args: readonly string[],
  cwd: string,
  home: string,
): boolean {
  if (executable !== "rm") return false;
  const recursive = args.some(
    (argument) => argument === "--recursive" || /^-[^-]*r/.test(argument),
  );
  const forced = args.some((argument) => argument === "--force" || /^-[^-]*f/.test(argument));
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
    home,
  ]);
  return args.some((argument) => protectedTargets.has(argument.replace(/\/$/, "") || "/"));
}

function isPrivilegedDocker(executable: string, args: readonly string[]): boolean {
  const runIndex = args.indexOf("run");
  if (executable !== "docker" || runIndex < 0) return false;
  return args
    .slice(runIndex + 1)
    .some(
      (argument, index, runArgs) =>
        argument === "--privileged" ||
        /^--cap-add=all$/i.test(argument) ||
        (argument === "--cap-add" && runArgs[index + 1]?.toLowerCase() === "all") ||
        /^--pid=host$/i.test(argument) ||
        (argument === "--pid" && runArgs[index + 1]?.toLowerCase() === "host") ||
        /^--volume=\/:/.test(argument) ||
        (["-v", "--volume"].includes(argument) && runArgs[index + 1]?.startsWith("/:") === true),
    );
}

function disablesSecurity(executable: string, args: readonly string[]): boolean {
  const joined = args.join(" ").toLowerCase();
  return (
    (executable === "csrutil" && joined === "disable") ||
    (executable === "spctl" && joined === "--master-disable") ||
    (executable === "ufw" && joined === "disable") ||
    (executable === "setenforce" && joined === "0") ||
    (executable === "auditctl" && joined === "-e 0")
  );
}

function hardDeny(reason: string, ruleId: string): ShellClassification {
  return classification("privileged", reason, ruleId, { enforcement: "hard_deny" });
}
