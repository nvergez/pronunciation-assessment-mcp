export function stringifyResult(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, nested: unknown) => {
      if (typeof Buffer !== "undefined" && Buffer.isBuffer(nested)) {
        throw new Error("Refusing to serialize audio bytes.");
      }
      if (nested instanceof Uint8Array) {
        throw new Error("Refusing to serialize audio bytes.");
      }
      return nested;
    },
    2,
  );
}
