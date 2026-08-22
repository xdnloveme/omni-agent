import type { ToolPermissionDescriptor } from "@omni-agent/core";
import { bindCanonicalPathInput } from "../../security/path/authorized-operation-path";
import { assessSearchPath } from "./search-path-assessor";

export function createSearchPathPermission(parameter: string): ToolPermissionDescriptor {
  return {
    kind: "dynamic",
    bindInput: (input, context) =>
      bindCanonicalPathInput(input, parameter, context.cwd, { optional: true }),
    async assess(input, context) {
      const value = input[parameter] ?? context.cwd;
      if (typeof value !== "string") throw new Error(`${parameter} must be a string`);
      return assessSearchPath(value, context.cwd);
    },
  };
}
