import path from "node:path";
import type Parser from "tree-sitter";
import { parseBashSyntax } from "./bash-syntax-parser";
import type {
  ShellAssignment,
  ShellCommandView,
  ShellProgram,
  ShellProgramStatus,
  ShellRedirection,
  ShellStatement,
  ShellWord,
  ShellWordPart,
} from "./shell-program";
import { nestedProgramsOfWord } from "./shell-program";

const TRANSPARENT_CONTAINERS = new Set(["do_group", "else_clause", "elif_clause", "then"]);

interface AdapterState {
  unsupported: boolean;
}

export function parseShellProgram(source: string): ShellProgram {
  const tree = parseBashSyntax(source);
  return adaptProgram(tree.rootNode);
}

function adaptProgram(node: Parser.SyntaxNode): ShellProgram {
  const state: AdapterState = { unsupported: false };
  const body = adaptChildren(node, state);
  const status = programStatus(node, state.unsupported);
  return { body, status };
}

function adaptChildren(node: Parser.SyntaxNode, state: AdapterState): ShellStatement[] {
  const statements: ShellStatement[] = [];
  for (const child of node.namedChildren) {
    if (child.type === "comment") continue;
    const statement = adaptStatement(child, state);
    if (statement) {
      statements.push(
        child.nextSibling?.text === "&" ? { kind: "background", statement } : statement,
      );
    }
  }
  return statements;
}

function adaptStatement(node: Parser.SyntaxNode, state: AdapterState): ShellStatement | null {
  switch (node.type) {
    case "command":
      return { kind: "command", command: adaptCommand(node, state) };
    case "variable_assignment":
      return adaptAssignmentStatement(node, state);
    case "pipeline":
      return { kind: "pipeline", statements: adaptChildren(node, state) };
    case "list":
      return adaptList(node, state);
    case "redirected_statement":
      return adaptRedirected(node, state);
    case "subshell":
      return { kind: "group", statements: adaptChildren(node, state), scoped: true };
    case "compound_statement":
      return { kind: "group", statements: adaptChildren(node, state), scoped: false };
    case "if_statement":
      return adaptUnsupported(node, state);
    case "function_definition":
      return adaptFunction(node, state);
    default:
      if (TRANSPARENT_CONTAINERS.has(node.type)) {
        return { kind: "group", statements: adaptChildren(node, state), scoped: false };
      }
      return adaptUnsupported(node, state);
  }
}

function adaptFunction(node: Parser.SyntaxNode, state: AdapterState): ShellStatement {
  const name = node.childForFieldName("name")?.text;
  const body = node.childForFieldName("body");
  if (!name || !body) return adaptUnsupported(node, state);
  state.unsupported = true;
  return { kind: "function", name, statements: adaptChildren(body, state) };
}

function adaptCommand(node: Parser.SyntaxNode, state: AdapterState): ShellCommandView {
  const nameNode = node.childForFieldName("name");
  const executable = nameNode ? adaptWord(nameNode, state) : null;
  const assignments = node.namedChildren
    .filter((child) => child.type === "variable_assignment")
    .map((child) => adaptAssignment(child, state))
    .filter((value): value is ShellAssignment => value !== null);
  const argumentNodes = node.childrenForFieldName("argument");
  const arguments_ = argumentNodes.map((child) => adaptWord(child, state));
  const redirections = node.namedChildren
    .filter(isRedirectionNode)
    .map((child) => adaptRedirection(child, state));
  const nested = [
    ...(executable ? nestedProgramsOfWord(executable) : []),
    ...arguments_.flatMap(nestedProgramsOfWord),
    ...redirections.flatMap((redirection) =>
      redirection.target ? nestedProgramsOfWord(redirection.target) : [],
    ),
  ];
  const executableName = executable?.staticValue
    ? path.basename(executable.staticValue).toLowerCase()
    : "";
  return {
    raw: node.text,
    executable,
    executableName,
    arguments: arguments_,
    argumentValues: arguments_.map((word) => word.staticValue ?? word.value),
    leadingAssignments: assignments,
    redirections,
    nested,
    span: span(node),
  };
}

