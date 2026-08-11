import path from "node:path";
import { normalizeForComparison } from "./normalize-path";

export function isWithinPath(target: string, root: string): boolean {
  const normalizedTarget = normalizeForComparison(target);
  const normalizedRoot = normalizeForComparison(root);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}
