import type { ModelCacheReport } from "@omni-agent/core";
import type { ModelCacheLeaseRepository } from "./model-cache-lease-repository";

export interface ModelCacheLeaseRuntime {
  hydrateCacheLease(snapshot: unknown): string | undefined;
  snapshotCacheLease(scopeId: string): unknown | undefined;
  forgetCacheLease(scopeId: string): void;
}

export class ModelCacheLeaseController {
  private readonly hydratedSessions = new Set<string>();
  private readonly sessionScopes = new Map<string, Set<string>>();

  constructor(
    private readonly runtime: ModelCacheLeaseRuntime,
    private readonly repository: ModelCacheLeaseRepository,
    private readonly onDiagnostic?: (message: string) => void,
  ) {}

  async hydrate(sessionId: string): Promise<void> {
    if (this.hydratedSessions.has(sessionId)) return;
    this.hydratedSessions.add(sessionId);
    try {
      const snapshot = await this.repository.load(sessionId);
      if (snapshot === undefined) return;
      const scopeId = this.runtime.hydrateCacheLease(snapshot);
      if (scopeId) this.remember(sessionId, scopeId);
    } catch (error) {
      this.hydratedSessions.delete(sessionId);
      this.diagnose("load", error);
    }
  }

  async persist(sessionId: string, report: ModelCacheReport): Promise<void> {
    if (report.outcome !== "success" || report.appliedRetention === "none") return;
    const snapshot = this.runtime.snapshotCacheLease(report.scopeId);
    if (snapshot === undefined) {
      this.onDiagnostic?.("Model cache lease snapshot was unavailable after a successful call");
      return;
    }
    try {
      await this.repository.save(sessionId, snapshot);
      this.remember(sessionId, report.scopeId);
    } catch (error) {
      this.diagnose("save", error);
    }
  }

  forget(sessionId: string): void {
    for (const scopeId of this.sessionScopes.get(sessionId) ?? []) {
      this.runtime.forgetCacheLease(scopeId);
    }
    this.sessionScopes.delete(sessionId);
    this.hydratedSessions.delete(sessionId);
  }

  private remember(sessionId: string, scopeId: string): void {
    const scopes = this.sessionScopes.get(sessionId) ?? new Set<string>();
    scopes.add(scopeId);
    this.sessionScopes.set(sessionId, scopes);
  }

  private diagnose(operation: "load" | "save", error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const impact = operation === "load" ? "continuing cold" : "future resume may start cold";
    this.onDiagnostic?.(`Model cache lease ${operation} failed; ${impact}: ${message}`);
  }
}
