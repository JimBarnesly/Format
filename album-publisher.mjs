import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function publishAlbumDirectory({ source, destination, stage, move = rename }) {
  if (existsSync(destination)) {
    throw new Error("Album destination already exists; staged files were retained without changes.");
  }
  await mkdir(dirname(destination), { recursive: true });
  await move(source, destination);
  await rm(stage, { recursive: true, force: true });
}
