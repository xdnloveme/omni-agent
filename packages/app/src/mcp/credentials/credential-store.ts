export interface McpCredentialStore {
  get(id: string): Promise<string | undefined>;
  set(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
}
export class InMemoryMcpCredentialStore implements McpCredentialStore {
  readonly #values = new Map<string, string>();
  async get(id: string): Promise<string | undefined> {
    return this.#values.get(id);
  }
  async set(id: string, value: string): Promise<void> {
    this.#values.set(id, value);
  }
  async delete(id: string): Promise<void> {
    this.#values.delete(id);
  }
}
