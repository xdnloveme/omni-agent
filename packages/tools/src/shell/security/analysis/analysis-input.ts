export interface ShellAnalysisInput {
  command: string;
  cwd: string;
  workspaceRoot: string;
  signal?: AbortSignal;
  environment: {
    platform: NodeJS.Platform;
    home: string;
  };
}