function adaptAssignmentStatement(node: Parser.SyntaxNode, state: AdapterState): ShellStatement {
  const assignment = adaptAssignment(node, state);
  if (!assignment) return adaptUnsupported(node, state);
  return { kind: "assignment", assignment, nested: nestedProgramsOfWord(assignment.value) };
}

function adaptAssignment(node: Parser.SyntaxNode, state: AdapterState): ShellAssignment | null {
  const name = node.childForFieldName("name")?.text;
  const valueNode = node.childForFieldName("value");
  if (!name) return null;
  if (valueNode) return { name, value: adaptWord(valueNode, state) };
  if (node.text !== `${name}=`) return null;
  return {
    name,
    value: {
      raw: "",
      value: "",
      staticValue: "",
      parts: [{ kind: "literal", value: "" }],
      span: { startByte: node.endIndex, endByte: node.endIndex },
    },
  };
}

function adaptList(node: Parser.SyntaxNode, state: AdapterState): ShellStatement {
  const operands = node.namedChildren
    .map((child) => adaptStatement(child, state))
    .filter((value): value is ShellStatement => value !== null);
  if (operands.length < 2) return adaptUnsupported(node, state);
  const operator = node.children.find(
    (child) => !child.isNamed && ["&&", "||", ";"].includes(child.text),
  )?.text as "&&" | "||" | ";" | undefined;
  if (!operator) return adaptUnsupported(node, state);
  return operands
    .slice(1)
    .reduce<ShellStatement>(
      (left, right) => ({ kind: "list", operator, left, right }),
      operands[0]!,
    );
}

function adaptRedirected(node: Parser.SyntaxNode, state: AdapterState): ShellStatement {
  const bodyNode = node.childForFieldName("body");
  const body = bodyNode ? adaptStatement(bodyNode, state) : null;
  if (!body) return adaptUnsupported(node, state);
  const redirectNodes = node.childrenForFieldName("redirect");
  const redirections = redirectNodes.map((child) => adaptRedirection(child, state));
  const nested = redirectNodes.flatMap(nestedPrograms);
  if (body.kind === "list" || body.kind === "pipeline") {
    return attachTerminalRedirection(body, redirections, nested);
  }
  return { kind: "redirected", statement: body, redirections, nested };
}

function attachTerminalRedirection(
  statement: ShellStatement,
  redirections: readonly ShellRedirection[],
  nested: readonly ShellProgram[],
): ShellStatement {
  if (statement.kind === "list") {
    return {
      ...statement,
      right: attachTerminalRedirection(statement.right, redirections, nested),
    };
  }
  if (statement.kind === "pipeline") {
    const statements = [...statement.statements];
    const last = statements.pop();
    if (!last) return statement;
    return {
      ...statement,
      statements: [...statements, attachTerminalRedirection(last, redirections, nested)],
    };
  }
  return { kind: "redirected", statement, redirections, nested };
}

function adaptRedirection(node: Parser.SyntaxNode, state: AdapterState): ShellRedirection {
  const targetNode = node.childForFieldName("destination");
  const descriptor = node.childForFieldName("descriptor")?.text;
  const operator =
    node.children.find((child) => !child.isNamed && /[<>]/.test(child.text))?.text ??
    (node.type === "heredoc_redirect" ? "<<" : "");
  const duplicatesDescriptor =
    (operator === ">&" || operator === "<&") && /^(?:\d+|-)$/.test(targetNode?.text ?? "");
  return {
    operator,
    ...(targetNode && !duplicatesDescriptor ? { target: adaptWord(targetNode, state) } : {}),
    ...(descriptor && /^\d+$/.test(descriptor) ? { sourceFd: Number(descriptor) } : {}),
  };
}

