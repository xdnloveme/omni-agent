export class Allowlist {
  readonly #users: ReadonlySet<string>;

  constructor(users: readonly string[]) {
    this.#users = new Set(users);
  }

  allows(userId: string): boolean {
    return this.#users.has(userId);
  }
}
