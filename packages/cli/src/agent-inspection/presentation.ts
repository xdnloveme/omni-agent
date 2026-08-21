import type {
  AgentDescriptionDocument,
  AgentInspectionDocument,
  AgentInspectionErrorDocument,
  AgentCompositionPlanDocument,
} from "./types";

export function presentInspectionDocument(
  document: AgentInspectionDocument,
  json: boolean,
): string {
  if (json) return `${JSON.stringify(document, null, 2)}\n`;
  switch (document.kind) {
    case "AgentDescription":
      return presentDescription(document);
    case "AgentValidation":
      return `Agent ${document.agentId} is valid (${document.packageName}@${document.packageVersion}).\n`;
    case "AgentCompositionPlan":
      return presentPlan(document);
    case "AgentInspectionError":
      return presentError(document);
  }
}

function presentDescription(document: AgentDescriptionDocument): string {
  const descriptor = document.descriptor;
  const lines = [
    `${document.displayName} (${document.agentId})`,
    document.description,
    `Package: ${document.packageName}@${document.packageVersion}`,
    "",
    "Prompt profiles",
    ...components(descriptor.promptProfiles),
    "",
    "Prompt contributors",
    ...components(descriptor.promptContributors),
    "",
    "Tool bundles",
    ...descriptor.toolBundles.flatMap((bundle) => [
      `  ${bundle.id} — ${bundle.displayName}`,
      `    ${bundle.description}`,
      `    Tools: ${bundle.tools.join(", ") || "(none)"}`,
    ]),
    "",
    "Tools",
    ...descriptor.tools.flatMap((tool) => [
      `  ${tool.id} -> ${tool.toolName} — ${tool.displayName}`,
      `    ${tool.description}${dependencies(tool)}`,
    ]),
    "",
    "Capabilities",
    ...components([...descriptor.capabilities.skills, ...descriptor.capabilities.artifactRecovery]),
  ];
  return `${lines.join("\n")}\n`;
}

function presentPlan(document: AgentCompositionPlanDocument): string {
  const composition = document.composition;
  const capabilityIds = [
    composition.capabilities.skillsId,
    composition.capabilities.artifactRecoveryId,
  ].filter((id): id is string => id !== undefined);
  return `${[
    `Resolved composition for ${document.agentId}`,
    `Package: ${document.packageName}@${document.packageVersion}`,
    "",
    `Prompt profile: ${composition.prompt.profileId}`,
    "Prompt contributors:",
    ...ordered(composition.prompt.contributorIds),
    "",
    "Tools:",
    ...composition.tools.componentIds.map(
      (id, index) => `  ${index + 1}. ${id} -> ${composition.tools.toolNames[index]}`,
    ),
    "",
    "Capabilities:",
    ...ordered(capabilityIds),
  ].join("\n")}\n`;
}

function presentError(document: AgentInspectionErrorDocument): string {
  const location = document.error.path
    ? ` at ${document.error.path}`
    : document.error.source
      ? ` at ${document.error.source}${document.error.line ? `:${document.error.line}:${document.error.column}` : ""}`
      : "";
  return `Agent ${document.action} failed [${document.error.code}]${location}: ${document.error.message}\n`;
}

function components(
  values: readonly {
    id: string;
    displayName: string;
    description: string;
    requiresCapabilities?: readonly string[];
    requiresTools?: readonly string[];
  }[],
): string[] {
  if (values.length === 0) return ["  (none)"];
  return values.flatMap((component) => [
    `  ${component.id} — ${component.displayName}`,
    `    ${component.description}${dependencies(component)}`,
  ]);
}

function dependencies(component: {
  requiresCapabilities?: readonly string[];
  requiresTools?: readonly string[];
}): string {
  const values = [
    ...(component.requiresCapabilities?.map((id) => `capability:${id}`) ?? []),
    ...(component.requiresTools?.map((id) => `tool:${id}`) ?? []),
  ];
  return values.length > 0 ? ` (requires ${values.join(", ")})` : "";
}

function ordered(values: readonly string[]): string[] {
  return values.length === 0
    ? ["  (none)"]
    : values.map((value, index) => `  ${index + 1}. ${value}`);
}
