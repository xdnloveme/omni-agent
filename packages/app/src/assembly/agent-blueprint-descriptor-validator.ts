import { isToolOriginId } from "@omni-agent/core";
import type {
  AgentBlueprintDescriptor,
  ComponentDescriptor,
  DependentComponentDescriptor,
  ToolBundleDescriptor,
  ToolComponentDescriptor,
} from "./contracts";
import { deepFreeze } from "./deep-freeze";

const TOOL_NAME = /^[a-z][a-z0-9_-]*$/;

export function validateAgentBlueprintDescriptor(value: unknown): AgentBlueprintDescriptor {
  const descriptor = record(value, "Agent Blueprint descriptor");
  assertExactKeys(descriptor, [
    "promptProfiles",
    "promptContributors",
    "toolBundles",
    "tools",
    "capabilities",
  ]);
  const capabilities = record(descriptor.capabilities, "Agent Blueprint capabilities");
  assertExactKeys(capabilities, ["skills", "artifactRecovery"]);

  const result: AgentBlueprintDescriptor = {
    promptProfiles: componentList(descriptor.promptProfiles, "promptProfiles"),
    promptContributors: dependentList(descriptor.promptContributors, "promptContributors"),
    toolBundles: bundleList(descriptor.toolBundles),
    tools: toolList(descriptor.tools),
    capabilities: {
      skills: componentList(capabilities.skills, "capabilities.skills"),
      artifactRecovery: dependentList(
        capabilities.artifactRecovery,
        "capabilities.artifactRecovery",
      ),
    },
  };
  assertUniqueIds(result.promptProfiles, "promptProfiles");
  assertUniqueIds(result.promptContributors, "promptContributors");
  assertUniqueIds(result.toolBundles, "toolBundles");
  assertUniqueIds(result.tools, "tools");
  assertUniqueIds(result.capabilities.skills, "capabilities.skills");
  assertUniqueIds(result.capabilities.artifactRecovery, "capabilities.artifactRecovery");

  const toolIds = new Set(result.tools.map(({ id }) => id));
  for (const bundle of result.toolBundles) {
    assertUnique(bundle.tools, `Tool bundle ${bundle.id}`);
    for (const toolId of bundle.tools) {
      if (!toolIds.has(toolId)) {
        throw new Error(`Tool bundle ${bundle.id} references unknown Tool component: ${toolId}`);
      }
    }
  }
  return deepFreeze(result);
}

function componentList(value: unknown, label: string): readonly ComponentDescriptor[] {
  return array(value, label).map((entry, index) => {
    const component = record(entry, `${label}[${index}]`);
    assertExactKeys(component, ["id", "displayName", "description"]);
    return metadata(component, `${label}[${index}]`);
  });
}

function dependentList(value: unknown, label: string): readonly DependentComponentDescriptor[] {
  return array(value, label).map((entry, index) => {
    const component = record(entry, `${label}[${index}]`);
    assertAllowedKeys(component, [
      "id",
      "displayName",
      "description",
      "requiresCapabilities",
      "requiresTools",
    ]);
    return {
      ...metadata(component, `${label}[${index}]`),
      ...dependencies(component, `${label}[${index}]`),
    };
  });
}

function toolList(value: unknown): readonly ToolComponentDescriptor[] {
  return array(value, "tools").map((entry, index) => {
    const component = record(entry, `tools[${index}]`);
    assertAllowedKeys(component, [
      "id",
      "displayName",
      "description",
      "toolName",
      "requiresCapabilities",
      "requiresTools",
    ]);
    if (typeof component.toolName !== "string" || !TOOL_NAME.test(component.toolName)) {
      throw new Error(`Invalid Tool name in tools[${index}]: ${String(component.toolName)}`);
    }
    return {
      ...metadata(component, `tools[${index}]`),
      toolName: component.toolName,
      ...dependencies(component, `tools[${index}]`),
    };
  });
}

function bundleList(value: unknown): readonly ToolBundleDescriptor[] {
  return array(value, "toolBundles").map((entry, index) => {
    const bundle = record(entry, `toolBundles[${index}]`);
    assertExactKeys(bundle, ["id", "displayName", "description", "tools"]);
    return {
      ...metadata(bundle, `toolBundles[${index}]`),
      tools: componentIds(bundle.tools, `toolBundles[${index}].tools`),
    };
  });
}

function metadata(value: Record<string, unknown>, label: string): ComponentDescriptor {
  return {
    id: componentId(value.id, `${label}.id`),
    displayName: nonEmptyString(value.displayName, `${label}.displayName`),
    description: nonEmptyString(value.description, `${label}.description`),
  };
}

function dependencies(
  value: Record<string, unknown>,
  label: string,
): Pick<DependentComponentDescriptor, "requiresCapabilities" | "requiresTools"> {
  return {
    ...(value.requiresCapabilities === undefined
      ? {}
      : {
          requiresCapabilities: componentIds(
            value.requiresCapabilities,
            `${label}.requiresCapabilities`,
          ),
        }),
    ...(value.requiresTools === undefined
      ? {}
      : { requiresTools: componentIds(value.requiresTools, `${label}.requiresTools`) }),
  };
}

function componentIds(value: unknown, label: string): readonly string[] {
  return array(value, label).map((entry, index) => componentId(entry, `${label}[${index}]`));
}

function componentId(value: unknown, label: string): string {
  if (typeof value !== "string" || !isToolOriginId(value)) {
    throw new Error(`${label} must be a valid Component id`);
  }
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  assertAllowedKeys(value, keys);
  const missing = keys.filter((key) => !(key in value));
  if (missing.length > 0) throw new Error(`Missing fields: ${missing.join(", ")}`);
}

function assertAllowedKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown fields: ${unknown.join(", ")}`);
}

function assertUniqueIds(values: readonly ComponentDescriptor[], label: string): void {
  assertUnique(
    values.map(({ id }) => id),
    label,
  );
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} contains duplicate value: ${value}`);
    seen.add(value);
  }
}
