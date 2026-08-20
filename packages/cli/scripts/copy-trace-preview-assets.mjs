import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(packageRoot, "src", "tracing-preview", "assets");
const target = join(packageRoot, "dist", "tracing-preview", "assets");

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
