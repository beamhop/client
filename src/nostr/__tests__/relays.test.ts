import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { loadRelays, readRelays, writeRelays } from "../relays.ts";
import type { RelayInfo } from "../types.ts";

const STORAGE_KEY = "verity.relays.v1";
const storage = new Map<string, string>();

const localStorageMock: Storage = {
  get length() {
    return storage.size;
  },
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  key: (index) => Array.from(storage.keys())[index] ?? null,
  removeItem: (key) => {
    storage.delete(key);
  },
  setItem: (key, value) => {
    storage.set(key, value);
  },
};

beforeAll(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorageMock,
  });
});

afterEach(() => {
  localStorage.removeItem(STORAGE_KEY);
});

describe("relay settings", () => {
  test("disabled relays are excluded from read and write URL lists", () => {
    const relays: RelayInfo[] = [
      {
        url: "wss://enabled.example",
        enabled: true,
        read: true,
        write: true,
        status: "disconnected",
      },
      {
        url: "wss://disabled.example",
        enabled: false,
        read: true,
        write: true,
        status: "disconnected",
      },
    ];

    expect(readRelays(relays)).toEqual(["wss://enabled.example"]);
    expect(writeRelays(relays)).toEqual(["wss://enabled.example"]);
  });

  test("old stored relays without enabled migrate to enabled", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ url: "wss://legacy.example", read: true, write: false }]),
    );

    expect(loadRelays()).toEqual([
      {
        url: "wss://legacy.example",
        enabled: true,
        read: true,
        write: false,
        status: "disconnected",
      },
    ]);
  });
});
