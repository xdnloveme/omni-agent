import type { ToolPermissionDescriptor } from "@omni-agent/core";
import { assessFilePath, type FileAccess } from "./file-path-assessor";

export interface FilePathPermissionOptions {
  parameter: string;
  access: FileAccess;
}

export function createFilePathPermission(
  options: FilePathPermissionOptions,
): ToolPermissionDescriptor {
  return {
    kind: "dynamic",
    async assess(input, context) {
      const value = input[options.parameter];
      if (typeof value !== "string") throw new Error(`${options.parameter} must be a string`);
      return assessFilePath(value, context.cwd, options.access);
    },
  };
}
