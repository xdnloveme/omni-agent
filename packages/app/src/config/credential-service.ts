import { deleteApiKey, getApiKey, saveApiKey } from "@omni-agent/core";

/** Application-facing credential service backed by the current keychain adapter. */
export class CredentialService {
  get(account: string): Promise<string | null> {
    return getApiKey(account);
  }

  save(account: string, apiKey: string): Promise<void> {
    return saveApiKey(account, apiKey);
  }

  delete(account: string): Promise<boolean> {
    return deleteApiKey(account);
  }
}
