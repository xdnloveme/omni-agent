export interface ExtensionEvent {
  type: "extension_event";
  namespace: string;
  event: string;
  toolCallId?: string;
  payload: Record<string, unknown>;
}
