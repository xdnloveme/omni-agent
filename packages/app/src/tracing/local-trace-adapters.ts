import { LocalTraceStore } from "./local-trace-store";
import { TraceQueryService, type TraceQueryPort } from "./trace-query-service";
import { TraceStorageLayout } from "./trace-storage-layout";

export interface TraceMaintenancePort {
  diskUsage(): Promise<number>;
  clear(): Promise<void>;
}

export function createLocalTraceQuery(globalDirectory: string, agentId: string): TraceQueryPort {
  return new TraceQueryService(createStore(globalDirectory, agentId));
}

export function createLocalTraceMaintenance(
  globalDirectory: string,
  agentId: string,
): TraceMaintenancePort {
  const store = createStore(globalDirectory, agentId);
  return {
    diskUsage: () => store.diskUsage(),
    clear: () => store.clear(),
  };
}

function createStore(globalDirectory: string, agentId: string): LocalTraceStore {
  return new LocalTraceStore(new TraceStorageLayout(globalDirectory, agentId));
}
