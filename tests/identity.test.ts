import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The shell runs in the browser; stub the globals store.ts reaches for.
const mem = new Map<string, string>();
const realCrypto = globalThis.crypto;

function setCrypto(value: unknown) {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value });
}

beforeEach(() => {
  mem.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => mem.set(k, String(v)),
      removeItem: (k: string) => mem.delete(k),
    },
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "http:", host: "192.168.1.5:4700" },
  });
});

afterEach(() => setCrypto(realCrypto));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("getToken", () => {
  it("mints a token without crypto.randomUUID (non-secure LAN origin)", async () => {
    // Browsers only expose randomUUID in secure contexts, and joining over
    // http://<lan-ip> is not one — this used to throw and strand the join.
    setCrypto({ getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });
    const { getToken } = await import("../shell/store.ts");
    expect(getToken()).toMatch(UUID_RE);
  });

  it("is stable across calls", async () => {
    setCrypto({ getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });
    const { getToken } = await import("../shell/store.ts");
    expect(getToken()).toBe(getToken());
  });

  it("uses randomUUID when it is available", async () => {
    setCrypto({ randomUUID: () => "11111111-2222-4333-8444-555555555555" });
    const { getToken } = await import("../shell/store.ts");
    expect(getToken()).toBe("11111111-2222-4333-8444-555555555555");
  });
});
