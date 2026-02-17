import { describe, expect, test } from "bun:test";
import { getProvider } from "../src/providers.ts";

describe("providers", () => {
  test("claude provider injects memory-disable env and preserves existing env", () => {
    const provider = getProvider("claude");
    const resolved = provider.resolve({
      cwd: "/tmp/project",
      env: {
        FOO: "bar",
      },
    });

    expect(resolved.env).toEqual({
      FOO: "bar",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    });
  });

  test("claude provider enforces disable env when caller sets a different value", () => {
    const provider = getProvider("claude");
    const resolved = provider.resolve({
      cwd: "/tmp/project",
      env: {
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0",
      },
    });

    expect(resolved.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });
});
