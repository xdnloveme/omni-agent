import {
  DenyApprovalBroker,
  PermissionGate,
  type ApprovalBroker,
  type PermissionObserver,
} from "@omni-agent/core";
import { DefaultPermissionPolicy } from "./default-permission-policy";
import { PermissionRepository } from "./permission-repository";
import { PermissionService } from "./permission-service";

export interface PermissionRuntimeOptions {
  globalDirectory?: string;
  approvalBroker?: ApprovalBroker;
  observer?: PermissionObserver;
}

export function createPermissionRuntime(options: PermissionRuntimeOptions) {
  const service = new PermissionService(
    new PermissionRepository({ globalDirectory: options.globalDirectory }),
  );
  const permissionGate = new PermissionGate({
    policy: new DefaultPermissionPolicy(),
    grants: service,
    broker: options.approvalBroker ?? new DenyApprovalBroker(),
    observer: options.observer,
  });
  return { service, permissionGate };
}
