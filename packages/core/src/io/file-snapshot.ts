import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";

export interface FileSnapshot {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: number;
}

export function createFileSnapshot(stats: BigIntStats): FileSnapshot {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    mode: Number(stats.mode),
  };
}

export function snapshotsEqual(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode
  );
}

export function snapshotVersion(snapshot: FileSnapshot): string {
  const serialized = [snapshot.dev, snapshot.ino, snapshot.size, snapshot.mtimeNs, snapshot.ctimeNs]
    .map(String)
    .join(":");
  return createHash("sha256").update(serialized).digest("base64url");
}
