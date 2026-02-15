/**
 * Thread Manager - handles thread lifecycle
 * CRUD operations, active thread tracking
 */

import { Thread, type ThreadOptions } from "./thread.ts";
import { storage } from "./storage.ts";
import type { Thread as ThreadType } from "@flint-dev/app-server-core";

class ThreadManager {
  // Active threads in memory (for quick access during operations)
  private threads = new Map<string, Thread>();

  /**
   * Create a new thread
   */
  async create(options: ThreadOptions): Promise<Thread> {
    const thread = new Thread(options);
    await thread.save();
    this.threads.set(thread.info.id, thread);
    return thread;
  }

  /**
   * Get a thread by ID (loads from storage if needed)
   */
  async get(threadId: string): Promise<Thread | null> {
    // Check memory first
    const cached = this.threads.get(threadId);
    if (cached) return cached;

    // Load from storage
    const thread = await Thread.load(threadId);
    if (thread) {
      this.threads.set(threadId, thread);
    }
    return thread;
  }

  /**
   * List threads with optional filtering
   */
  async list(
    archived?: boolean,
    limit = 100,
    cursor?: string,
  ): Promise<{ data: ThreadType[]; nextCursor?: string }> {
    return storage.listThreads(archived, limit, cursor);
  }

  /**
   * Archive a thread
   */
  async archive(threadId: string): Promise<boolean> {
    const thread = await this.get(threadId);
    if (!thread) return false;

    if (thread.isRunning()) {
      thread.interrupt();
    }

    await thread.archive();
    return true;
  }

  /**
   * Get thread info with turns (for resume)
   */
  async getWithTurns(
    threadId: string,
  ): Promise<{ thread: ThreadType; model: string; cwd: string } | null> {
    const thread = await this.get(threadId);
    if (!thread) return null;

    return {
      thread: thread.getInfo(), // includes turns
      model: thread.info.model,
      cwd: thread.info.cwd,
    };
  }

  /**
   * Remove a thread from memory (doesn't delete from storage)
   */
  unload(threadId: string): void {
    this.threads.delete(threadId);
  }
}

export const threadManager = new ThreadManager();
