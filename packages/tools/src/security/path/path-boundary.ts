import path from "node:path";
import { normalizeForComparison } from "./normalize-path";

export function isWithinPath(
  target: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalizedTarget = normalizeForComparison(target, platform);
  const normalizedRoot = normalizeForComparison(root, platform);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}
