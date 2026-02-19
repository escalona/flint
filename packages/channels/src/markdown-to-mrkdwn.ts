/** Converts standard Markdown to Slack mrkdwn. */
export function markdownToMrkdwn(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }
    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    // Headers: ## Title → *Title*
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      result.push(`*${headerMatch[2]!.trim()}*`);
      continue;
    }

    // Convert inline formatting, skipping backtick spans
    result.push(
      line.replace(
        /(`[^`]+`)|(\*{2}(.+?)\*{2})|(\[([^\]]+)\]\(([^)]+)\))/g,
        (_match, code: string, _bold: string, boldInner: string, _link: string, linkText: string, linkUrl: string) => {
          if (code) return code;
          if (boldInner) return `*${boldInner}*`;
          if (linkText) return `<${linkUrl}|${linkText}>`;
          return _match;
        },
      ),
    );
  }

  return result.join("\n");
}
