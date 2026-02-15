import { Chalk } from "chalk";
import { AppServerClient, type AgentEvent } from "@flint-dev/sdk";
import {
  TUI,
  Text,
  Editor,
  Markdown,
  Loader,
  ProcessTerminal,
  matchesKey,
} from "@mariozechner/pi-tui";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@mariozechner/pi-tui";
import { join } from "path";
import { homedir } from "os";
import { mkdir, unlink } from "fs/promises";
import { processFileMentions } from "./mentions";
import {
  truncate,
  extractPrimaryArg,
  getDisplayName,
  formatToolLine,
  getEditLineDelta,
  formatEditDiff,
} from "./formatters";

// ── Theme ────────────────────────────────────────────────────────────────────

const chalk = new Chalk({ level: 3 });

const selectListTheme: SelectListTheme = {
  selectedPrefix: (s: string) => chalk.blue(s),
  selectedText: (s: string) => chalk.bold(s),
  description: (s: string) => chalk.dim(s),
  scrollInfo: (s: string) => chalk.dim(s),
  noMatch: (s: string) => chalk.dim(s),
};

const editorTheme: EditorTheme = {
  borderColor: (s: string) => chalk.dim(s),
  selectList: selectListTheme,
};

const markdownTheme: MarkdownTheme = {
  heading: (s: string) => chalk.bold.cyan(s),
  link: (s: string) => chalk.blue(s),
  linkUrl: (s: string) => chalk.dim(s),
  code: (s: string) => chalk.yellow(s),
  codeBlock: (s: string) => chalk.green(s),
  codeBlockBorder: (s: string) => chalk.dim(s),
  quote: (s: string) => chalk.italic(s),
  quoteBorder: (s: string) => chalk.dim(s),
  hr: (s: string) => chalk.dim(s),
  listBullet: (s: string) => chalk.cyan(s),
  bold: (s: string) => chalk.bold(s),
  italic: (s: string) => chalk.italic(s),
  strikethrough: (s: string) => chalk.strikethrough(s),
  underline: (s: string) => chalk.underline(s),
};

// ── Config ───────────────────────────────────────────────────────────────────

const PROJECT = process.env["FLINT_PROJECT"] ?? process.cwd();
const APP_SERVER_COMMAND = process.env["FLINT_APP_SERVER_COMMAND"] ?? "claude-app-server";
const APP_SERVER_ARGS = (process.env["FLINT_APP_SERVER_ARGS"] ?? "")
  .split(/\s+/)
  .map((part) => part.trim())
  .filter((part) => part.length > 0);
const IS_MAC = process.platform === "darwin";

// ── Image pasting (macOS only) ───────────────────────────────────────────────

