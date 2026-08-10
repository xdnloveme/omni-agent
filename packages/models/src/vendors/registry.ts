import type { JsonValue } from "@omni-agent/core";
import {
  SchemaAdmissionPolicy,
  SchemaCompiler,
  type CompiledValidator,
  type VendorSettingsSchema,
} from "../schema/vendor-settings";
import type { VendorDefinition } from "./types";

export interface PreparedVendorRegistration {
  readonly definition: VendorDefinition;
  readonly validators: ReadonlyMap<string, CompiledValidator<Record<string, JsonValue>>>;
}

export class VendorRegistry {
  private readonly vendors = new Map<string, PreparedVendorRegistration>();

  constructor(
    private readonly admission = new SchemaAdmissionPolicy(),
    private readonly compiler = new SchemaCompiler(),
  ) {}

  register(vendor: VendorDefinition): void {
    this.registerPrepared(this.prepare(vendor));
  }

  registerPrepared(prepared: PreparedVendorRegistration): void {
    const vendor = prepared.definition;
    if (this.vendors.has(vendor.id)) throw new Error(`Vendor already registered: ${vendor.id}`);
    this.vendors.set(vendor.id, prepared);
  }

  prepare(vendor: VendorDefinition): PreparedVendorRegistration {
    return this.prepareDefinition(vendor);
  }

  unregister(id: string): void {
    this.vendors.delete(id);
  }

  get(id: string): VendorDefinition | undefined {
    return this.vendors.get(id)?.definition;
  }

  list(): VendorDefinition[] {
    return [...this.vendors.values()].map(({ definition }) => definition);
  }

  validateSettings(
    vendorId: string,
    connectionId: string,
    settings: unknown,
  ): Record<string, JsonValue> | undefined {
    const entry = this.vendors.get(vendorId);
    if (!entry) throw new Error(`Unknown vendor: ${vendorId}`);
    const connection = entry.definition.connections.find((item) => item.id === connectionId);
    if (!connection) throw new Error(`Unknown connection: ${vendorId}/${connectionId}`);
    const validator = entry.validators.get(connectionId);
    if (!validator) {
      if (settings !== undefined) {
        throw new Error(`${vendorId}/${connectionId}: This connection does not accept settings`);
      }
      return undefined;
    }
    try {
      return validator.validate(settings);
    } catch (error) {
      throw new Error(
        `${vendorId}/${connectionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private prepareDefinition(vendor: VendorDefinition): PreparedVendorRegistration {
    if (!vendor.id.trim()) throw new Error("Vendor id is required");
    if (!vendor.displayName.trim())
      throw new Error(`Vendor display name is required: ${vendor.id}`);
    if (vendor.connections.length === 0) throw new Error(`Vendor has no connections: ${vendor.id}`);
    const ids = new Set<string>();
    const validators = new Map<string, CompiledValidator<Record<string, JsonValue>>>();
    const connections = vendor.connections.map((connection) => {
      if (
        !connection.id.trim() ||
        !connection.displayName.trim() ||
        !connection.providerId.trim()
      ) {
        throw new Error(`Invalid connection in vendor: ${vendor.id}`);
      }
      if (ids.has(connection.id))
        throw new Error(`Duplicate connection: ${vendor.id}/${connection.id}`);
      ids.add(connection.id);
      const settingsSchema = this.prepareSchema(connection.settingsSchema);
      if (settingsSchema) {
        validators.set(connection.id, this.compiler.compileObject(settingsSchema));
      }
      return deepFreeze({ ...connection, settingsSchema });
    });
    return {
      definition: deepFreeze({ ...vendor, connections }),
      validators,
    };
  }

  private prepareSchema(
    schema: VendorSettingsSchema | undefined,
  ): VendorSettingsSchema | undefined {
    if (!schema) return undefined;
    return deepFreeze(structuredClone(this.admission.admit(schema)));
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
