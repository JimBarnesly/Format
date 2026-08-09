import { createServer } from "node:http";
import { authenticateOperatorTransport } from "./operator-transport.mjs";
import { operatorConfirmation } from "./operator-contract.mjs";
import { quarantinePreview, quarantineRestorePreview } from "./staging-quarantine.mjs";

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw Object.assign(new Error("Operator request is too large."), { status: 413 });
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw Object.assign(new Error("Operator request must contain valid JSON."), { status: 400 });
  }
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

export function createOperatorHandler({
  expectedToken,
  allowedOrigin,
  readStagingInventory,
  readQuarantineInventory,
  contract,
  quarantineCoordinator,
  restoreCoordinator,
  mutationsEnabled = false
}) {
  return async function operatorHandler(request, response) {
    try {
      const transport = authenticateOperatorTransport({
        remoteAddress: request.socket.remoteAddress,
        authorization: request.headers.authorization,
        origin: request.headers.origin,
        expectedToken,
        allowedOrigin
      });
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/operator/quarantine-preview") {
        return json(response, 200, quarantinePreview(await readStagingInventory()));
      }
      if (request.method === "GET" && url.pathname === "/operator/restore-preview") {
        return json(response, 200, quarantineRestorePreview(await readQuarantineInventory()));
      }
      if (!mutationsEnabled && request.method === "POST") {
        return json(response, 503, { error: "Operator mutations are disabled." });
      }
      if (request.method === "POST" && url.pathname === "/operator/capabilities") {
        const body = await readJson(request);
        return json(response, 201, contract.issue({ ...body, transport }));
      }
      if (request.method === "POST" && url.pathname === "/operator/quarantine") {
        const body = await readJson(request);
        return json(response, 200, await quarantineCoordinator.quarantine({
          capability: body.capability,
          inventoryToken: body.inventoryToken,
          directories: [body.directory]
        }));
      }
      if (request.method === "POST" && url.pathname === "/operator/restore") {
        return json(response, 200, await restoreCoordinator.restore(await readJson(request)));
      }
      return json(response, 404, { error: "Operator route not found." });
    } catch (error) {
      return json(response, error.status || 409, { error: error.message });
    }
  };
}

export async function startOperatorServer({
  handler,
  reconcileQuarantine,
  reconcileRestore,
  host = "127.0.0.1",
  port = 0
}) {
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("Operator server must bind to loopback.");
  const quarantineRecovery = await reconcileQuarantine();
  const restoreRecovery = await reconcileRestore();
  const invalidRecovery = [
    ["quarantine", quarantineRecovery],
    ["restore", restoreRecovery]
  ].flatMap(([operation, report]) => {
    if (!report || !Array.isArray(report.invalid)) {
      return [`${operation} recovery returned an invalid report`];
    }
    return report.invalid.map((item) => `${operation}: ${item?.intent || "unknown intent"}: ${item?.error || "invalid state"}`);
  });
  if (invalidRecovery.length) {
    throw new Error(`Operator recovery requires manual review: ${invalidRecovery.join("; ")}`);
  }
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}

export { operatorConfirmation };
