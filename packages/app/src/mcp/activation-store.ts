import { InterprocessFileLock } from "@omni-agent/core";
import { AtomicJsonFile } from "../persistence/atomic-json-file";
import { isMcpServerId, MAX_MCP_SERVERS } from "./config/types";

/** One file per workspace/Agent; configuration defines servers, this file owns switches. */
export class McpActivationStore {
  private readonly file: AtomicJsonFile<unknown>;
  private readonly lock: InterprocessFileLock;
  constructor(path: string) {
    this.file = new AtomicJsonFile(path);
    this.lock = new InterprocessFileLock(`${path}.lock`);
  }
  async read(): Promise<readonly string[]> {
    const value = await this.file.read();
    if (value === undefined) return [];
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("enabled" in value) ||
      !Array.isArray(value.enabled) ||
      value.enabled.length > MAX_MCP_SERVERS ||
      !value.enabled.every(isMcpServerId)
    ) {
      throw new Error("Invalid MCP activation settings");
    }
    return [...new Set(value.enabled as string[])];
  }
  set(id: string, enabled: boolean): Promise<void> {
    return this.lock.runExclusive(async () => {
      if (!isMcpServerId(id)) throw new Error("Invalid MCP server id");
      const ids = new Set(await this.read());
      if (enabled) ids.add(id);
      else ids.delete(id);
      if (ids.size > MAX_MCP_SERVERS) throw new Error("MCP server limit exceeded");
      await this.file.write({ version: 1, enabled: [...ids].sort() });
    });
  }
}