async function cacheClipboardImage(threadId: string, imageCount: number): Promise<string | null> {
  if (!IS_MAC) return null;

  const cacheDir = join(homedir(), ".flint/image-cache", threadId);
  await mkdir(cacheDir, { recursive: true });

  const imgPath = join(cacheDir, `${imageCount + 1}.png`);

  try {
    const clipInfo = Bun.spawnSync(["osascript", "-e", "clipboard info"]).stdout.toString();
    if (!clipInfo.includes("PNGf") && !clipInfo.includes("TIFF") && !clipInfo.includes("JPEG")) {
      return null;
    }

    const script = `
set imgPath to POSIX file "${imgPath}"
set imgData to the clipboard as «class PNGf»
set fileRef to open for access imgPath with write permission
write imgData to fileRef
close access fileRef
`;
    Bun.spawnSync(["osascript"], { stdin: Buffer.from(script) });

    const file = Bun.file(imgPath);
    if ((await file.exists()) && file.size > 0) return imgPath;
    await unlink(imgPath);
  } catch {
    try {
      await unlink(imgPath);
    } catch {}
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const client = new AppServerClient({
  command: APP_SERVER_COMMAND,
  args: APP_SERVER_ARGS,
  cwd: PROJECT,
});

try {
  await client.start();
} catch (err) {
  console.error(`Could not start app server: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const threadId = await client.createThread();

// ── TUI setup ────────────────────────────────────────────────────────────────

const terminal = new ProcessTerminal();
const tui = new TUI(terminal);

const header = new Text(chalk.dim(`thread ${threadId.slice(0, 8)}  •  ${PROJECT}`), 1, 0);
tui.addChild(header);

// ── Image indicator state ────────────────────────────────────────────────────

let pendingImages: string[] = [];
let imageIndicator: Text | null = null;

function updateImageIndicator(): void {
  if (pendingImages.length > 0) {
    const indicatorText = pendingImages.map((_, i) => chalk.cyan(`[Image #${i + 1}]`)).join(" ");
    if (!imageIndicator) {
      imageIndicator = new Text(indicatorText, 0, 0);
      const editorIdx = tui.children.indexOf(editor);
      tui.children.splice(editorIdx, 0, imageIndicator);
    } else {
      imageIndicator.setText(indicatorText);
    }
  } else if (imageIndicator) {
    tui.removeChild(imageIndicator);
    imageIndicator = null;
  }
  tui.requestRender();
}

// ── Shared UI state ──────────────────────────────────────────────────────────

let isRunning = false;
let loader: Loader | null = null;
let textBuffer = "";
let currentMarkdown: Markdown | null = null;

const userMsgColor = chalk.hex("#b8b86e");
const NESTED_INDENT = `  ${chalk.dim("│")} `;

function flushText(): void {
  if (textBuffer && currentMarkdown) {
    currentMarkdown.setText(textBuffer);
    tui.requestRender();
  }
}

function resetRunState(): void {
  flushText();
  removeLoader();
  textBuffer = "";
  currentMarkdown = null;
  isRunning = false;
  editor.disableSubmit = false;
  tui.requestRender();
}

function addUserMessage(text: string): void {
  const formatted = text
    .split("\n")
    .map((line) => `${userMsgColor("▎")} ${userMsgColor.italic(line)}`)
    .join("\n");
  const msg = new Text(formatted, 1, 1);
  tui.children.splice(tui.children.length - 1, 0, msg);
  tui.requestRender();
}

function addMarkdownMessage(content: string): Markdown {
  const md = new Markdown(content, 1, 1, markdownTheme);
  tui.children.splice(tui.children.length - 1, 0, md);
  tui.requestRender();
  return md;
}

function removeLoader(): void {
  if (loader) {
    tui.removeChild(loader);
    loader = null;
  }
}

function startLoader(message: string): void {
  removeLoader();
  loader = new Loader(
    tui,
    (s: string) => chalk.cyan(s),
    (s: string) => chalk.dim(s),
    message,
  );
  tui.children.splice(tui.children.length - 1, 0, loader);
  tui.requestRender();
}

function getInsertIndex(): number {
  if (loader) {
    const loaderIdx = tui.children.indexOf(loader);
    if (loaderIdx !== -1) return loaderIdx;
  }
  return tui.children.length - 1;
}

// ── ToolTracker — single event handler, instantiated per run ─────────────────

class ToolTracker {
  private running = new Map<string, Text>();
  private pending = new Map<string, { name: string; input: unknown }>();
  private nested = new Set<string>();
  private subagents = new Map<string, Text>();

  handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "text": {
        if (!currentMarkdown) {
          currentMarkdown = new Markdown("", 1, 1, markdownTheme);
          tui.children.splice(getInsertIndex(), 0, currentMarkdown);
          textBuffer = "";
        }
        textBuffer += event.delta;
        currentMarkdown.setText(textBuffer);
        tui.requestRender();
        break;
      }

      case "tool_start": {
        flushText();
        textBuffer = "";
        currentMarkdown = null;

        const toolId = String(event.id);
        const toolName = String(event.name);
        const input = event.input;
        const parentId = (event as { parentId?: string | null }).parentId;
        this.pending.set(toolId, { name: toolName, input });

        if (parentId) this.nested.add(toolId);

        if (toolName === "Task") {
          const taskText = new Text(
            `${chalk.cyan("⋯")} ${chalk.bold("Task")} ${chalk.dim("running...")}`,
            1,
            1,
          );
          tui.children.splice(getInsertIndex(), 0, taskText);
          this.subagents.set(toolId, taskText);
        } else {
          const arg = extractPrimaryArg(toolName, input);
          const prefix = this.nested.has(toolId) ? NESTED_INDENT : "";
          const toolText = new Text(
            `${prefix}${chalk.cyan("⋯")} ${getDisplayName(toolName)} ${chalk.dim(arg)}`,
            1,
            0,
          );
          tui.children.splice(getInsertIndex(), 0, toolText);
          this.running.set(toolId, toolText);
        }
        tui.requestRender();
        break;
      }

      case "tool_end": {
        const toolId = String(event.id);
        const isError = Boolean(event.isError);
        const result = event.result;
        const toolInfo = this.pending.get(toolId);
        const isNested = this.nested.has(toolId);

        if (this.subagents.has(toolId)) {
          const subText = this.subagents.get(toolId)!;
          const icon = isError ? chalk.red("✗") : chalk.green("✓");
          const description = toolInfo?.input
            ? truncate(String((toolInfo.input as Record<string, unknown>).description ?? ""), 40)
            : "";
          subText.setText(
            `${icon} ${chalk.bold("Task")} ${chalk.dim(description)} ${chalk.dim(isError ? "failed" : "completed")}`,
          );
          this.pending.delete(toolId);
          this.subagents.delete(toolId);
          tui.requestRender();
          break;
        }

        const prefix = isNested ? NESTED_INDENT : "";
        let toolLine: string;
        const toolName = toolInfo?.name?.toLowerCase();

        if (toolName === "edit") {
          const inp = (toolInfo?.input ?? {}) as { old_string?: string; new_string?: string };
          const delta = getEditLineDelta(inp.old_string ?? "", inp.new_string ?? "");
          const baseLine = formatToolLine(toolInfo?.name ?? "edit", toolInfo?.input, result);
          toolLine = prefix + baseLine + " " + chalk.yellow(delta);
          if (!isError && (inp.old_string || inp.new_string)) {
            const diffText = formatEditDiff(inp.old_string ?? "", inp.new_string ?? "");
            const indentedDiff = diffText
              .split("\n")
              .map((line) => prefix + line)
              .join("\n");
            toolLine += "\n" + indentedDiff;
          }
        } else {
          toolLine = prefix + formatToolLine(toolInfo?.name ?? "tool", toolInfo?.input, result);
        }

        if (this.running.has(toolId)) {
          this.running.get(toolId)!.setText(toolLine);
          this.running.delete(toolId);
        }
        this.pending.delete(toolId);
        this.nested.delete(toolId);
        tui.requestRender();
        break;
      }

      case "reasoning":
        if (!loader) startLoader("thinking… (esc to interrupt)");
        else loader.setMessage("thinking… (esc to interrupt)");
        break;

      case "error":
        removeLoader();
        addMarkdownMessage(chalk.red(`Error: ${event.message}`));
        break;
    }
  }
}

// ── Interrupt / cancel ───────────────────────────────────────────────────────

let lastCtrlCTime = 0;

function cancelStreaming(): boolean {
  if (!isRunning) return false;

  client.interrupt();

  const interruptedMsg = new Text(`${chalk.dim("↳")} ${chalk.red("Interrupted")}`, 1, 0);
  tui.children.splice(tui.children.length - 1, 0, interruptedMsg);

  resetRunState();
  return true;
}

// ── Editor ───────────────────────────────────────────────────────────────────

class FlintEditor extends Editor {
  onInterrupt?: () => void;

  override handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      const now = Date.now();
      if (now - lastCtrlCTime < 1500) {
        this.onInterrupt?.();
        return;
      }
      lastCtrlCTime = now;

      if (isRunning) cancelStreaming();
      pendingImages = [];
      updateImageIndicator();
      this.setText("");
      tui.requestRender();
      return;
    }
    if (matchesKey(data, "escape")) {
      cancelStreaming();
      return;
    }
    if (matchesKey(data, "ctrl+v")) {
      cacheClipboardImage(threadId, pendingImages.length).then((cachedPath) => {
        if (cachedPath) {
          pendingImages.push(cachedPath);
          updateImageIndicator();
        }
      });
      return;
    }
    super.handleInput(data);
  }
}

