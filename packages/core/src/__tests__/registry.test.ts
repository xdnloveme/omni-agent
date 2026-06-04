import { describe, it, expect, beforeEach } from "vitest";
import { CommandRegistry } from "../commands/registry.js";
import type { Command } from "../commands/types.js";

function makeCommand(name: string): Command {
  return {
    name,
    description: `Description for ${name}`,
    execute: async () => {},
  };
}

describe("CommandRegistry", () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
  });

  it("should register and get a command", () => {
    const cmd = makeCommand("help");
    registry.register(cmd);

    expect(registry.get("help")).toBe(cmd);
  });

  it("should return true for has() when command exists", () => {
    registry.register(makeCommand("config"));

    expect(registry.has("config")).toBe(true);
  });

  it("should return false for has() when command does not exist", () => {
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("should list all registered commands", () => {
    const cmd1 = makeCommand("help");
    const cmd2 = makeCommand("config");
    registry.register(cmd1);
    registry.register(cmd2);

    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list).toContain(cmd1);
    expect(list).toContain(cmd2);
  });

  it("should overwrite on duplicate registration (same name)", () => {
    const cmd1 = makeCommand("help");
    const cmd2 = makeCommand("help");
    cmd2.description = "Updated help";

    registry.register(cmd1);
    registry.register(cmd2);

    expect(registry.get("help")).toBe(cmd2);
    expect(registry.list()).toHaveLength(1);
  });

  it("should return undefined for unknown command", () => {
    expect(registry.get("unknown")).toBeUndefined();
  });
});
