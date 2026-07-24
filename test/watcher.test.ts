import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChokidarOptions, FSWatcher } from "chokidar";
import { getIgnoredDirectoryPaths, parseIgnoredDirectoryPaths } from "../src/git.js";
import { createIgnoredPathMatcher, startRepositoryWatcher, type RepositoryWatcher, type WatchFactory } from "../src/watcher.js";

const execFileAsync = promisify(execFile);

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

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

class FakeWatcher extends EventEmitter {
  closeCalls = 0;

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function fakeWatchFactory(watcher: FakeWatcher, capture?: (options: ChokidarOptions) => void): WatchFactory {
  return (_path, options) => {
    capture?.(options);
    return watcher as RepositoryWatcher;
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("parses NUL-delimited Git ignored directory output", () => {
  assert.deepEqual(parseIgnoredDirectoryPaths([
    ".venv/",
    "ignored-file.log",
    "tools/web/node_modules/",
    "space dir/",
    "./reports/",
    "tools/web/node_modules/",
    "",
  ].join("\0")), [".venv", "reports", "space dir", "tools/web/node_modules"]);
});

test("matches ignored directory descendants, Git metadata, and outside paths", () => {
  const repoRoot = join(tmpdir(), "review-loop-repo");
  const ignored = createIgnoredPathMatcher(repoRoot, [".venv", "tools/web/node_modules", "space dir"]);

  assert.equal(ignored(repoRoot), false);
  assert.equal(ignored(join(repoRoot, "src", "app.ts")), false);
  assert.equal(ignored(join(repoRoot, ".git", "objects", "pack")), true);
  assert.equal(ignored(join(repoRoot, "nested", ".git", "config")), true);
  assert.equal(ignored(join(repoRoot, ".venv")), true);
  assert.equal(ignored(join(repoRoot, ".venv", "lib", "module.py")), true);
  assert.equal(ignored(join(repoRoot, "tools", "web", "node_modules", "pkg", "index.js")), true);
  assert.equal(ignored(join(repoRoot, "tools", "web", "node_modules-old")), false);
  assert.equal(ignored(join(repoRoot, "space dir", "result.txt")), true);
  assert.equal(ignored(join(repoRoot, "..", "outside.txt")), true);
});

test("Git ignored discovery excludes ignored trees but preserves a tree containing tracked files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-loop-ignore-"));
  try {
    await git(cwd, "init", "-b", "main");
    await writeFile(join(cwd, ".gitignore"), ["target/", "**/node_modules/", "generated/", "*.log", ""].join("\n"));
    await mkdir(join(cwd, "target", "debug"), { recursive: true });
    await mkdir(join(cwd, "web", "node_modules", "package"), { recursive: true });
    await mkdir(join(cwd, "generated"), { recursive: true });
    await writeFile(join(cwd, "target", "debug", "app"), "binary");
    await writeFile(join(cwd, "web", "node_modules", "package", "index.js"), "generated");
    await writeFile(join(cwd, "generated", "tracked.txt"), "tracked\n");
    await writeFile(join(cwd, "generated", "cache.log"), "ignored\n");
    await git(cwd, "add", ".gitignore");
    await git(cwd, "add", "--force", "generated/tracked.txt");

    const ignoredDirectories = await getIgnoredDirectoryPaths(fakePi(), cwd);
    assert.ok(ignoredDirectories.includes("target"));
    assert.ok(ignoredDirectories.includes("web/node_modules"));
    assert.ok(!ignoredDirectories.includes("generated"), "a directory containing a tracked file must remain watched");

    const watcher = await startRepositoryWatcher({
      repoRoot: cwd,
      ignoredDirectories,
      onChange: () => {},
      onError: assert.fail,
    });
    try {
      const watchedDirectories = Object.keys((watcher as FSWatcher).getWatched());
      assert.ok(!watchedDirectories.some((path) => path === join(cwd, "target") || path.startsWith(`${join(cwd, "target")}${sep}`)));
      assert.ok(!watchedDirectories.some((path) => path === join(cwd, "web", "node_modules") || path.startsWith(`${join(cwd, "web", "node_modules")}${sep}`)));
      assert.ok(watchedDirectories.includes(join(cwd, "generated")), "the tracked directory remains watched");
    } finally {
      await watcher.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("watcher waits for ready and uses safe traversal options", async () => {
  const watcher = new FakeWatcher();
  let captured: ChokidarOptions | undefined;
  let changes = 0;
  const starting = startRepositoryWatcher({
    repoRoot: tmpdir(),
    ignoredDirectories: ["target"],
    onChange: () => { changes += 1; },
    onError: assert.fail,
    watchFactory: fakeWatchFactory(watcher, (options) => { captured = options; }),
  });

  watcher.emit("all", "change", join(tmpdir(), "before-ready.txt"));
  assert.equal(changes, 0);
  watcher.emit("ready");
  assert.equal(await starting, watcher);
  assert.equal(captured?.ignoreInitial, true);
  assert.equal(captured?.followSymlinks, false);
  assert.equal(typeof captured?.ignored, "function");

  watcher.emit("all", "change", join(tmpdir(), "after-ready.txt"));
  assert.equal(changes, 1);
  await watcher.close();
});

test("watcher startup errors reject cleanly and close once", async () => {
  const watcher = new FakeWatcher();
  let runtimeErrors = 0;
  const starting = startRepositoryWatcher({
    repoRoot: tmpdir(),
    ignoredDirectories: [],
    onChange: assert.fail,
    onError: () => { runtimeErrors += 1; },
    watchFactory: fakeWatchFactory(watcher),
  });

  watcher.emit("error", new Error("EMFILE: too many open files, watch"));
  await assert.rejects(starting, /EMFILE/);
  assert.equal(watcher.closeCalls, 1);
  assert.equal(runtimeErrors, 0);
});

test("runtime watcher errors are reported once and cannot escape the listener", async () => {
  const watcher = new FakeWatcher();
  const errors: Error[] = [];
  const starting = startRepositoryWatcher({
    repoRoot: tmpdir(),
    ignoredDirectories: [],
    onChange: assert.fail,
    onError: (error) => {
      errors.push(error);
      throw new Error("consumer callback failed");
    },
    watchFactory: fakeWatchFactory(watcher),
  });

  watcher.emit("ready");
  await starting;
  assert.doesNotThrow(() => watcher.emit("error", new Error("watch failed")));
  watcher.emit("error", new Error("duplicate failure"));
  await nextTurn();

  assert.deepEqual(errors.map((error) => error.message), ["watch failed"]);
  assert.equal(watcher.closeCalls, 1);
});
