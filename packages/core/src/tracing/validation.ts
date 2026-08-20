const NAME = /^[a-z][a-z0-9_.-]{0,127}$/;

export function assertTraceName(name: string): void {
  if (!NAME.test(name)) throw new Error(`Invalid trace name: ${name}`);
}

export function assertTraceId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
}
