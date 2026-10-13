export function fakeHostSource(wsPath: string, observationPath: string, ready = true): string {
  return `
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
const { WebSocketServer } = createRequire(import.meta.url)(${JSON.stringify(wsPath)});
await writeFile(${JSON.stringify(observationPath)}, JSON.stringify({
  pid: process.pid,
  environment: Object.keys(process.env),
}));
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
server.on("connection", (socket) => {
  let authenticated = false;
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (!authenticated) {
      authenticated = true;
      socket.send(JSON.stringify({ v: 2, type: "ready", connectionId: "fake" }));
      return;
    }
    if (message.type === "list_agents") {
      socket.send(JSON.stringify({
        v: 2,
        type: "result",
        id: message.id,
        result: {
          kind: "agents",
          agents: [{
            id: "coding",
            displayName: "Coding",
            description: "Coding Agent",
            packageName: "@test/coding",
            packageVersion: "1.0.0"
          }]
        }
      }));
    }
  });
  socket.once("close", () => server.close(() => process.exit(0)));
});
server.once("listening", () => {
  const address = server.address();
  if (${ready}) process.stdout.write(JSON.stringify({
    type: "agent_host_ready",
    version: 2,
    host: "127.0.0.1",
    port: address.port
  }) + "\\n");
});
process.once("SIGTERM", () => server.close(() => process.exit(0)));
`;
}

export async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Managed Host process ${pid} did not exit`);
}
