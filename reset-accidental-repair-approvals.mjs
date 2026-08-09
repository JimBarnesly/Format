import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const dataDir = resolve(process.env.DATA_DIR || "/home/jake/.local/share/gateway-music-browser");
const acquisitionFile = join(dataDir, "acquisitions.json");
const approvalFile = join(dataDir, "download-approvals.json");
const acquisitions = JSON.parse(await readFile(acquisitionFile, "utf8"));
const approvals = JSON.parse(await readFile(approvalFile, "utf8"));
const removed = acquisitions.items.filter((item) => item.origin === "approved_repair").length;
acquisitions.items = acquisitions.items.filter((item) => item.origin !== "approved_repair").map((item) => {
  if (!['running', 'resolving'].includes(item.status)) return item;
  const { cancelRequested, timeoutRequested, ...clean } = item;
  return { ...clean, status: "queued", message: "Recovered after repair-approval reset.", startedAt: null, finishedAt: null, progress: 0, trackNumber: 0, currentTrack: "" };
});
for (const approval of approvals.items || []) {
  if (approval.status !== "approved") continue;
  approval.status = "pending";
  delete approval.reviewedAt;
  delete approval.acquisitionId;
}
for (const [path, value] of [[acquisitionFile, acquisitions], [approvalFile, approvals]]) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
console.log(JSON.stringify({ removedRepairJobs: removed, pendingApprovals: approvals.items.filter((item) => item.status === "pending").length }, null, 2));
