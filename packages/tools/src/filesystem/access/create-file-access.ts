import type { ToolAccessDescriptor } from "@omni-agent/core";
import { bindCanonicalPathInput } from "../../security/path/authorized-operation-path";
import { assessFilesystemAccess } from "./filesystem-access-assessor";

export function createFileAccess(options: {
  parameter: string;
  access: "read" | "write";
  hiddenInputKeys?: readonly string[];
}): ToolAccessDescriptor {
  return {
    kind: "dynamic",
    ...(options.hiddenInputKeys ? { hiddenInputKeys: options.hiddenInputKeys } : {}),
    bindInput: (input, context) => bindCanonicalPathInput(input, options.parameter, context.cwd),
    async assess(input, context) {
      const value = input[options.parameter];
      if (typeof value !== "string") throw new Error(`${options.parameter} must be a string`);
      return assessFilesystemAccess(value, context, options.access, context.hostRuntime);
    },
  };
}
