// SPDX-License-Identifier: MIT
// Undo/redo binding design (architecture §9):

import { useSyncExternalStore } from "react";

export interface Command {
  /** clientOpId — also sent to mutating routes for server dedupe */
  id: string;
  /** short human label, e.g. "Rename list" (status bar + toasts) */
  label: string;
  /** grouping scope, e.g. 'item' | 'metadata' | 'import' | 'list' */
  scope: string;
  do: () => Promise<void> | void;
  undo: () => Promise<void> | void;
  at: number;
}

export interface CommandBusState {
  undoDepth: number;
  redoDepth: number;
  undoLabel: string | null;
  redoLabel: string | null;
}

type Listener = (s: CommandBusState) => void;

const UNDO_CAP = 100;

class CommandBus {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private listeners = new Set<Listener>();
  private running = false;

  snapshot(): CommandBusState {
    return {
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
      undoLabel: this.undoStack[this.undoStack.length - 1]?.label ?? null,
      redoLabel: this.redoStack[this.redoStack.length - 1]?.label ?? null,
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit() {
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
  }

  /** Run do(); on success push to undo and CLEAR redo. */
  async execute(cmd: Command): Promise<void> {
    if (this.running) throw new Error("command already running");
    this.running = true;
    try {
      await cmd.do();
      this.push(cmd);
    } finally {
      this.running = false;
      this.emit();
    }
  }

  /** Record an already-completed action as undoable (imports): no do() run. */
  push(cmd: Command): void {
    this.undoStack.push(cmd);
    if (this.undoStack.length > UNDO_CAP) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
  }

  async undo(): Promise<Command | null> {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    await cmd.undo();
    this.redoStack.push(cmd);
    this.emit();
    return cmd;
  }

  async redo(): Promise<Command | null> {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    await cmd.do();
    this.undoStack.push(cmd);
    this.emit();
    return cmd;
  }

  /** Drop the top undo command without running undo (used on server reject). */
  dropTop(reason: string): Command | null {
    const cmd = this.undoStack.pop() ?? null;
    if (cmd) {
      // eslint-disable-next-line no-console
      console.warn(`[commands] dropped "${cmd.label}" (${reason})`);
    }
    this.emit();
    return cmd;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }
}

export const commandBus = new CommandBus();

/** React hook for the undo/redo button state. */
export function useCommandBus(): CommandBusState {
  return useSyncExternalStore(
    (fn: Listener) => commandBus.subscribe(fn),
    () => commandBus.snapshot(),
    () => commandBus.snapshot(),
  );
}
