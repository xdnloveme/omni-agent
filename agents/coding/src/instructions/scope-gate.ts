import path from "node:path";
import {
  assertPromptContributionBudget,
  escapeMarkupText,
  PROMPT_CONTRIBUTION_BUDGETS,
  type PreparedToolBatch,
  type RuntimePromptSection,
  type SystemPromptContributor,
  type ToolBatchPreparationDecision,
  type ToolBatchPreparationContext,
  type ToolBatchPreparationPolicy,
} from "@omni-agent/core";
import { ProjectInstructionDiscovery } from "./discovery";
import type { ProjectInstructionManifest } from "./manifest";

export class InstructionScopeGate implements ToolBatchPreparationPolicy {
  private active = new Map<string, ProjectInstructionManifest>();
  private baseline = new Map<string, ProjectInstructionManifest>();
  private checkpointId: string | undefined;

  private constructor(private readonly discovery: ProjectInstructionDiscovery) {}

  static async create(workspaceRoot: string): Promise<InstructionScopeGate> {
    return new InstructionScopeGate(await ProjectInstructionDiscovery.create(workspaceRoot));
  }

  readonly contributor: SystemPromptContributor = async () => {
    const manifests = await this.discovery.discoverForTarget(this.discovery.workspaceRoot);
    const baseline = new Map(manifests.map((manifest) => [manifest.path, manifest]));
    const content = this.renderActive(baseline);
    this.baseline = baseline;
    this.active = new Map(baseline);
    return content;
  };

  beginRun(): void {
    this.active = new Map(this.baseline);
    this.checkpointId = undefined;
  }

  onContextCheckpoint(checkpointId: string): void {
    if (this.checkpointId === checkpointId) return;
    this.checkpointId = checkpointId;
    // Summaries are not authoritative rule snapshots. Reload target rules before executing again.
    this.active = new Map(this.baseline);
  }

  async evaluate(
    batch: PreparedToolBatch,
    context: ToolBatchPreparationContext,
  ): Promise<ToolBatchPreparationDecision> {
    const ready = batch.calls.filter((call) => call.preparation === "ready");
    if (ready.some((call) => call.accessIntent?.filesystemMutation === "unbounded")) {
      return {
        kind: "failed",
        code: "project_instruction_scope_undetermined",
        message:
          "A potentially mutating command must declare bounded write_paths before project instructions can be determined.",
      };
    }
    const targets = new Set<string>([this.discovery.workspaceRoot]);
    for (const call of ready) {
      for (const resource of call.accessIntent?.resources ?? []) {
        if (resource.kind === "filesystem" && resource.location === "workspace") {
          targets.add(resource.path);
        }
      }
    }
    const snapshot = await this.resolveTargets([...targets]);
    if (!snapshot.changed) return { kind: "executable" };
    if (context.origin === "hook")
      return {
        kind: "failed",
        code: "project_instructions_not_activated",
        message:
          "Command Hook requires new or changed project rules to be considered by the Agent first.",
      };
    this.active = snapshot.manifests;
    return {
      kind: "deferred",
      code: "project_instructions_loaded",
      message:
        "The complete active project-rule snapshot follows. It replaces earlier project-rule snapshots; removed sources no longer apply. Reissue the call after considering it.",
      promptSections: [this.runtimeSection()],
    };
  }

  private async resolveTargets(
    targets: readonly string[],
  ): Promise<{ changed: boolean; manifests: Map<string, ProjectInstructionManifest> }> {
    const next = new Map(this.active);
    let changed = false;
    for (const target of targets) {
      const manifests = await this.discovery.discoverForTarget(target);
      const discoveredPaths = new Set(manifests.map((manifest) => manifest.path));
      const absoluteTarget = path.resolve(this.discovery.workspaceRoot, target);
      for (const [manifestPath, active] of next) {
        if (isWithin(active.appliesTo, absoluteTarget) && !discoveredPaths.has(manifestPath)) {
          next.delete(manifestPath);
          changed = true;
        }
      }
      for (const manifest of manifests) {
        const previous = next.get(manifest.path);
        if (previous?.digest === manifest.digest) {
          next.set(manifest.path, manifest);
          continue;
        }
        next.set(manifest.path, manifest);
        changed = true;
      }
    }
    // Only a completely discovered, budget-valid snapshot may be considered active.
    this.renderActive(next);
    return { changed, manifests: next };
  }

  private runtimeSection(): RuntimePromptSection {
    return {
      id: "coding.project-instructions.active",
      owner: "project_instructions",
      priority: 100,
      lifetime: "run",
      content: this.renderActive() ?? "No active AGENTS.md instructions remain in this workspace.",
    };
  }

  private renderActive(active = this.active): string | null {
    const manifests = [...active.values()].sort(
      (left, right) =>
        left.appliesTo.split(path.sep).length - right.appliesTo.split(path.sep).length ||
        left.appliesTo.localeCompare(right.appliesTo),
    );
    if (manifests.length === 0) return null;
    const content = [
      "# Project Rules",
      "",
      ...manifests.flatMap((manifest) => [
        `<project_rules source="${escapeMarkupText(manifest.path)}" applies_to="${escapeMarkupText(manifest.appliesTo)}" lineage="${escapeMarkupText(manifest.lineage.join(" -> "))}">`,
        escapeMarkupText(manifest.content.trim()),
        "</project_rules>",
      ]),
    ].join("\n");
    assertPromptContributionBudget(
      "project rules",
      content,
      PROMPT_CONTRIBUTION_BUDGETS.projectRules,
    );
    return content;
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}
