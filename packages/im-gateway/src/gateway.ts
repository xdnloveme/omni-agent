import { createAbortError, throwIfAborted } from "@omni-agent/core";
import { HostProcessLink } from "./agent-link/host-process-link";
import { HostProcessSupervisor } from "./agent-link/host-process-supervisor";
import { realpath } from "node:fs/promises";
import { isAbsolute, sep, relative } from "node:path";
import { BotRegistry } from "./bots/bot-registry";
import { BotRuntime } from "./bots/bot-runtime";
import { readBotEnvironment, type GatewayBotEnvironment } from "./config/config-loader";
import type { GatewayBotConfig, GatewayConfig } from "./config/gateway-config";
import { GatewayStateStore } from "./persistence/gateway-state-store";
import { LarkAdapter } from "./platform/lark/lark-adapter";

export interface ImGatewayOptions {
  readonly managedHostEntryPath: string;
}

export interface ImGatewayStartResult {
  readonly activeBots: number;
}

export class ImGateway {
  readonly #registry = new BotRegistry();
  readonly #store: GatewayStateStore;
  readonly #shutdown = new AbortController();
  #starting?: Promise<ImGatewayStartResult>;
  #stopping?: Promise<void>;
  #cleanup?: Promise<void>;

  private constructor(
    private readonly config: GatewayConfig,
    private readonly options: ImGatewayOptions,
  ) {
    this.#store = new GatewayStateStore(config.stateFile);
  }

  static async create(config: GatewayConfig, options: ImGatewayOptions): Promise<ImGateway> {
    const managedHostEntryPath = await realpath(options.managedHostEntryPath);
    for (const bot of config.bots) {
      const projectDirectory = await realpath(bot.projectDirectory);
      const pathFromWorkspace = relative(projectDirectory, managedHostEntryPath);
      if (
        pathFromWorkspace === "" ||
        (pathFromWorkspace !== ".." &&
          !pathFromWorkspace.startsWith(`..${sep}`) &&
          !isAbsolute(pathFromWorkspace))
      ) {
        throw new Error(
          `Managed IM Agent Host entry must be outside the Agent-writable workspace for bot ${bot.id}`,
        );
      }
    }
    return new ImGateway(config, { managedHostEntryPath });
  }

  start(): Promise<ImGatewayStartResult> {
    if (this.#shutdown.signal.aborted)
      return Promise.reject(createAbortError(this.#shutdown.signal));
    this.#starting ??= this.#start();
    return this.#starting;
  }

  async #start(): Promise<ImGatewayStartResult> {
    try {
      this.#assembleBots();
      const recovered = await this.#store.recoverUnknown();
      throwIfAborted(this.#shutdown.signal);
      const activeBots = await this.#registry.start();
      throwIfAborted(this.#shutdown.signal);
      if (activeBots === 0) throw new Error("IM gateway has no active bots");
      const presented = await this.#registry.presentRecoveredTasks(recovered);
      for (const task of recovered) {
        if (!presented.has(task.requestId)) continue;
        await this.#store.markRecoveryNoticePresented(task.requestId);
      }
      throwIfAborted(this.#shutdown.signal);
      return { activeBots };
    } catch (error) {
      try {
        await this.#closeBots();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Failed to start and clean up IM gateway");
      }
      throwIfAborted(this.#shutdown.signal);
      throw error;
    }
  }

  stop(): Promise<void> {
    this.#shutdown.abort();
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    try {
      await this.#closeBots();
    } finally {
      // Closing bots interrupts startup; waiting first would leave startup blocked.
      await this.#starting?.catch(() => undefined);
    }
  }

  #closeBots(): Promise<void> {
    this.#cleanup ??= this.#registry.stop();
    return this.#cleanup;
  }

  #assembleBots(): void {
    const failures: unknown[] = [];
    for (const botConfig of this.config.bots) {
      try {
        const environment = readBotEnvironment(botConfig);
        const link = new HostProcessLink(
          new HostProcessSupervisor(toSupervisorOptions(botConfig, environment, this.options)),
        );
        this.#registry.register(
          new BotRuntime(
            botConfig,
            new LarkAdapter({
              botId: botConfig.id,
              appId: botConfig.lark.appId,
              appSecret: environment.appSecret,
              ...(environment.verificationToken
                ? { verificationToken: environment.verificationToken }
                : {}),
              ...(environment.encryptKey ? { encryptKey: environment.encryptKey } : {}),
            }),
            link,
            this.#store,
          ),
        );
      } catch (error) {
        failures.push(error);
        process.stderr.write(
          `[im-gateway:${botConfig.id}] bot configuration failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    }
    if (this.#registry.size === 0) {
      throw new AggregateError(failures, "Every IM bot failed configuration");
    }
  }
}

function toSupervisorOptions(
  config: GatewayBotConfig,
  environment: GatewayBotEnvironment,
  options: ImGatewayOptions,
) {
  if (config.host.mode === "managed") {
    return {
      mode: "managed" as const,
      entryPath: options.managedHostEntryPath,
      projectDirectory: config.projectDirectory,
      stateDirectory: config.stateDirectory,
      agentId: config.agentId,
    };
  }
  return {
    mode: "attached" as const,
    port: config.host.port,
    token: environment.hostToken!,
  };
}
