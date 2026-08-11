export interface GlobFileEntry {
  path: string;
  sizeBytes: number | null;
}

export interface GlobResultMeta {
  files: readonly GlobFileEntry[];
  totalMatches: number;
  returnedFiles: number;
  truncated: boolean;
}

export interface GrepMatch {
  line: number;
  column: number;
  preview: string;
}

export interface GrepFileMatches {
  path: string;
  sizeBytes: number | null;
  matches: readonly GrepMatch[];
}

export interface GrepResultMeta {
  files: readonly GrepFileMatches[];
  returnedMatches: number;
  totalMatches?: number;
  truncated: boolean;
}
