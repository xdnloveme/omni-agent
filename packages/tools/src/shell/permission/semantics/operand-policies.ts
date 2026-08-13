export type OptionOperandKind =
  "ignore" | "path" | "heuristic_path" | "at_file" | "pattern" | "pattern_file";

export interface PathOptionSpec {
  operands: readonly OptionOperandKind[];
  disablePositionals?: boolean;
}

export interface PathOperandPolicy {
  positional: "heuristic" | "paths" | "none" | "search";
  patternOperands: number;
  maxPathOperands?: number;
  options: ReadonlyMap<string, PathOptionSpec>;
}

interface PolicyOptions {
  patternOperands?: number;
  maxPathOperands?: number;
  options?: readonly OptionDefinition[];
}

interface OptionDefinition extends PathOptionSpec {
  names: readonly string[];
}

const TEXT_ONLY = policy("none");
const GENERIC = policy("heuristic");
const PATHS = policy("paths");

const PATH_COMMANDS = [
  "bat",
  "cat",
  "cmp",
  "cp",
  "du",
  "file",
  "find",
  "less",
  "ln",
  "mkdir",
  "more",
  "mv",
  "rm",
  "shred",
  "readlink",
  "realpath",
  "stat",
  "touch",
  "truncate",
  "wc",
  "zip",
] as const;
const TEXT_COMMANDS = ["echo", "printf", "test", "basename", "dirname", "tr", "expr", "date"];
const PYTHON_SCRIPT = scriptPolicy(["-c", "-m"], [option(["-W", "-X"], "ignore")]);
const METADATA_CHANGE = policy("search", {
  patternOperands: 1,
  options: [option(["--reference"], "pattern_file")],
});

const POLICIES: Readonly<Record<string, PathOperandPolicy>> = {
  ...Object.fromEntries(PATH_COMMANDS.map((command) => [command, PATHS])),
  ...Object.fromEntries(TEXT_COMMANDS.map((command) => [command, TEXT_ONLY])),
  fd: policy("search", {
    patternOperands: 1,
    options: [
      option(
        [
          "-E",
          "--exclude",
          "-e",
          "--extension",
          "-t",
          "--type",
          "--changed-before",
          "--changed-within",
          "--max-depth",
          "--min-depth",
          "--size",
        ],
        "ignore",
      ),
    ],
  }),
  grep: policy("search", {
    patternOperands: 1,
    options: [
      option(["-e", "--regexp"], "pattern"),
      option(["-f", "--file"], "pattern_file"),
      option(["--exclude-from"], "path"),
      option(
        [
          "-A",
          "-B",
          "-C",
          "--after-context",
          "--before-context",
          "--context",
          "--include",
          "--exclude",
        ],
        "ignore",
      ),
    ],
  }),
  rg: policy("search", {
    patternOperands: 1,
    options: [
      option(["-e", "--regexp"], "pattern"),
      option(["-f", "--file"], "pattern_file"),
      option(["--ignore-file"], "path"),
      option(
        [
          "-A",
          "-B",
          "-C",
          "-g",
          "--glob",
          "-t",
          "--type",
          "-T",
          "--type-not",
          "--encoding",
          "--engine",
          "--sort",
          "--sortr",
        ],
        "ignore",
      ),
    ],
  }),
  head: policy("paths", { options: [option(["-c", "--bytes", "-n", "--lines"], "ignore")] }),
  tail: policy("paths", {
    options: [option(["-c", "--bytes", "-n", "--lines", "-s", "--sleep-interval"], "ignore")],
  }),
  cut: policy("paths", {
    options: [
      option(
        [
          "-b",
          "--bytes",
          "-c",
          "--characters",
          "-d",
          "--delimiter",
          "-f",
          "--fields",
          "--output-delimiter",
        ],
        "ignore",
      ),
    ],
  }),
  uniq: policy("paths", {
    options: [
      option(["-f", "--skip-fields", "-s", "--skip-chars", "-w", "--check-chars"], "ignore"),
    ],
  }),
  ls: policy("paths", {
    options: [
      option(
        [
          "-I",
          "--ignore",
          "--block-size",
          "--color",
          "--format",
          "--hide",
          "--indicator-style",
          "--quoting-style",
          "--sort",
          "--time",
          "--time-style",
          "--tabsize",
          "--width",
        ],
        "ignore",
      ),
    ],
  }),
  chmod: METADATA_CHANGE,
  chown: METADATA_CHANGE,
  diff: policy("paths", { options: [option(["--output"], "path")] }),
  sort: policy("paths", { options: [option(["-o", "--output"], "path")] }),
  tee: PATHS,
  unzip: policy("paths", {
    maxPathOperands: 1,
    options: [option(["-d"], "path")],
  }),
  tar: policy("heuristic", {
    options: [
      option(["-f", "--file"], "path"),
      option(["--exclude"], "ignore"),
      option(["--exclude-from", "-X", "--files-from", "-T"], "path"),
      option(["-C", "--directory"], "path"),
    ],
  }),
  sed: policy("search", {
    patternOperands: 1,
    options: [option(["-e", "--expression"], "pattern"), option(["-f", "--file"], "pattern_file")],
  }),
  awk: policy("search", {
    patternOperands: 1,
    options: [option(["-f", "--file"], "pattern_file"), option(["-v"], "ignore")],
  }),
  jq: policy("search", {
    patternOperands: 1,
    options: [
      option(["-f", "--from-file"], "pattern_file"),
      option(["--arg", "--argjson"], ["ignore", "ignore"]),
      option(["--rawfile", "--slurpfile"], ["ignore", "path"]),
    ],
  }),
  curl: policy("none", {
    options: [
      option(["-d", "--data", "--data-binary", "--data-raw", "--data-urlencode"], "at_file"),
      option(["-K", "--config", "-T", "--upload-file", "--cert", "--key", "--cacert"], "path"),
    ],
  }),
  docker: policy("none", {
    options: [option(["-f", "--file", "--env-file", "-v", "--volume", "--mount"], "path")],
  }),
  kubectl: policy("none", { options: [option(["-f", "--filename", "--kubeconfig"], "path")] }),
  helm: policy("none", { options: [option(["-f", "--values", "--kubeconfig"], "path")] }),
  terraform: policy("none", {
    options: [option(["-chdir", "-var-file", "-state", "-state-out", "-plan"], "path")],
  }),
  gh: policy("none", { options: [option(["--body-file"], "path")] }),
  glab: policy("none", { options: [option(["--description-file"], "path")] }),
  npm: policy("none", { options: [option(["--prefix"], "path")] }),
  pnpm: policy("none", { options: [option(["--dir", "--cwd", "-C"], "path")] }),
  yarn: policy("none", { options: [option(["--cwd"], "path")] }),
  git: policy("heuristic", {
    options: [
      option(["-C", "--git-dir", "--work-tree"], "path"),
      option(["-m", "--message"], "ignore"),
    ],
  }),
  node: scriptPolicy(
    ["-e", "--eval", "-p", "--print"],
    [
      option(["-r", "--require", "--import", "--loader"], "heuristic_path"),
      option(["--input-type", "--title"], "ignore"),
    ],
  ),
  python: PYTHON_SCRIPT,
  python3: PYTHON_SCRIPT,
  ruby: scriptPolicy(["-e"]),
  perl: scriptPolicy(["-e", "-E"]),
  php: scriptPolicy(["-r"], [option(["-d"], "ignore"), option(["-f"], "path")]),
};

