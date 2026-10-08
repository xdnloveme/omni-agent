export interface ProjectInstructionFileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mtimeMs: number;
  readonly size: number;
}

export interface ProjectInstructionManifest {
  readonly path: string;
  readonly appliesTo: string;
  readonly lineage: readonly string[];
  readonly digest: string;
  readonly identity: ProjectInstructionFileIdentity;
  readonly content: string;
}
