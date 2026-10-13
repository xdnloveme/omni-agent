import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, sep, join, relative, resolve } from "node:path";
import Ajv from "ajv";
import { gatewayConfigSchema, type GatewayBotConfig, type GatewayConfig } from "./gateway-config";

export interface GatewayBotEnvironment {
  readonly appSecret: string;
  readonly verificationToken?: string;
  readonly encryptKey?: string;
  readonly hostToken?: string;
}

export async function loadGatewayConfig(path: string): Promise<GatewayConfig> {
  const absolutePath = await realpath(resolve(path));
  const value: unknown = JSON.parse(await readFile(absolutePath, "utf8"));
  const validate = new Ajv({ allErrors: true, strict: true }).compile<GatewayConfig>(
    gatewayConfigSchema,
  );
  if (!validate(value)) {
    throw new Error(`Invalid IM gateway config: ${new Ajv().errorsText(validate.errors)}`);
  }
  rejectSecretFields(value);
  const base = dirname(absolutePath);
  const bots = await Promise.all(value.bots.map((bot) => normalizeBot(bot, base)));
  const stateFile = await canonicalizePotentialPath(resolveFrom(base, value.stateFile));
  validateUniqueness(bots);
  const canonicalConfigPath = await canonicalizePotentialPath(absolutePath);
  validateFilesystemIsolation(canonicalConfigPath, stateFile, bots);
  return {
    version: 1,
    stateFile,
    bots,
  };
}

export function readBotEnvironment(
  bot: GatewayBotConfig,
  environment: NodeJS.ProcessEnv = process.env,
): GatewayBotEnvironment {
  const appSecret = requiredEnvironment(bot.lark.appSecretEnv, bot.id, environment);
  const verificationToken = optionalEnvironment(bot.lark.verificationTokenEnv, bot.id, environment);
  const encryptKey = optionalEnvironment(bot.lark.encryptKeyEnv, bot.id, environment);
  const hostToken =
    bot.host.mode === "attached"
      ? requiredEnvironment(bot.host.tokenEnv, bot.id, environment)
      : undefined;
  return {
    appSecret,
    ...(verificationToken ? { verificationToken } : {}),
    ...(encryptKey ? { encryptKey } : {}),
    ...(hostToken ? { hostToken } : {}),
  };
}

function validateFilesystemIsolation(
  configPath: string,
  stateFile: string,
  bots: readonly GatewayBotConfig[],
): void {
  const protectedPaths = [
    ["gateway configuration file", configPath],
    ["gateway state file", stateFile],
    ...bots.map((bot) => [`bot ${bot.id} state directory`, bot.stateDirectory] as const),
  ] as const;
  for (const workspaceBot of bots) {
    for (const [kind, path] of protectedPaths) {
      if (containsPath(workspaceBot.projectDirectory, path)) {
        throw new Error(
          `${kind} must be outside the Agent-writable workspace for bot ${workspaceBot.id}`,
        );
      }
    }
  }
  for (const [index, bot] of bots.entries()) {
    if (
      containsPath(bot.stateDirectory, stateFile) ||
      containsPath(stateFile, bot.stateDirectory)
    ) {
      throw new Error(`IM gateway state file must not overlap bot state directory: ${bot.id}`);
    }
    for (const other of bots.slice(index + 1)) {
      if (
        containsPath(bot.stateDirectory, other.stateDirectory) ||
        containsPath(other.stateDirectory, bot.stateDirectory)
      ) {
        throw new Error(
          `IM gateway bot state directories must not overlap: ${bot.id}, ${other.id}`,
        );
      }
    }
  }
}

async function normalizeBot(bot: GatewayBotConfig, base: string): Promise<GatewayBotConfig> {
  return {
    ...bot,
    projectDirectory: await realpath(resolveFrom(base, bot.projectDirectory)),
    stateDirectory: await canonicalizePotentialPath(resolveFrom(base, bot.stateDirectory)),
  };
}

function validateUniqueness(bots: readonly GatewayBotConfig[]): void {
  for (const property of ["id", "stateDirectory"] as const) {
    const values = new Set<string>();
    for (const bot of bots) {
      if (values.has(bot[property])) {
        throw new Error(`IM gateway bot ${property} must be unique: ${bot[property]}`);
      }
      values.add(bot[property]);
    }
  }
  const appIds = new Set<string>();
  for (const bot of bots) {
    if (appIds.has(bot.lark.appId)) {
      throw new Error(`IM gateway Lark appId must be unique: ${bot.lark.appId}`);
    }
    appIds.add(bot.lark.appId);
  }
}

function rejectSecretFields(value: unknown, path = "config"): void {
  if (!isRecord(value)) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => rejectSecretFields(entry, `${path}[${index}]`));
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (/secret|token|encryptkey/i.test(key) && !key.endsWith("Env")) {
      throw new Error(`Secrets are not allowed in IM gateway config: ${path}.${key}`);
    }
    rejectSecretFields(entry, `${path}.${key}`);
  }
}

function resolveFrom(base: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

async function canonicalizePotentialPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await lstat(path);
      throw new Error(`IM gateway path contains a dangling symbolic link: ${path}`);
    } catch (entryError) {
      if ((entryError as NodeJS.ErrnoException).code !== "ENOENT") throw entryError;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalizePotentialPath(parent), basename(path));
  }
}

function containsPath(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

function requiredEnvironment(name: string, botId: string, environment: NodeJS.ProcessEnv): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Environment variable ${name} is required for bot ${botId}`);
  return value;
}

function optionalEnvironment(
  name: string | undefined,
  botId: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  return name ? requiredEnvironment(name, botId, environment) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
