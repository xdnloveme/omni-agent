import keytar from "keytar";

const SERVICE_NAME = "omni-agent";

export async function saveApiKey(provider: string, apiKey: string): Promise<void> {
  await keytar.setPassword(SERVICE_NAME, provider, apiKey);
}

export async function getApiKey(provider: string): Promise<string | null> {
  return keytar.getPassword(SERVICE_NAME, provider);
}

export async function deleteApiKey(provider: string): Promise<boolean> {
  return keytar.deletePassword(SERVICE_NAME, provider);
}
