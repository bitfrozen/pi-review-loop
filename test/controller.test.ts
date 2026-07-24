import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GlimpseWindow } from "glimpseui";
import { ReviewController, type ReviewControllerDependencies } from "../src/controller.js";
import { getReviewHtmlPath } from "../src/ui.js";
import type { RepositoryWatcher } from "../src/watcher.js";

const execFileAsync = promisify(execFile);

interface Notification {
  message: string;
  level: string;
}

function fakePi(): ExtensionAPI {
  return {
    async exec(command: string, args: string[], options?: { cwd?: string }) {
      try {
        const result = await execFileAsync(command, args, { cwd: options?.cwd, encoding: "utf8" });
        return { code: 0, stdout: result.stdout, stderr: result.stderr, killed: false };
      } catch (error) {
        const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
        return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, killed: false };
      }
    },
  } as ExtensionAPI;
}

function fakeContext(cwd: string, notifications: Notification[]): ExtensionCommandContext {
  return {
    cwd,
    mode: "tui",
    sessionManager: { getBranch: () => [] },
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      pasteToEditor: () => {},
    },
  } as unknown as ExtensionCommandContext;
}

async function createRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "review-loop-controller-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd });
  await writeFile(join(cwd, "app.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["add", "."], { cwd });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
  return cwd;
}

class FakeWindow extends EventEmitter {
  closeCalls = 0;
  loadedPaths: string[] = [];

  show(): void {}
  send(): void {}

  close(): void {
    this.closeCalls += 1;
  }

  loadFile(path: string): void {
    this.loadedPaths.push(path);
  }
}

function fakeWindowDependency(window: FakeWindow, onOpen?: (html: string) => void): NonNullable<ReviewControllerDependencies["openWindow"]> {
  return ((html: string) => {
    onOpen?.(html);
    return window as unknown as GlimpseWindow;
  }) as NonNullable<ReviewControllerDependencies["openWindow"]>;
}

test("controller does not open Glimpse when watcher startup fails", async () => {
  const cwd = await createRepo();
  try {
    const notifications: Notification[] = [];
    let openCalls = 0;
    const controller = new ReviewController(fakePi(), () => {}, {
      startWatcher: async () => { throw new Error("EMFILE: too many open files, watch"); },
      openWindow: fakeWindowDependency(new FakeWindow(), () => { openCalls += 1; }),
    });

    await assert.rejects(controller.openOrShow(fakeContext(cwd, notifications)), /EMFILE/);
    assert.equal(openCalls, 0);
    assert.equal(controller.isOpen, false);
    assert.deepEqual(notifications, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("controller loads the UI from disk and disposes a failed runtime watcher", async () => {
  const cwd = await createRepo();
  try {
    const notifications: Notification[] = [];
    const window = new FakeWindow();
    let closedControllers = 0;
    let watcherCloseCalls = 0;
    let runtimeError: ((error: Error) => void) | null = null;
    const repositoryWatcher = {
      on() { return this; },
      async close() { watcherCloseCalls += 1; },
    } as RepositoryWatcher;
    const controller = new ReviewController(fakePi(), () => { closedControllers += 1; }, {
      startWatcher: async (options) => {
        runtimeError = options.onError;
        return repositoryWatcher;
      },
      openWindow: fakeWindowDependency(window, (html) => assert.equal(html, "")),
    });

    await controller.openOrShow(fakeContext(cwd, notifications));
    assert.equal(controller.isOpen, true);
    window.emit("ready", {});
    assert.deepEqual(window.loadedPaths, [getReviewHtmlPath()]);

    assert.ok(runtimeError != null);
    (runtimeError as (error: Error) => void)(new Error("watch failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(controller.isOpen, false);
    assert.equal(window.closeCalls, 1);
    assert.equal(watcherCloseCalls, 1);
    assert.equal(closedControllers, 1);
    assert.ok(notifications.some(({ message, level }) => level === "error" && message === "Review Loop stopped watching files: watch failed"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
