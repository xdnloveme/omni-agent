import { join } from "node:path";
import {
  ApproximateContextTokenEstimator,
  ArtifactProjectionStrategy,
  ContextPolicyPipeline,
  DefaultContextEngine,
  HeavyCheckpointGateStage,
  SKILL_TOOL_NAME,
  StableMicroCompressionStage,
  ThinkingProjectionStrategy,
  type AgentConfig,
  type ContextArtifactRecoveryCapability,
  type ContextPolicyStagePort,
  type MicroProjectionStrategyPort,
  type ModelCacheLeaseAdvisorPort,
  type ModelRuntimePort,
} from "@omni-agent/core";
import { CacheBackedContextRewriteGuard } from "./cacheRewriteGuard";
import { ContextCheckpointRepository } from "./checkpointRepository";
import { ContextProjectionRepository } from "./projectionRepository";
import { RuntimeContextSummaryGenerator } from "./runtimeSummaryGenerator";
import { ContextSidecarLayout } from "./sidecarLayout";
import { ContextSidecarLifecycle } from "./sidecarLifecycle";

export function createContextRuntime(input: {
  readonly agentId: string;
  readonly sessionsRoot: string;
  readonly agentConfig: AgentConfig;
  readonly artifactRecovery?: ContextArtifactRecoveryCapability;
  readonly policyStages: readonly ContextPolicyStagePort[];
  readonly skillStrategies?: readonly MicroProjectionStrategyPort[];
  readonly modelRuntime: ModelRuntimePort;
  readonly cacheLeaseAdvisor: ModelCacheLeaseAdvisorPort;
  readonly onDiagnostic: (message: string) => void;
}) {
  assertArtifactRecovery(input.artifactRecovery, input.agentConfig);
  const layout = new ContextSidecarLayout(join(input.sessionsRoot, input.agentId, "context"));
  const checkpoints = new ContextCheckpointRepository(layout, input.onDiagnostic);
  const projections = new ContextProjectionRepository(layout, input.onDiagnostic);
  const estimator = new ApproximateContextTokenEstimator();
  const skillStrategies = input.skillStrategies ?? [];
  const hasSkillProjection = skillStrategies.some((strategy) => strategy.key === "skill");
  const microStrategies: MicroProjectionStrategyPort[] = [
    new ArtifactProjectionStrategy(
      projections,
      input.artifactRecovery,
      hasSkillProjection ? [SKILL_TOOL_NAME] : [],
    ),
    ...skillStrategies,
    new ThinkingProjectionStrategy(
      () => input.agentConfig.model.thinkingHistoryPolicy ?? "preserve_all",
    ),
  ];
  const stableMicro = new StableMicroCompressionStage({
    projections,
    estimator,
    rewriteGuard: new CacheBackedContextRewriteGuard(
      input.cacheLeaseAdvisor,
      () => input.agentConfig.model,
    ),
    strategies: microStrategies,
  });
  const summaryGenerator = new RuntimeContextSummaryGenerator(
    input.modelRuntime,
    () => input.agentConfig.model,
  );
  return {
    contextEngine: new DefaultContextEngine(
      new ContextPolicyPipeline(
        [...input.policyStages, stableMicro],
        new HeavyCheckpointGateStage(checkpoints, summaryGenerator, estimator),
        estimator,
      ),
    ),
    contextStorage: new ContextSidecarLifecycle(layout),
  };
}

function assertArtifactRecovery(
  capability: ContextArtifactRecoveryCapability | undefined,
  config: AgentConfig,
): void {
  if (!capability) return;
  if (!capability.toolName.trim() || !capability.instruction.trim()) {
    throw new Error("Context artifact recovery capability requires a tool and instruction");
  }
  if (!config.tools.some((tool) => tool.name === capability.toolName)) {
    throw new Error(`Context artifact recovery tool is not exposed: ${capability.toolName}`);
  }
}
