import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HostProcessLink, HostProcessSupervisor } from "../packages/im-gateway/src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const stateDirectory = await mkdtemp(join(tmpdir(), "omni-im-verify-"));
const configurationDirectory = join(stateDirectory, "configuration");
await mkdir(configurationDirectory);
await Promise.all(
  ["omni.config.json", "omni.providers.json"].map((name) =>
    copyFile(join(repositoryRoot, name), join(configurationDirectory, name)),
  ),
);
const supervisor = new HostProcessSupervisor({
  mode: "managed",
  entryPath: join(repositoryRoot, "apps", "omni", "src", "im-agent-host-entry.ts"),
  projectDirectory: repositoryRoot,
  stateDirectory,
  agentId: "coding",
});
const link = new HostProcessLink(supervisor);

try {
  const agents = await link.listAgents();
  const coding = agents.find((agent) => agent.id === "coding");
  if (!coding) throw new Error("IM Agent Host did not expose the coding Agent");
  const created = await link.createConversation(coding.id);
  await link.closeConversation(created);
  const restored = await link.openConversation(created.agentId, created.sessionId);
  if (restored.sessionId !== created.sessionId) {
    throw new Error("IM Agent Host did not restore the created Session");
  }
  await link.closeConversation(restored);
  process.stdout.write(
    `${JSON.stringify({
      type: "im_agent_link_verified",
      version: 1,
      agents: agents.map(({ id }) => id),
      sessionRestored: true,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await link.dispose().catch(() => undefined);
  await rm(stateDirectory, { recursive: true, force: true });
}