const editor = new FlintEditor(tui, editorTheme);
tui.addChild(editor);
tui.setFocus(editor);

// ── runPrompt ────────────────────────────────────────────────────────────────

async function runPrompt(processed: string, displayText: string): Promise<void> {
  isRunning = true;
  editor.disableSubmit = true;

  const tracker = new ToolTracker();
  textBuffer = "";
  currentMarkdown = null;

  addUserMessage(displayText);
  startLoader("thinking… (esc to interrupt)");

  try {
    for await (const event of client.prompt(processed)) {
      tracker.handleEvent(event);
    }
  } catch (err) {
    removeLoader();
    addMarkdownMessage(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
  } finally {
    resetRunState();
  }
}

// ── Submit handler ───────────────────────────────────────────────────────────

editor.onSubmit = (value: string) => {
  if (isRunning) return;
  const trimmed = value.trim();
  if (!trimmed) return;

  const processed = processFileMentions(trimmed, PROJECT);

  let finalPrompt = processed;
  if (pendingImages.length > 0) {
    const imagePaths = pendingImages.map((p, i) => `[Image #${i + 1}]: ${p}`).join("\n");
    finalPrompt = `${imagePaths}\n\n${processed}`;
    pendingImages = [];
    updateImageIndicator();
  }

  runPrompt(finalPrompt, trimmed);
};

// ── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(): void {
  tui.stop();
  client.close();
  process.exit(0);
}

editor.onInterrupt = shutdown;

// ── Start ────────────────────────────────────────────────────────────────────

tui.start();
