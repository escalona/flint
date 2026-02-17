export interface SystemContextSection {
  title: string;
  content: string;
}

export function composeSystemPromptAppend(sections: SystemContextSection[]): string | undefined {
  const normalized = sections
    .map((section) => ({
      ...section,
      title: section.title.trim(),
      content: section.content.trim(),
    }))
    .filter((section) => section.title && section.content);

  if (normalized.length === 0) {
    return undefined;
  }

  const lines: string[] = [
    "<flint_context>",
    "This context is appended by Flint. Follow it unless higher-priority instructions conflict.",
    "",
  ];

  for (const section of normalized) {
    lines.push(`## ${section.title}`, section.content, "");
  }

  lines.push("</flint_context>");
  return lines.join("\n").trim();
}
