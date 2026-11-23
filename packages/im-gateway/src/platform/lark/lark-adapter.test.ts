import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  options: undefined as
    | {
        readonly onReady?: () => void;
        readonly onError?: (error: Error) => void;
      }
    | undefined,
  closed: false,
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: class {
    readonly im = { message: {} };
  },
  EventDispatcher: class {
    register() {
      return this;
    }
  },
  LoggerLevel: { warn: 2 },
  WSClient: class {
    constructor(options: typeof sdk.options) {
      sdk.options = options;
    }
    start() {
      return Promise.resolve();
    }
    close() {
      sdk.closed = true;
    }
  },
}));

import { LarkAdapter } from "./lark-adapter";

beforeEach(() => {
  sdk.options = undefined;
  sdk.closed = false;
});

describe("LarkAdapter", () => {
  it("does not report start success before the initial long connection is ready", async () => {
    const adapter = createAdapter();
    let settled = false;
    const start = adapter
      .start(async () => undefined, new AbortController().signal)
      .then(() => {
        settled = true;
      });
    await Promise.resolve();

    expect(settled).toBe(false);
    sdk.options?.onReady?.();
    await start;
    expect(settled).toBe(true);
  });

  it("closes the SDK and settles startup when stopped before ready", async () => {
    const adapter = createAdapter();
    const controller = new AbortController();
    const starting = adapter.start(async () => undefined, controller.signal);
    const rejected = expect(starting).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await adapter.stop();
    await rejected;
    sdk.options?.onReady?.();
    expect(sdk.closed).toBe(true);
  });

  it("fails startup when the SDK reports a terminal initial connection error", async () => {
    const adapter = createAdapter();
    const start = adapter.start(async () => undefined, new AbortController().signal);
    sdk.options?.onError?.(new Error("authentication failed"));

    await expect(start).rejects.toThrow("authentication failed");
    expect(sdk.closed).toBe(true);
  });
});

function createAdapter(): LarkAdapter {
  return new LarkAdapter({
    botId: "coding",
    appId: "cli_test",
    appSecret: "secret",
  });
}
