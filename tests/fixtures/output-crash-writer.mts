import { SessionArtifactStore } from "../../packages/app/src/persistence/session-artifact-store.ts";
import { AtomicJsonFile } from "../../packages/app/src/persistence/atomic-json-file.ts";
process.on("message", () => {});
// Stop after body I/O but before its metadata commit; the parent kills this real process.
const write = AtomicJsonFile.prototype.write;
AtomicJsonFile.prototype.write = async function (value: unknown) {
  const record = value as { id?: string; state?: string; parts?: { bytes: number; id: string }[] };
  if (record.state === "writing" && record.parts?.some((part) => part.bytes > 0)) {
    process.send?.({ id: record.id, bodyId: record.parts![0]!.id });
    await new Promise(() => {});
  }
  return write.call(this, value);
};
await new SessionArtifactStore(process.argv[2]!).withSession("crash", async (session) => {
  const writer = await session.create("crashed-call");
  const body = await writer.createPart({ label: "body", mediaType: "text/plain" });
  await body.append("before-crash\n");
});
