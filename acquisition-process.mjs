import { readdir, readFile } from "node:fs/promises";

const stopping = new WeakMap();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A leader's close event does not prove that descendants which closed their
// stdio have stopped. Linux /proc also lets us distinguish inert zombies from
// processes still capable of writing, even when PID 1 has not reaped them yet.
export async function processGroupHasWriters(groupId) {
  try { process.kill(-groupId, 0); }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let contents;
    try { contents = await readFile(`/proc/${entry}/stat`, "utf8"); }
    catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") continue; throw error; }
    const fields = contents.slice(contents.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === groupId && !["Z", "X", "x"].includes(fields[0])) return true;
  }
  return false;
}

export function terminateProcessTree(child, { graceMs = 2000, settleMs = 5000 } = {}) {
  if (!child?.pid) return Promise.resolve();
  if (stopping.has(child)) return stopping.get(child);
  const signal = (name) => {
    try { process.kill(-child.pid, name); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const promise = (async () => {
    signal("SIGTERM");
    const graceDeadline = Date.now() + graceMs;
    const deadline = graceDeadline + settleMs;
    let killed = false;
    while (await processGroupHasWriters(child.pid)) {
      if (!killed && Date.now() >= graceDeadline) { signal("SIGKILL"); killed = true; }
      if (Date.now() >= deadline) throw new Error("Downloader process group did not stop; acquisition is locked pending service review.");
      await delay(50);
    }
  })();
  stopping.set(child, promise);
  // Callers may request cancellation without awaiting it; the acquisition's
  // close handler must await this same promise before any validation or queue work.
  void promise.catch(() => {});
  return promise;
}
