import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { operatorConfirmation } from "./operator-contract.mjs";

function validateToken(value) {
  const token = String(value || "").trim();
  if (token.length < 32 || /\s/.test(token)) {
    throw new Error("Operator token from the inherited file descriptor is invalid.");
  }
  return token;
}

export async function readOperatorTokenFromFd({ env = process.env, read = readFile } = {}) {
  const fdText = env.SIGNAL_OPERATOR_TOKEN_FD || "3";
  if (!/^[0-9]+$/.test(fdText)) throw new Error("SIGNAL_OPERATOR_TOKEN_FD must be a numeric inherited file descriptor.");
  const fd = Number(fdText);
  if (!Number.isSafeInteger(fd) || fd < 3) throw new Error("Operator token file descriptor must be 3 or greater.");
  return validateToken(await read(fd, "utf8"));
}

async function requestJson({ baseUrl, token, path, method = "GET", body, request = fetch }) {
  const response = await request(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || `Operator request failed with HTTP ${response.status}.`);
  return payload;
}

export async function runOperatorClient({
  argv = process.argv.slice(2),
  env = process.env,
  readToken = () => readOperatorTokenFromFd({ env }),
  request = fetch
} = {}) {
  const [command, operation, directory, inventoryToken, confirmation] = argv;
  if (!new Set(["quarantine", "restore"]).has(operation)) {
    throw new Error("Operation must be quarantine or restore.");
  }
  const host = env.OPERATOR_HOST || "127.0.0.1";
  const port = Number(env.OPERATOR_PORT || 4535);
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("Operator client is restricted to loopback.");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("OPERATOR_PORT is invalid.");
  const baseUrl = `http://${host === "::1" ? `[${host}]` : host}:${port}`;
  const token = await readToken();

  if (command === "preview") {
    if (directory || inventoryToken || confirmation) throw new Error("Preview accepts only an operation.");
    return requestJson({ baseUrl, token, path: `/operator/${operation === "quarantine" ? "quarantine" : "restore"}-preview`, request });
  }
  if (command !== "apply") throw new Error("Command must be preview or apply.");
  if (!directory || !inventoryToken || !confirmation) {
    throw new Error("Apply requires directory, inventory token, and exact confirmation.");
  }
  const expectedConfirmation = operatorConfirmation({ operation, directory, inventoryToken });
  if (confirmation !== expectedConfirmation) throw new Error("Exact dry-run confirmation is required.");
  const capability = await requestJson({
    baseUrl, token, path: "/operator/capabilities", method: "POST", request,
    body: { operation, directory, inventoryToken, confirmation }
  });
  return requestJson({
    baseUrl, token, path: `/operator/${operation}`, method: "POST", request,
    body: { capability: capability.token, directory, inventoryToken }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runOperatorClient().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`Signal operator client failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
