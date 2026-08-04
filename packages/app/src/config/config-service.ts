import {
  getConfigDir,
  getConfigPath,
  loadConfig,
  saveConfig,
  type OmniConfig,
} from "@omni-agent/core";

/** Application-facing configuration service; core functions remain for compatibility. */
export class ConfigService {
  load(): OmniConfig | null {
    return loadConfig();
  }

  save(config: OmniConfig): void {
    saveConfig(config);
  }

  get directory(): string {
    return getConfigDir();
  }

  get path(): string {
    return getConfigPath();
  }
}
