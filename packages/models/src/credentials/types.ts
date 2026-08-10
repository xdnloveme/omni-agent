export type StoredCredential =
  | { type: "api_key"; key?: string; env?: Record<string, string> }
  | { type: "oauth"; refresh: string; access: string; expires: number; [key: string]: unknown };

export interface CredentialInfo {
  providerId: string;
  type: StoredCredential["type"];
}

export interface CredentialOperationOptions {
  signal?: AbortSignal;
}

export interface CredentialStore {
  read(
    providerId: string,
    options?: CredentialOperationOptions,
  ): Promise<StoredCredential | undefined>;
  list(options?: CredentialOperationOptions): Promise<readonly CredentialInfo[]>;
  modify(
    providerId: string,
    fn: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>,
    options?: CredentialOperationOptions,
  ): Promise<StoredCredential | undefined>;
  delete(providerId: string, options?: CredentialOperationOptions): Promise<void>;
}

/** One-way account aliases used only while migrating historical keychain entries. */
export interface CredentialAliasRegistry {
  configureAliases(providerId: string, aliases: readonly string[]): void;
  clearAliases(providerId: string): void;
}

export interface CredentialIndexReconciler {
  reconcile(providerIds: readonly string[]): Promise<CredentialReconcileReport>;
}

export interface CredentialReconcileReport {
  diagnostics: readonly CredentialDiagnostic[];
}

export interface CredentialDiagnostic {
  code: "corrupt_index_quarantined";
  message: string;
}

export type ModelAuthType = "api_key" | "oauth";

export interface ModelAuthMethod {
  type: ModelAuthType;
  label: string;
  interactive: boolean;
}

export type ModelAuthPrompt = { signal?: AbortSignal } & (
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
    }
);

export type ModelAuthEvent =
  | {
      type: "info" | "progress";
      message: string;
      links?: readonly { url: string; label?: string }[];
    }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    };

export interface ModelAuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: ModelAuthPrompt): Promise<string>;
  notify(event: ModelAuthEvent): void;
}
