const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;
const ENVIRONMENT_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateProviderId(value: string, path = "provider.id"): void {
  if (!value.trim() || !PROVIDER_ID.test(value))
    throw new Error(`${path} contains unsupported characters`);
}

export function validateHttpEndpoint(value: string, path = "provider.baseUrl"): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new Error(`${path} must be an HTTP(S) URL`);
  }
}

export function validateEnvironmentVariables(
  values: readonly string[],
  path = "provider.envVars",
): void {
  if (values.length === 0 || values.some((value) => !ENVIRONMENT_VARIABLE.test(value))) {
    throw new Error(`${path} contains an invalid environment variable name`);
  }
}

export function validateUniqueModelIds(
  models: readonly { id: string }[],
  path = "provider.models",
): void {
  if (new Set(models.map(({ id }) => id)).size !== models.length) {
    throw new Error(`${path} contains duplicate model ids`);
  }
}
