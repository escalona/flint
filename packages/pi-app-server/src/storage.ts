/**
 * File-based thread storage
 * Stores threads in ~/.flint/pi-app-server/threads/ as append-only JSONL rollouts.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import type { Thread, Turn } from "@flint-dev/app-server-core";

let STORAGE_DIR = join(homedir(), ".flint", "pi-app-server");
let THREADS_DIR = join(STORAGE_DIR, "threads");
const ROLLOUT_FILENAME = "rollout.jsonl";
const LEGACY_METADATA_FILENAME = "metadata.json";

interface ThreadData {
  info: Thread;
  turns: Turn[];
  piSessionFile?: string;
}

interface RolloutSnapshotLine {
  type: "snapshot";
  version: 1;
  timestamp: number;
  data: ThreadData;
}

export class Storage {
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(THREADS_DIR, { recursive: true });
    this.initialized = true;
  }

  private threadDir(threadId: string): string {
    return join(THREADS_DIR, threadId);
  }

  private rolloutPath(threadId: string): string {
    return join(this.threadDir(threadId), ROLLOUT_FILENAME);
  }

  private legacyMetadataPath(threadId: string): string {
    return join(this.threadDir(threadId), LEGACY_METADATA_FILENAME);
  }

  async saveThread(data: ThreadData): Promise<void> {
    await this.init();
    const dir = this.threadDir(data.info.id);
    await mkdir(dir, { recursive: true });
    const line: RolloutSnapshotLine = {
      type: "snapshot",
      version: 1,
      timestamp: Date.now(),
      data,
    };
    await appendFile(this.rolloutPath(data.info.id), JSON.stringify(line) + "\n");
  }

  async loadThread(threadId: string): Promise<ThreadData | null> {
    await this.init();
    const fromRollout = await this.loadLatestSnapshot(this.rolloutPath(threadId));
    if (fromRollout) {
      return fromRollout;
    }

    // Backward-compatible fallback for previously persisted metadata.json.
    const legacy = await this.loadLegacyMetadata(threadId);
    if (legacy) {
      await this.saveThread(legacy);
      return legacy;
    }

    return null;
  }

  private async loadLatestSnapshot(path: string): Promise<ThreadData | null> {
    try {
      const content = await readFile(path, "utf-8");
      const lines = content.split("\n");
      let latest: ThreadData | null = null;

      for (const line of lines) {
        const parsed = this.parseSnapshotLine(line);
        if (parsed) latest = parsed;
      }

      return latest;
    } catch {
      return null;
    }
  }

  private parseSnapshotLine(line: string): ThreadData | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    try {
      const parsed = JSON.parse(trimmed) as Partial<RolloutSnapshotLine>;
      if (parsed.type === "snapshot" && parsed.data) {
        return parsed.data;
      }
    } catch {
      // Ignore malformed trailing/partial lines.
    }

    return null;
  }

  private async loadLegacyMetadata(threadId: string): Promise<ThreadData | null> {
    try {
      const content = await readFile(this.legacyMetadataPath(threadId), "utf-8");
      return JSON.parse(content) as ThreadData;
    } catch {
      return null;
    }
  }

  async deleteThread(threadId: string): Promise<boolean> {
    await this.init();
    try {
      await rm(this.threadDir(threadId), { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  async listThreads(
    archived?: boolean,
    limit = 100,
    cursor?: string,
  ): Promise<{ data: Thread[]; nextCursor?: string }> {
    await this.init();

    let entries: string[];
    try {
      entries = await readdir(THREADS_DIR);
    } catch {
      return { data: [] };
    }

    const threads: Thread[] = [];
    for (const id of entries) {
      const data = await this.loadThread(id);
      if (data) {
        if (archived !== undefined) {
          const isArchived = data.info.source === "archived";
          if (archived !== isArchived) continue;
        }
        threads.push(data.info);
      }
    }

    threads.sort((a, b) => b.updatedAt - a.updatedAt);

    let startIdx = 0;
    if (cursor) {
      const cursorIdx = threads.findIndex((t) => t.id === cursor);
      if (cursorIdx !== -1) startIdx = cursorIdx + 1;
    }

    const page = threads.slice(startIdx, startIdx + limit);
    const nextCursor =
      startIdx + limit < threads.length ? threads[startIdx + limit - 1]?.id : undefined;

    return { data: page, nextCursor };
  }

  async setPiSessionFile(threadId: string, piSessionFile: string): Promise<boolean> {
    const data = await this.loadThread(threadId);
    if (!data) return false;

    data.piSessionFile = piSessionFile;
    await this.saveThread(data);
    return true;
  }

  async getPiSessionFile(threadId: string): Promise<string | undefined> {
    const data = await this.loadThread(threadId);
    return data?.piSessionFile;
  }
}

export const storage = new Storage();

/**
 * Set custom storage directory (for testing)
 */
export function setStorageDirectory(dir: string): void {
  STORAGE_DIR = dir;
  THREADS_DIR = join(dir, "threads");
  storage["initialized"] = false;
}

/**
 * Reset storage to default directory
 */
export function resetStorageDirectory(): void {
  STORAGE_DIR = join(homedir(), ".flint", "pi-app-server");
  THREADS_DIR = join(STORAGE_DIR, "threads");
  storage["initialized"] = false;
}
