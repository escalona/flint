import { describe, expect, test } from "bun:test";
import { composeSystemPromptAppend } from "./system-context.ts";

describe("composeSystemPromptAppend", () => {
  test("returns undefined when no sections are available", () => {
    expect(composeSystemPromptAppend([])).toBeUndefined();
  });

  test("composes deterministic sectioned context", () => {
    const composed = composeSystemPromptAppend([
      {
        title: "Memory Recall",
        content: "Run memory_search before answering memory questions.",
      },
      {
        title: "Workspace Rules",
        content: "Use AGENTS.md as the source of truth for repo conventions.",
      },
    ]);

    expect(composed).toContain("<flint_context>");
    expect(composed).toContain("## Memory Recall");
    expect(composed).toContain("## Workspace Rules");
    expect(composed).toContain("</flint_context>");
  });
});
