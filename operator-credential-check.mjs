import { readOperatorCredential } from "./operator-credential.mjs";

await readOperatorCredential();
process.stdout.write("Signal operator credential is valid.\n");
