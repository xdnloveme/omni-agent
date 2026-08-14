import type { RuntimeModelSelection } from "@omni-agent/core";
import type { ActiveVendorPlugin } from "./plugin-transaction";
import type { ModelSelection, ProviderCollection } from "./types";
import { VendorRegistry } from "./registry";
import { resolveOutputBudget } from "./output-budget";

export class VendorSelectionResolver {
  constructor(
    private readonly models: ProviderCollection,
    private readonly vendors: VendorRegistry,
    private readonly activeVendor: (vendorId: string) => ActiveVendorPlugin | undefined,
  ) {}

  async resolve(selection: ModelSelection): Promise<RuntimeModelSelection> {
    const vendor = this.vendors.get(selection.vendorId);
    if (!vendor) throw new Error(`Unknown vendor: ${selection.vendorId}`);
    const connection = vendor.connections.find((item) => item.id === selection.connectionId);
    if (!connection) {
      throw new Error(`Unknown connection: ${selection.vendorId}/${selection.connectionId}`);
    }
    const settings = this.vendors.validateSettings(
      selection.vendorId,
      selection.connectionId,
      selection.settings,
    );
    const entry = this.activeVendor(vendor.id);
    if (!entry) throw new Error(`Vendor plugin is not active: ${vendor.id}`);
    const normalizedSelection = { ...selection, settings };
    if (entry.plugin.resolveSelection) {
      const resolved = await entry.plugin.resolveSelection(normalizedSelection, {
        catalog: {
          getModel: (providerId, modelId) => {
            const model = this.models.getModel(providerId, modelId);
            return model && { ...model };
          },
        },
        vendor,
        connection,
      });
      return {
        ...resolved,
        ...resolveOutputBudget({
          contextWindow: resolved.contextWindow,
          modelMaxOutputTokens: resolved.modelMaxOutputTokens,
          requestedOutputTokens: selection.requestedOutputTokens ?? resolved.requestedOutputTokens,
        }),
      };
    }
    let model = this.models.getModel(connection.providerId, selection.modelId);
    if (!model) {
      await this.models.refresh({ providers: [connection.providerId] });
      model = this.models.getModel(connection.providerId, selection.modelId);
    }
    if (!model) throw new Error(`Unknown model: ${connection.providerId}/${selection.modelId}`);
    return {
      vendorId: vendor.id,
      connectionId: connection.id,
      providerId: connection.providerId,
      modelId: model.id,
      settings,
      contextWindow: model.contextWindow,
      ...resolveOutputBudget({
        contextWindow: model.contextWindow,
        modelMaxOutputTokens: model.maxOutputTokens,
        requestedOutputTokens: selection.requestedOutputTokens,
      }),
    };
  }
}
