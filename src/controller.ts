import { relative, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { open, type GlimpseWindow } from "glimpseui";
import { createCheckpoint, getIgnoredDirectoryPaths, getRepoRoot } from "./git.js";
import { composeFeedback } from "./prompt.js";
import type { HostMessage, ReviewCheckpoint, WindowMessage } from "./types.js";
import { getReviewHtmlPath } from "./ui.js";
import { startRepositoryWatcher, type RepositoryWatcher } from "./watcher.js";
import { WorkspaceModel } from "./workspace.js";

export const CHECKPOINT_ENTRY = "review-loop/checkpoint";

function isCheckpoint(value: unknown): value is ReviewCheckpoint {
  if (value == null || typeof value !== "object") return false;
  const item = value as Partial<ReviewCheckpoint>;
  return item.version === 1 && typeof item.repoRoot === "string" && typeof item.createdAt === "number" && typeof item.overrides === "object";
}

function latestCheckpoint(ctx: ExtensionCommandContext, repoRoot: string): ReviewCheckpoint | null {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "custom" || entry.customType !== CHECKPOINT_ENTRY) continue;
    if (isCheckpoint(entry.data) && entry.data.repoRoot === repoRoot) return entry.data;
  }
  return null;
}

function escapeInline(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function parseMessage(value: unknown): WindowMessage | null {
  if (value == null || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") return null;
  return value as WindowMessage;
}

export interface ReviewControllerDependencies {
  openWindow?: typeof open;
  startWatcher?: typeof startRepositoryWatcher;
}

export class ReviewController {
  private window: GlimpseWindow | null = null;
  private watcher: RepositoryWatcher | null = null;
  private model: WorkspaceModel | null = null;
  private repoRoot = "";
  private refreshTimer: NodeJS.Timeout | null = null;
  private operation = Promise.resolve();
  private submitting = false;
  private opening = false;
  private pendingRefresh = false;
  private watcherFailure: Error | null = null;
  private refreshErrorNotified = false;
  private generation = 0;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly onClosed: () => void,
    private readonly dependencies: ReviewControllerDependencies = {},
  ) {}

  get isOpen(): boolean {
    return this.window != null;
  }

  async openOrShow(ctx: ExtensionCommandContext): Promise<void> {
    if (this.window != null) {
      this.window.show({ title: "Review Loop" });
      ctx.ui.notify("Review Loop is already open.", "info");
      return;
    }
    if (this.opening) {
      ctx.ui.notify("Review Loop is already opening.", "info");
      return;
    }

    this.opening = true;
    const generation = ++this.generation;
    this.pendingRefresh = false;
    this.watcherFailure = null;
    this.refreshErrorNotified = false;

    try {
      this.repoRoot = await getRepoRoot(this.pi, ctx.cwd);
      if (generation !== this.generation) return;

      const [model, ignoredDirectories] = await Promise.all([
        WorkspaceModel.create(this.pi, this.repoRoot, latestCheckpoint(ctx, this.repoRoot)),
        getIgnoredDirectoryPaths(this.pi, this.repoRoot),
      ]);
      if (generation !== this.generation) return;

      const watcher = await (this.dependencies.startWatcher ?? startRepositoryWatcher)({
        repoRoot: this.repoRoot,
        ignoredDirectories,
        onChange: (path) => {
          if (generation !== this.generation || this.toRepoPath(path) == null) return;
          if (this.window == null) {
            this.pendingRefresh = true;
            return;
          }
          this.scheduleRefresh(ctx);
        },
        onError: (error) => {
          if (generation === this.generation) this.handleWatcherFailure(error, ctx);
        },
      });
      if (generation !== this.generation) {
        await watcher.close();
        return;
      }

      this.model = model;
      this.watcher = watcher;
      await model.refresh();
      if (generation !== this.generation) return;
      if (this.watcherFailure != null) throw this.watcherFailure;

      const window = (this.dependencies.openWindow ?? open)("", { width: 1480, height: 920, title: "Review Loop" });
      this.window = window;
      window.on("message", (value) => {
        const message = parseMessage(value);
        if (message != null) void this.handleMessage(message, ctx);
      });
      window.on("closed", () => this.disposeWindow(window));
      window.on("error", (error) => {
        ctx.ui.notify(`Review Loop failed: ${error.message}`, "error");
        this.disposeWindow(window, true);
      });
      window.once("ready", () => {
        if (this.window !== window) return;
        try {
          window.loadFile(getReviewHtmlPath());
        } catch (error) {
          ctx.ui.notify(`Review Loop failed to load: ${error instanceof Error ? error.message : String(error)}`, "error");
          this.disposeWindow(window, true);
        }
      });

      if (this.pendingRefresh) {
        this.pendingRefresh = false;
        this.scheduleRefresh(ctx);
      }
      ctx.ui.notify("Opened Review Loop.", "info");
    } catch (error) {
      if (generation === this.generation) {
        const resources = this.detachState();
        await resources.watcher?.close();
        try { resources.window?.close(); } catch {}
      }
      throw error;
    } finally {
      if (generation === this.generation) this.opening = false;
    }
  }

  async close(): Promise<void> {
    this.opening = false;
    const resources = this.detachState();
    await resources.watcher?.close();
    try { resources.window?.close(); } catch {}
  }

  private toRepoPath(absolutePath: string): string | null {
    const path = relative(this.repoRoot, absolutePath);
    if (!path || path === ".." || path.startsWith(`..${sep}`)) return null;
    return path.split(sep).join("/");
  }

  private scheduleRefresh(ctx: ExtensionCommandContext): void {
    if (this.refreshTimer != null) clearTimeout(this.refreshTimer);
    const generation = this.generation;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.enqueue(async () => {
        const model = this.model;
        if (model == null || generation !== this.generation) return;
        const state = await model.refresh();
        if (model !== this.model || generation !== this.generation) return;
        this.refreshErrorNotified = false;
        this.send({ type: "workspace", state });
      }, (error) => {
        if (generation !== this.generation || this.window == null || this.refreshErrorNotified) return;
        this.refreshErrorNotified = true;
        ctx.ui.notify(`Review Loop could not refresh: ${error instanceof Error ? error.message : String(error)}`, "error");
      });
    }, 100);
  }

  private enqueue(task: () => Promise<void>, onError: (error: unknown) => void): void {
    const run = async (): Promise<void> => {
      try {
        await task();
      } catch (error) {
        try { onError(error); } catch {}
      }
    };
    this.operation = this.operation.then(run, run);
  }

  private async handleMessage(message: WindowMessage, ctx: ExtensionCommandContext): Promise<void> {
    if (this.model == null) return;
    if (message.type === "ready") {
      this.send({ type: "workspace", state: this.model.state() });
      return;
    }

    if (message.type === "set-mode") {
      this.model.setMode(message.mode);
      this.send({ type: "workspace", state: this.model.state() });
      return;
    }

    if (message.type === "request-file") {
      try {
        this.send({ type: "file", requestId: message.requestId, file: this.model.getFile(message.path, message.mode) });
      } catch (error) {
        this.send({ type: "file-error", requestId: message.requestId, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (message.type === "submit-review" && !this.submitting) {
      this.submitting = true;
      try {
        const feedback = composeFeedback(message.comments);
        const reviewedPaths = this.model.checkpointChangedPaths();
        const checkpoint = await createCheckpoint(this.pi, this.repoRoot, reviewedPaths, feedback);
        this.pi.appendEntry<ReviewCheckpoint>(CHECKPOINT_ENTRY, checkpoint);
        this.model.setCheckpoint(checkpoint);
        const state = await this.model.refresh();
        if (feedback) ctx.ui.pasteToEditor(feedback);
        this.send({ type: "workspace", state });
        this.send({ type: "review-submitted", checkpointAt: checkpoint.createdAt, insertedFeedback: feedback.length > 0 });
        ctx.ui.notify(feedback ? "Review checkpoint saved; feedback inserted into the editor." : "Review checkpoint saved.", "info");
      } catch (error) {
        ctx.ui.notify(`Could not save review checkpoint: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        this.submitting = false;
      }
    }
  }

  private send(message: HostMessage): void {
    if (this.window == null) return;
    const payload = escapeInline(JSON.stringify(message));
    try { this.window.send(`window.__reviewReceive(${payload})`); } catch {}
  }

  private handleWatcherFailure(error: Error, ctx: ExtensionCommandContext): void {
    this.watcherFailure = error;
    const window = this.window;
    if (window == null) return;
    ctx.ui.notify(`Review Loop stopped watching files: ${error.message}`, "error");
    this.disposeWindow(window, true);
  }

  private detachState(): { window: GlimpseWindow | null; watcher: RepositoryWatcher | null } {
    const resources = { window: this.window, watcher: this.watcher };
    this.window = null;
    this.watcher = null;
    this.model = null;
    this.pendingRefresh = false;
    this.watcherFailure = null;
    this.refreshErrorNotified = false;
    this.submitting = false;
    this.opening = false;
    this.generation += 1;
    if (this.refreshTimer != null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.operation = Promise.resolve();
    return resources;
  }

  private disposeWindow(window: GlimpseWindow, closeWindow = false): void {
    if (this.window !== window) return;
    const resources = this.detachState();
    if (closeWindow) {
      try { resources.window?.close(); } catch {}
    }
    void resources.watcher?.close();
    this.onClosed();
  }
}
