import type { JsonValue } from "@omni-agent/core";
import type { VendorSettingsSchema } from "@omni-agent/app";

export type SettingProperty = NonNullable<VendorSettingsSchema["properties"]>[string];

export function parseSettingValue(property: SettingProperty, value: string): JsonValue {
  if (property.type === "string") return value;
  if (property.type === "number" || property.type === "integer") {
    const number = Number(value);
    if (!Number.isFinite(number) || (property.type === "integer" && !Number.isInteger(number))) {
      throw new Error(`Enter a valid ${property.type}`);
    }
    return number;
  }
  if (property.type === "boolean") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    throw new Error("Enter true or false");
  }
  try {
    const parsed = JSON.parse(value) as JsonValue;
    if (property.type === "array" && Array.isArray(parsed)) return parsed;
    if (
      property.type === "object" &&
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed;
    }
  } catch {
    // The boundary validator will provide the final schema-specific error.
  }
  throw new Error(`Enter a valid JSON ${property.type}`);
}

export function formatSettingDefault(property: SettingProperty): string | undefined {
  if (property.default === undefined) return undefined;
  return typeof property.default === "string" ? property.default : JSON.stringify(property.default);
}
