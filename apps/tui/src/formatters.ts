import { Chalk } from "chalk";

const chalk = new Chalk({ level: 3 });

/** Truncate a string to a maximum length, adding an ellipsis if needed. */
export function truncate(str: string, max: number): string {
  if (!str || max <= 0) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}

/** Format a path for display, showing relative path if within cwd. */
function formatDisplayPath(filePath: string): string {
  if (!filePath) return "";
  const prefix = process.cwd() + "/";
  if (filePath.startsWith(prefix)) return filePath.slice(prefix.length);
  return filePath;
}

/** Extract the primary argument from a tool input for display. */
export function extractPrimaryArg(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name.toLowerCase()) {
    case "bash":
      return String(i.command ?? "");
    case "read":
    case "write":
    case "edit":
      return formatDisplayPath(String(i.file_path ?? ""));
    case "glob":
    case "grep":
      return String(i.pattern ?? "");
    case "websearch":
      return truncate(String(i.query ?? ""), 50);
    case "webfetch":
      return truncate(String(i.url ?? "").replace(/^https?:\/\//, ""), 50);
    case "askuserquestion": {
      const questions = i.questions as Array<{ header?: string; question?: string }> | undefined;
      if (questions && questions.length > 0) {
        const first = questions[0]!;
        return first.header ?? truncate(String(first.question ?? ""), 30);
      }
      return "";
    }
    default:
      return "";
  }
}

export function getDisplayName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

function hasError(result: unknown): boolean {
  if (result === null || result === undefined) return false;
  const r = result as Record<string, unknown>;
  return r.is_error === true || (typeof r.error === "string" && r.error.length > 0);
}

function extractErrorMessage(result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  if (typeof r.error === "string") return truncate(r.error, 80);
  if (typeof r.content === "string") return truncate(r.content, 80);
  return "unknown error";
}

export function formatToolLine(name: string, input: unknown, result: unknown): string {
  const arg = extractPrimaryArg(name, input);
  const isError = hasError(result);

  const icon = isError ? chalk.red("✗") : chalk.green("✓");
  const line = `${icon} ${getDisplayName(name)} ${chalk.dim(arg)}`;

  if (isError) {
    const errorText = extractErrorMessage(result);
    return line + "\n  " + chalk.red(errorText);
  }

  return line;
}

/**
 * Calculate the line delta for an Edit operation.
 * Returns a string like "+3", "-2", or "+0".
 */
export function getEditLineDelta(oldString: string, newString: string): string {
  const oldCount = oldString ? oldString.split("\n").length : 0;
  const newCount = newString ? newString.split("\n").length : 0;
  const delta = newCount - oldCount;
  return delta >= 0 ? `+${delta}` : `${delta}`;
}

/**
 * Format an inline diff: removed lines in red, added lines in green.
 */
export function formatEditDiff(oldString: string, newString: string): string {
  const output: string[] = [];
  if (oldString) {
    for (const line of oldString.split("\n")) output.push(chalk.red(`  - ${line}`));
  }
  if (newString) {
    for (const line of newString.split("\n")) output.push(chalk.green(`  + ${line}`));
  }
  return output.join("\n");
}
