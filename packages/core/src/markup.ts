export function escapeMarkupText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function escapeMarkupAttribute(value: string): string {
  return escapeMarkupText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
