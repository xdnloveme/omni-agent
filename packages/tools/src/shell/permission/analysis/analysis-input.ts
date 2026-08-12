export interface ShellAnalysisInput {
  command: string;
  cwd: string;
  signal?: AbortSignal;
  environment: {
    platform: NodeJS.Platform;
    home: string;
  };
}
