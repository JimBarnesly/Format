import { timingSafeEqual } from "node:crypto";

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function sameSecret(provided, expected) {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

export function authenticateOperatorTransport({
  remoteAddress,
  authorization,
  expectedToken,
  origin,
  allowedOrigin
}) {
  if (!isLoopback(remoteAddress)) {
    throw Object.assign(new Error("Operator access is restricted to loopback."), { status: 403 });
  }
  if (typeof expectedToken !== "string" || expectedToken.length < 32) {
    throw new Error("A strong operator token is not configured.");
  }
  if (origin && origin !== allowedOrigin) {
    throw Object.assign(new Error("Operator request origin is not allowed."), { status: 403 });
  }
  const prefix = "Bearer ";
  const provided = typeof authorization === "string" && authorization.startsWith(prefix)
    ? authorization.slice(prefix.length)
    : "";
  if (!sameSecret(provided, expectedToken)) {
    throw Object.assign(new Error("Operator authentication failed."), { status: 401 });
  }
  return { authenticated: true, principal: "loopback-operator" };
}