function adaptWord(node: Parser.SyntaxNode, state: AdapterState): ShellWord {
  const parts = adaptWordParts(node, state);
  const staticValue = staticWordValue(parts);
  return {
    raw: node.text,
    value: staticValue ?? stripOuterQuotes(node.text),
    ...(staticValue === undefined ? {} : { staticValue }),
    parts,
    span: span(node),
  };
}

function adaptWordParts(node: Parser.SyntaxNode, state: AdapterState): ShellWordPart[] {
  if (node.type === "word") {
    return [{ kind: "literal", value: decodeUnquoted(node.text) }];
  }
  if (node.type === "raw_string" || node.type === "heredoc_content") {
    return [{ kind: "literal", value: stripOuterQuotes(node.text) }];
  }
  if (node.type === "string_content") {
    return [{ kind: "literal", value: decodeDoubleQuoted(node.text) }];
  }
  if (
    node.type === "simple_expansion" ||
    (node.type === "expansion" &&
      node.namedChildren.filter((child) => child.type !== "variable_name").length === 0)
  ) {
    const name = node.namedChildren.find((child) => child.type === "variable_name")?.text;
    return name ? [{ kind: "parameter", name }] : [{ kind: "unresolved", syntaxType: node.type }];
  }
  if (node.type === "command_substitution") {
    return [{ kind: "command_output", program: adaptProgram(node) }];
  }
  if (node.type === "process_substitution") {
    return [{ kind: "process_substitution", program: adaptProgram(node) }];
  }
  if (node.type === "command_name" && node.namedChildCount === 1) {
    return adaptWordParts(node.namedChild(0)!, state);
  }
  if (["string", "concatenation"].includes(node.type)) {
    return node.namedChildren.flatMap((child) => adaptWordParts(child, state));
  }
  if (node.namedChildCount === 0) {
    return [{ kind: "literal", value: stripOuterQuotes(node.text) }];
  }
  state.unsupported = true;
  return [{ kind: "unresolved", syntaxType: node.type }];
}

function nestedPrograms(node: Parser.SyntaxNode): ShellProgram[] {
  if (["command_substitution", "process_substitution"].includes(node.type)) {
    return [adaptProgram(node)];
  }
  return node.namedChildren.flatMap(nestedPrograms);
}

function adaptUnsupported(node: Parser.SyntaxNode, state: AdapterState): ShellStatement {
  state.unsupported = true;
  return {
    kind: "unsupported",
    statements: adaptChildren(node, state),
    syntaxType: node.type,
  };
}

function programStatus(node: Parser.SyntaxNode, unsupported: boolean): ShellProgramStatus {
  if (node.hasError || containsMissing(node)) return "partial";
  return unsupported ? "unsupported" : "complete";
}

function containsMissing(node: Parser.SyntaxNode): boolean {
  return node.isMissing || node.namedChildren.some(containsMissing);
}

function staticWordValue(parts: readonly ShellWordPart[]): string | undefined {
  if (!parts.every((part) => part.kind === "literal")) return undefined;
  return parts.map((part) => (part.kind === "literal" ? part.value : "")).join("");
}

function stripOuterQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value[0] === "'" && value.at(-1) === "'") || (value[0] === '"' && value.at(-1) === '"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function decodeUnquoted(value: string): string {
  return value.replace(/\\([\s\S])/g, (_, escaped: string) => (escaped === "\n" ? "" : escaped));
}

function decodeDoubleQuoted(value: string): string {
  return value.replace(/\\([\\"$`\n])/g, (_, escaped: string) => (escaped === "\n" ? "" : escaped));
}

function isRedirectionNode(node: Parser.SyntaxNode): boolean {
  return node.type.endsWith("redirect");
}

function span(node: Parser.SyntaxNode) {
  return { startByte: node.startIndex, endByte: node.endIndex };
}
