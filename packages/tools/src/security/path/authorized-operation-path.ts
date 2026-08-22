import { canonicalizeToolPath, normalizeForComparison, resolveToolPath } from "./normalize-path";

export class AuthorizedOperationPathChangedError extends Error {
  constructor() {
    super("Authorized path changed before execution");
    this.name = "AuthorizedOperationPathChangedError";
  }
}

export async function bindCanonicalPathInput(
  input: Record<string, unknown>,
  parameter: string,
  cwd: string,
  options: { readonly optional?: boolean } = {},
): Promise<Record<string, unknown>> {
  const value = input[parameter];
  if (value === undefined && options.optional) return input;
  if (typeof value !== "string") throw new Error(`${parameter} must be a string`);
  return { ...input, [parameter]: await canonicalizeToolPath(value, cwd) };
}

export async function resolveAuthorizedOperationPath(value: string, cwd: string): Promise<string> {
  const authorized = resolveToolPath(value, cwd);
  const current = await canonicalizeToolPath(authorized, cwd);
  if (normalizeForComparison(current) !== normalizeForComparison(authorized)) {
    throw new AuthorizedOperationPathChangedError();
  }
  return authorized;
}
