import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export async function readOperatorCredential({
  credentialsDirectory = process.env.CREDENTIALS_DIRECTORY,
  credentialName = "signal-operator-token"
} = {}) {
  if (!credentialsDirectory || !isAbsolute(credentialsDirectory)) {
    throw new Error("Operator credentials require an absolute systemd credentials directory.");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(credentialName)) {
    throw new Error("Operator credential name is invalid.");
  }
  const directory = resolve(credentialsDirectory);
  const path = resolve(directory, credentialName);
  if (path !== join(directory, credentialName)) {
    throw new Error("Operator credential path escapes its credentials directory.");
  }
  const details = await stat(path);
  if (!details.isFile()) throw new Error("Operator credential is not a regular file.");
  const token = (await readFile(path, "utf8")).trim();
  if (token.length < 32) throw new Error("Operator credential must contain at least 32 characters.");
  if (/\s/.test(token)) throw new Error("Operator credential must be a single token.");
  return token;
}
