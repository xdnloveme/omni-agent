import { fileEditTool, fileReadTool, fileWriteTool } from "../filesystem";
import { globTool, grepTool } from "../search";
import { bashTool } from "../shell";
import { webFetchTool, webSearchTool } from "../web";

export const localReadonlyToolset = [fileReadTool, globTool, grepTool] as const;
export const localCodingToolset = [
  bashTool,
  fileReadTool,
  fileEditTool,
  fileWriteTool,
  globTool,
  grepTool,
] as const;
export const webResearchToolset = [webFetchTool, webSearchTool] as const;
