import Parser from "tree-sitter";
import Bash from "tree-sitter-bash";

let parser: Parser | undefined;

export function parseBashSyntax(source: string): Parser.Tree {
  const active = parser ?? createParser();
  return active.parse(source);
}

function createParser(): Parser {
  const created = new Parser();
  created.setLanguage(Bash as Parser.Language);
  parser = created;
  return created;
}
