import { describe, expect, test } from "bun:test";
import { markdownToMrkdwn } from "./markdown-to-mrkdwn.ts";

describe("markdownToMrkdwn", () => {
  test("converts **bold** to *bold*", () => {
    expect(markdownToMrkdwn("this is **bold** text")).toBe("this is *bold* text");
  });

  test("converts ## headers to bold", () => {
    expect(markdownToMrkdwn("## Section Title")).toBe("*Section Title*");
    expect(markdownToMrkdwn("### Subsection")).toBe("*Subsection*");
  });

  test("converts [text](url) to Slack link", () => {
    expect(markdownToMrkdwn("[click here](https://example.com)")).toBe(
      "<https://example.com|click here>",
    );
  });

  test("preserves code blocks", () => {
    const input = "before\n```\nconst x = **not bold**;\n```\nafter **bold**";
    const expected = "before\n```\nconst x = **not bold**;\n```\nafter *bold*";
    expect(markdownToMrkdwn(input)).toBe(expected);
  });

  test("preserves inline code", () => {
    expect(markdownToMrkdwn("use `**bold**` for bold")).toBe("use `**bold**` for bold");
  });

  test("transforms around inline code", () => {
    expect(markdownToMrkdwn("**bold** then `code` then **bold**")).toBe(
      "*bold* then `code` then *bold*",
    );
  });

  test("realistic Claude response", () => {
    const input = [
      "## Root Cause",
      "",
      "The issue is a **backward-compat regression** from the subfolder rollout.",
      "",
      "- `parentFolderId` is sent as a folder **name**, not a UUID",
      "",
      "```",
      "GET /media/v2/folders?parentFolderId=Stranger+Things",
      "```",
      "",
      "See [the PR](https://github.com/org/repo/pull/123) for details.",
    ].join("\n");

    const expected = [
      "*Root Cause*",
      "",
      "The issue is a *backward-compat regression* from the subfolder rollout.",
      "",
      "- `parentFolderId` is sent as a folder *name*, not a UUID",
      "",
      "```",
      "GET /media/v2/folders?parentFolderId=Stranger+Things",
      "```",
      "",
      "See <https://github.com/org/repo/pull/123|the PR> for details.",
    ].join("\n");

    expect(markdownToMrkdwn(input)).toBe(expected);
  });
});
