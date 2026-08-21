import { describe, expect, it } from "vitest";
import { AssemblyTransaction } from "./assembly-transaction";
import { AssemblyRollbackError } from "./errors";

describe("AssemblyTransaction", () => {
  it("rolls every acquired resource back in reverse order", async () => {
    const order: string[] = [];
    const transaction = new AssemblyTransaction();
    transaction.defer("first", () => {
      order.push("first");
    });
    transaction.defer("second", () => {
      order.push("second");
    });
    await expect(transaction.rollback(new Error("assembly failed"))).rejects.toThrow(
      "assembly failed",
    );
    expect(order).toEqual(["second", "first"]);
  });

  it("preserves the assembly cause and all cleanup failures", async () => {
    const transaction = new AssemblyTransaction();
    transaction.defer("first", () => {
      throw new Error("cleanup one");
    });
    transaction.defer("second", () => {
      throw new Error("cleanup two");
    });
    const failure = await transaction
      .rollback(new Error("assembly failed"))
      .catch((error) => error);
    expect(failure).toBeInstanceOf(AssemblyRollbackError);
    expect(failure).toMatchObject({
      code: "agent_assembly_rollback_failed",
      cleanupFailures: [{ resource: "second" }, { resource: "first" }],
    });
    expect((failure as AssemblyRollbackError).errors).toHaveLength(3);
  });
});
