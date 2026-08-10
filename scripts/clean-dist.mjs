import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const workspaceRoot = join(import.meta.dirname, "..");

for (const group of ["packages", "agents"]) {
  const groupDirectory = join(workspaceRoot, group);
  for (const entry of await readdir(groupDirectory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await rm(join(groupDirectory, entry.name, "dist"), { recursive: true, force: true });
    }
  }
}
