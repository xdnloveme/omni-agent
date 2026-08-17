export type RuntimePlatform = "darwin" | "linux" | "win32" | "other";

export interface RuntimeEnvironmentSnapshot {
  readonly workspace: {
    readonly cwd: string;
    readonly roots: readonly string[];
  };
  readonly time: {
    readonly currentDate: string;
    readonly timezone: string;
  };
  readonly execution: {
    readonly platform: RuntimePlatform;
    readonly arch: string;
    readonly shell: string;
    readonly kind: "host";
  };
}

export interface RuntimeEnvironmentProviderPort {
  snapshot(signal?: AbortSignal): Promise<RuntimeEnvironmentSnapshot>;
}

export interface EnvironmentContextRecord {
  readonly revision: number;
  readonly fingerprint: string;
  readonly capturedAt: number;
  readonly snapshot: RuntimeEnvironmentSnapshot;
}

export type EnvironmentCaptureResult =
  | {
      readonly changed: false;
    }
  | {
      readonly changed: true;
      readonly context: EnvironmentContextRecord;
    };

export interface EnvironmentContextControllerPort {
  capture(
    latest: EnvironmentContextRecord | undefined,
    signal?: AbortSignal,
  ): Promise<EnvironmentCaptureResult>;
}
