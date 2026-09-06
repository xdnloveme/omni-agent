import type { BotRuntime } from "./bot-runtime";
import type { TaskRecord } from "../contracts";

export class BotRegistry {
  readonly #bots = new Map<string, BotRuntime>();

  register(bot: BotRuntime): void {
    if (this.#bots.has(bot.config.id)) throw new Error(`Duplicate IM bot: ${bot.config.id}`);
    this.#bots.set(bot.config.id, bot);
  }

  get(botId: string): BotRuntime | undefined {
    return this.#bots.get(botId);
  }

  get size(): number {
    return this.#bots.size;
  }

  get activeSize(): number {
    return [...this.#bots.values()].filter((bot) => bot.started).length;
  }

  async start(): Promise<number> {
    const results = await Promise.allSettled([...this.#bots.values()].map((bot) => bot.start()));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length === results.length) {
      throw new AggregateError(
        failures.map((failure) => (failure as PromiseRejectedResult).reason),
        "Every IM bot failed to start",
      );
    }
    for (const failure of failures) {
      process.stderr.write(
        `[im-gateway] bot start failed: ${String((failure as PromiseRejectedResult).reason)}\n`,
      );
    }
    return results.length - failures.length;
  }

  async presentRecoveredTasks(tasks: readonly TaskRecord[]): Promise<ReadonlySet<string>> {
    const results = await Promise.allSettled(
      tasks.map(async (task) => {
        const bot = this.#bots.get(task.botId);
        if (!bot?.started) throw new Error(`IM bot is unavailable: ${task.botId}`);
        await bot.presentRecoveredTask(task);
        return task.requestId;
      }),
    );
    const presented = new Set<string>();
    for (const result of results) {
      if (result.status === "fulfilled") presented.add(result.value);
    }
    for (const failure of results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )) {
      process.stderr.write(`[im-gateway] recovery notice failed: ${String(failure.reason)}\n`);
    }
    return presented;
  }

  async stop(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#bots.values()].map(async (bot) => {
        const failures: unknown[] = [];
        await bot.stop().catch((error) => failures.push(error));
        await bot.dispose().catch((error) => failures.push(error));
        if (failures.length > 0) {
          throw new AggregateError(failures, `Failed to stop IM bot ${bot.config.id}`);
        }
      }),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => (failure as PromiseRejectedResult).reason),
        "Failed to stop IM bots",
      );
    }
  }
}
