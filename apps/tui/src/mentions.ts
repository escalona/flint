import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { resolve } from "path";

/** Check if a path is ignored by git */
export function isGitIgnored(path: string, cwd: string): boolean {
  const result = Bun.spawnSync(["git", "check-ignore", "-q", path], { cwd });
  return result.exitCode === 0;
}

/**
 * Process @file mentions in input text.
 * - Files: Full contents embedded in <file> tags
 * - Directories: Listing embedded in <directory> tags
 * Returns the processed prompt with file contents prepended.
 */
export function processFileMentions(input: string, basePath: string): string {
  const mentionRegex = /@([^\s]+)/g;
  const mentions: Array<{ absolutePath: string; isDir: boolean }> = [];

  // Find all @mentions
  let match;
  while ((match = mentionRegex.exec(input)) !== null) {
    const filePath = match[1];
    if (!filePath) continue;
    const absolutePath = resolve(basePath, filePath);
    if (existsSync(absolutePath) && !isGitIgnored(absolutePath, basePath)) {
      mentions.push({
        absolutePath,
        isDir: statSync(absolutePath).isDirectory(),
      });
    }
  }

  if (mentions.length === 0) return input;

  // Read and format contents
  const contents = mentions
    .map(({ absolutePath, isDir }) => {
      try {
        if (isDir) {
          const entries = readdirSync(absolutePath, { withFileTypes: true });
          const listing = entries
            .filter((e) => !isGitIgnored(resolve(absolutePath, e.name), basePath))
            .map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`)
            .join("\n");
          return `<directory path="${absolutePath}">\n${listing}\n</directory>`;
        } else {
          const content = readFileSync(absolutePath, "utf-8");
          return `<file path="${absolutePath}">\n${content}\n</file>`;
        }
      } catch {
        return `<!-- Could not read ${absolutePath} -->`;
      }
    })
    .join("\n\n");

  // Remove @mentions from prompt, prepend contents
  const cleanedPrompt = input.replace(mentionRegex, "").trim();
  return `${contents}\n\n${cleanedPrompt}`;
}
