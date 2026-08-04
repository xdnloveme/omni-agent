import type { Command } from "./types";

export class CommandRegistry {
  private commands = new Map<string, Command>();

  register(command: Command): void {
    this.commands.set(command.name, command);
  }

  get(name: string): Command | undefined {
    return this.commands.get(name);
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  unregister(name: string): void {
    this.commands.delete(name);
  }

  list(): Command[] {
    return [...this.commands.values()];
  }
}
