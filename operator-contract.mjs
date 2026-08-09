const allowedOperations = new Set(["quarantine", "restore"]);
const maximumCapabilityTtlMs = 60_000;

export function operatorConfirmation({ operation, directory, inventoryToken }) {
  if (!allowedOperations.has(operation) || !directory || !inventoryToken) {
    throw new Error("A valid operation, directory, and inventory token are required.");
  }
  return `${operation}:${directory}:${inventoryToken}`;
}

export function createOperatorContract({ capabilityStore, ttlMs = 30_000 }) {
  if (!capabilityStore || typeof capabilityStore.issue !== "function") {
    throw new Error("An operator capability store is required.");
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > maximumCapabilityTtlMs) {
    throw new Error("Operator capability TTL must be between 1 and 60000 milliseconds.");
  }

  return {
    issue({ transport, operation, directory, inventoryToken, confirmation }) {
      if (!transport?.authenticated || typeof transport.principal !== "string" || !transport.principal.trim()) {
        throw Object.assign(new Error("Authenticated operator transport is required."), { status: 401 });
      }
      const expected = operatorConfirmation({ operation, directory, inventoryToken });
      if (confirmation !== expected) {
        throw Object.assign(new Error("Exact dry-run confirmation is required."), { status: 409 });
      }
      const capability = capabilityStore.issue({ operation, directory, inventoryToken, ttlMs });
      return {
        ...capability,
        operation,
        directory,
        inventoryToken,
        principal: transport.principal
      };
    }
  };
}
