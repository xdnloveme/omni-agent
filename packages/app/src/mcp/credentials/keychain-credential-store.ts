import { createHash } from "node:crypto";
import keytar from "keytar";
import type { McpCredentialStore } from "./credential-store";

const SERVICE = "omni-agent-mcp";

/** Keychain is the sole persistent owner; token values never enter app configuration. */
export class KeychainMcpCredentialStore implements McpCredentialStore {
  async get(id: string): Promise<string | undefined> {
    return (await keytar.getPassword(SERVICE, account(id))) ?? undefined;
  }
  async set(id: string, value: string): Promise<void> {
    if (!value) throw new Error("MCP credential cannot be empty");
    await keytar.setPassword(SERVICE, account(id), value);
  }
  async delete(id: string): Promise<void> {
    await keytar.deletePassword(SERVICE, account(id));
  }
}

function account(id: string): string {
  if (!id) throw new Error("Invalid MCP credential id");
  return `credential:${createHash("sha256").update(id, "utf8").digest("hex")}`;
}
