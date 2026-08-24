import { stat } from "node:fs/promises";
import { throwIfAborted } from "@omni-agent/core";
import { SharedOperation } from "./shared-operation";

const DEFAULT_MAX_ENTRIES = 256;

interface CachedValue<T> {
  readonly version: string;
  readonly value: T;
}

/** Caches file-derived facts while preserving per-caller cancellation. */
export class VersionedFileComputationCache<T> {
  private readonly values = new Map<string, CachedValue<T>>();
  private readonly inFlight = new Map<string, SharedOperation<T>>();

  constructor(private readonly maximumEntries = DEFAULT_MAX_ENTRIES) {}

  async get(
    pathname: string,
    signal: AbortSignal | undefined,
    compute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    throwIfAborted(signal);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const version = await fileVersion(pathname);
      const cached = this.values.get(pathname);
      if (cached?.version === version) {
        this.touch(pathname, cached);
        return cached.value;
      }

      const flightKey = `${pathname}\0${version}`;
      const flight =
        this.inFlight.get(flightKey) ?? this.start(flightKey, pathname, version, compute);
      try {
        return await flight.wait(signal);
      } catch (error) {
        if (error instanceof FileChangedDuringComputation && attempt === 0) continue;
        throw error;
      }
    }
    throw new FileChangedDuringComputation();
  }

  private start(
    flightKey: string,
    pathname: string,
    version: string,
    compute: (signal: AbortSignal) => Promise<T>,
  ): SharedOperation<T> {
    let flight!: SharedOperation<T>;
    const removeFlight = () => {
      if (this.inFlight.get(flightKey) === flight) this.inFlight.delete(flightKey);
    };
    flight = new SharedOperation(async (signal) => {
      const value = await compute(signal);
      if ((await fileVersion(pathname)) !== version) throw new FileChangedDuringComputation();
      this.store(pathname, { version, value });
      return value;
    }, removeFlight);
    flight.completion.then(
      () => removeFlight(),
      () => removeFlight(),
    );
    this.inFlight.set(flightKey, flight);
    return flight;
  }

  private store(pathname: string, value: CachedValue<T>): void {
    this.values.delete(pathname);
    this.values.set(pathname, value);
    while (this.values.size > this.maximumEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }

  private touch(pathname: string, value: CachedValue<T>): void {
    this.values.delete(pathname);
    this.values.set(pathname, value);
  }
}

async function fileVersion(pathname: string): Promise<string> {
  const metadata = await stat(pathname, { bigint: true });
  return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs]
    .map(String)
    .join(":");
}

class FileChangedDuringComputation extends Error {}
