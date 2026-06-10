import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { arch, hostname, release, type as osType } from "node:os";
import { join } from "node:path";

import { getConfigDir } from "../../../config";

const KIMI_CODE_CLI_VERSION = "0.14.0";
const KIMI_CODE_DEVICE_ID_FILE = "kimi-code-device-id";

function toHeaderValue(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, "").slice(0, 200);
}

function getKimiCodeDeviceId(): string {
  const deviceIdPath = join(getConfigDir(), KIMI_CODE_DEVICE_ID_FILE);

  try {
    if (existsSync(deviceIdPath)) {
      const existing = readFileSync(deviceIdPath, "utf-8").trim();
      if (existing.length > 0) return existing;
    }

    const deviceId = randomUUID();
    writeFileSync(deviceIdPath, `${deviceId}\n`, "utf-8");
    return deviceId;
  } catch {
    return randomUUID();
  }
}

export function getKimiCodeHeaders(): Record<string, string> {
  const osVersion = `${osType()} ${release()} ${arch()}`;

  return {
    "User-Agent": `kimi-code-cli/${KIMI_CODE_CLI_VERSION}`,
    "X-Msh-Platform": "kimi_code_cli",
    "X-Msh-Version": KIMI_CODE_CLI_VERSION,
    "X-Msh-Device-Name": toHeaderValue(hostname()),
    "X-Msh-Device-Model": toHeaderValue(osVersion),
    "X-Msh-Os-Version": toHeaderValue(osVersion),
    "X-Msh-Device-Id": getKimiCodeDeviceId(),
  };
}
