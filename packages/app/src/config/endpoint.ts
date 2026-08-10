export function normalizeEndpoint(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}
