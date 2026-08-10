import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ModelsStore,
  ModelsStoreEntry,
  ModelsStoreOperationOptions,
} from "@earendil-works/pi-ai";
import { AtomicJsonFile } from "../storage/atomic-json-file";

export class FileModelsStore implements ModelsStore {
  constructor(private readonly directory = join(homedir(), ".omni-agent", "models")) {}

  async read(
    providerId: string,
    options?: ModelsStoreOperationOptions,
  ): Promise<ModelsStoreEntry | undefined> {
    throwIfAborted(options);
    const entry = await this.file(providerId).read();
    throwIfAborted(options);
    return entry;
  }

  async write(
    providerId: string,
    entry: ModelsStoreEntry,
    options?: ModelsStoreOperationOptions,
  ): Promise<void> {
    throwIfAborted(options);
    await this.file(providerId).write(entry, () => throwIfAborted(options));
  }

  async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
    throwIfAborted(options);
    await this.file(providerId).remove();
  }

  private file(providerId: string): AtomicJsonFile<ModelsStoreEntry> {
    return new AtomicJsonFile(join(this.directory, `${encodeURIComponent(providerId)}.json`));
  }
}

function throwIfAborted(options?: ModelsStoreOperationOptions): void {
  if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
