import { afterEach } from "bun:test";
import { cleanup } from "@testing-library/react";

// Unmount React trees and reset localStorage between tests so state never leaks.
// Imported after test/setup.ts so the DOM globals exist before testing-library
// (and its `screen` helper) is first evaluated.
afterEach(() => {
  cleanup();
  localStorage.clear();
});