export function pathOperandPolicy(executable: string): PathOperandPolicy {
  return POLICIES[executable] ?? GENERIC;
}

export function pathValueForOption(
  executable: string,
  optionName: string,
  value: string,
): string | null {
  if (executable !== "docker") return value;
  if (optionName === "-v" || optionName === "--volume") {
    const source = value.split(":", 1)[0] ?? "";
    return isHostPath(source) ? source : null;
  }
  if (optionName === "--mount") {
    const fields = new Map(
      value.split(",").flatMap((field) => {
        const separator = field.indexOf("=");
        return separator > 0 ? [[field.slice(0, separator), field.slice(separator + 1)]] : [];
      }),
    );
    const source = fields.get("source") ?? fields.get("src");
    if (!source) return null;
    return fields.get("type") === "bind" || isHostPath(source) ? source : null;
  }
  return value;
}

function scriptPolicy(
  codeOptions: readonly string[],
  additionalOptions: readonly OptionDefinition[] = [],
): PathOperandPolicy {
  return policy("paths", {
    maxPathOperands: 1,
    options: [option(codeOptions, "ignore", true), ...additionalOptions],
  });
}

function policy(
  positional: PathOperandPolicy["positional"],
  options: PolicyOptions = {},
): PathOperandPolicy {
  return {
    positional,
    patternOperands: options.patternOperands ?? 0,
    ...(options.maxPathOperands === undefined ? {} : { maxPathOperands: options.maxPathOperands }),
    options: new Map(
      (options.options ?? []).flatMap((definition) =>
        definition.names.map((name) => [
          name,
          {
            operands: definition.operands,
            ...(definition.disablePositionals ? { disablePositionals: true } : {}),
          },
        ]),
      ),
    ),
  };
}

function option(
  names: readonly string[],
  operands: OptionOperandKind | readonly OptionOperandKind[],
  disablePositionals = false,
): OptionDefinition {
  return {
    names,
    operands: typeof operands === "string" ? [operands] : operands,
    ...(disablePositionals ? { disablePositionals: true } : {}),
  };
}

function isHostPath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/")
  );
}
