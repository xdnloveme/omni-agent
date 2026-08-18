import { spawn } from "node:child_process";

const CLIPBOARD_TIMEOUT_MS = 5_000;

interface ClipboardCommand {
  readonly command: string;
  readonly args: readonly string[];
}

function runClipboardCommand(
  command: string,
  args: readonly string[],
  text: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "ignore", "ignore"],
    });
    let settled = false;
    const finish = (success: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(success);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, CLIPBOARD_TIMEOUT_MS);

    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.on("error", () => finish(false));
    child.stdin.end(text);
  });
}

function getClipboardCommands(): readonly ClipboardCommand[] {
  if (process.platform === "darwin") {
    return [{ command: "pbcopy", args: [] }];
  }
  if (process.platform === "win32") {
    return [{ command: "clip.exe", args: [] }];
  }
  const commands: ClipboardCommand[] = [];
  if (process.env.TERMUX_VERSION) {
    commands.push({ command: "termux-clipboard-set", args: [] });
  }
  if (process.env.WAYLAND_DISPLAY) {
    commands.push({ command: "wl-copy", args: [] });
  }
  if (process.env.DISPLAY) {
    commands.push(
      { command: "xclip", args: ["-selection", "clipboard"] },
      { command: "xsel", args: ["--clipboard", "--input"] },
    );
  }
  return commands;
}

/** Resolve a local clipboard adapter; pi-tui owns the OSC 52 fallback when this is absent. */
export function createClipboardCopy(): ((text: string) => Promise<boolean>) | undefined {
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.MOSH_CONNECTION) {
    return undefined;
  }
  const commands = getClipboardCommands();
  if (commands.length === 0) return undefined;

  return async (text) => {
    for (const { command, args } of commands) {
      if (await runClipboardCommand(command, args, text)) return true;
    }
    return false;
  };
}
