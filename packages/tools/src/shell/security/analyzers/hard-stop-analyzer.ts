import path from "node:path";
import type { ShellHardStop } from "../analysis/analysis-result";
import { assignmentFromWord, type ShellCommandView } from "../parser";

export function analyzeCommandHardStop(
  command: ShellCommandView,
  shellCwd: string,
  workspaceRoot: string,
  home: string,
): ShellHardStop | null {
  const executable = command.executableName;
  const args = command.argumentValues;
  if (executable === "sudo") {
    return hardDeny("Privilege escalation is not allowed", "shell.hard.sudo");
  }
  if (["shutdown", "reboot", "halt", "poweroff"].includes(executable)) {
    return hardDeny("Controls host power or startup state", "shell.hard.system-power");
  }
  if (isCatastrophicDelete(executable, args, shellCwd, workspaceRoot, home)) {
    return hardDeny("Deletes a protected filesystem root", "shell.hard.catastrophic-delete");
  }
  if (executable === "rm" && args.includes("--no-preserve-root")) {
    return hardDeny("Disables root deletion protection", "shell.hard.no-preserve-root");
  }
  const assignments = commandAssignments(command);
  if (assignments.some(({ name, value }) => isShellStartupVariable(name) && value !== "")) {
    return hardDeny(
      "Injects code through the shell startup environment",
      "shell.hard.startup-environment",
    );
  }
  if (assignments.some(({ name }) => /^(?:LD_PRELOAD|LD_AUDIT|DYLD_.+)$/i.test(name))) {
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
    command.redirections.some(
      ({ operator, target }) => operator.includes(">") && authPath.test(target?.staticValue ?? ""),
    ) ||
    (executable === "tee" && args.some((argument) => authPath.test(argument)))
  ) {
    return hardDeny("Writes a system authentication file", "shell.hard.auth-file");
  }
  if (
    (executable === "crontab" && !args.includes("-l")) ||
    (executable === "launchctl" &&
      !["list", "print", "blame", "print-cache", "procinfo"].includes(args[0] ?? "")) ||
    (executable === "systemctl" &&
      !args.includes("--user") &&
      ["enable", "mask"].includes(args.find((argument) => !argument.startsWith("-")) ?? "")) ||
    (executable === "service" && args.includes("enable"))
  ) {
    return hardDeny("Installs system-level persistence", "shell.hard.persistence");
  }
  if (
    (["nc", "netcat", "ncat"].includes(executable) && args.includes("-e")) ||
    (executable === "socat" && args.some((argument) => /^(?:exec|system):/i.test(argument))) ||
    command.redirections.some(({ target }) =>
      /\/dev\/(?:tcp|udp)\//i.test(target?.staticValue ?? ""),
    )
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

function hardDeny(reason: string, code: string): ShellHardStop {
  return { code, reason };
}

function isCatastrophicDelete(
  executable: string,
  args: readonly string[],
  shellCwd: string,
  workspaceRoot: string,
  home: string,
): boolean {
  if (executable !== "rm") return false;
  const recursive = args.some(
    (argument) => argument === "--recursive" || /^-[^-]*r/.test(argument),
  );
  if (!recursive) return false;
  const protectedTargets = new Set([
    "/",
    "~",
    "$HOME",
    "${HOME}",
    home,
    path.resolve(workspaceRoot),
  ]);
  if (shellCwd !== "unknown" && path.resolve(shellCwd) === path.resolve(workspaceRoot)) {
    protectedTargets.add(".");
    protectedTargets.add("$PWD");
    protectedTargets.add("${PWD}");
  }
  return args.some((argument) => {
    const target = argument.replace(/\/$/, "") || "/";
    if (protectedTargets.has(target)) return true;
    const globRoot = target.replace(/\/(?:\*|\*\*)$/, "") || "/";
    if (protectedTargets.has(globRoot)) return true;
    return (
      shellCwd !== "unknown" &&
      path.resolve(shellCwd) === path.resolve(workspaceRoot) &&
      ["*", "**"].includes(target)
    );
  });
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
        (["-v", "--volume"].includes(argument) && runArgs[index + 1]?.startsWith("/:") === true) ||
        (/^--mount=/.test(argument) && /(?:=|,)(?:source|src)=\/(?:,|$)/.test(argument)) ||
        (argument === "--mount" &&
          /(?:^|,)(?:source|src)=\/(?:,|$)/.test(runArgs[index + 1] ?? "")),
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

function isShellStartupVariable(name: string): boolean {
  return name === "BASH_ENV" || name === "ENV" || name.startsWith("BASH_FUNC_");
}

function commandAssignments(
  command: ShellCommandView,
): readonly { name: string; value: string | undefined }[] {
  return [
    ...command.leadingAssignments.map(({ name, value }) => ({ name, value: value.staticValue })),
    ...command.arguments.flatMap((word) => {
      const assignment = assignmentFromWord(word);
      if (assignment) return [{ name: assignment.name, value: assignment.value.staticValue }];
      const separator = word.staticValue?.indexOf("=") ?? -1;
      return separator > 0
        ? [
            {
              name: word.staticValue!.slice(0, separator),
              value: word.staticValue!.slice(separator + 1),
            },
          ]
        : [];
    }),
  ];
}
