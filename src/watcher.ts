import { isAbsolute, relative, sep } from "node:path";
import { watch, type ChokidarOptions } from "chokidar";

export interface RepositoryWatcher {
  on(event: "ready", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "all", listener: (event: string, path: string) => void): this;
  close(): Promise<void>;
}

export type WatchFactory = (path: string, options: ChokidarOptions) => RepositoryWatcher;

interface StartRepositoryWatcherOptions {
  repoRoot: string;
  ignoredDirectories: string[];
  onChange: (path: string) => void;
  onError: (error: Error) => void;
  watchFactory?: WatchFactory;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function canonicalRepoPath(path: string): string {
  return path.split(sep).join("/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
}

function isOutsideRepo(path: string): boolean {
  return path === ".." || path.startsWith("../");
}

export function createIgnoredPathMatcher(repoRoot: string, ignoredDirectories: string[]): (path: string) => boolean {
  const ignored = new Set(ignoredDirectories.map(canonicalRepoPath).filter((path) => path && !isOutsideRepo(path)));

  return (path: string): boolean => {
    const relativePath = isAbsolute(path) ? relative(repoRoot, path) : path;
    if (isAbsolute(relativePath)) return true;
    const repoPath = canonicalRepoPath(relativePath);
    if (!repoPath || repoPath === ".") return false;
    if (isOutsideRepo(repoPath)) return true;

    const parts = repoPath.split("/");
    if (parts.includes(".git")) return true;

    let candidate = repoPath;
    while (candidate) {
      if (ignored.has(candidate)) return true;
      const separator = candidate.lastIndexOf("/");
      if (separator < 0) break;
      candidate = candidate.slice(0, separator);
    }
    return false;
  };
}

async function closeSafely(watcher: RepositoryWatcher): Promise<void> {
  try {
    await watcher.close();
  } catch {
    // The original watcher failure is more useful than a secondary close error.
  }
}

export async function startRepositoryWatcher(options: StartRepositoryWatcherOptions): Promise<RepositoryWatcher> {
  const watchFactory = options.watchFactory ?? ((path, watchOptions) => watch(path, watchOptions) as RepositoryWatcher);
  const watcher = watchFactory(options.repoRoot, {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: createIgnoredPathMatcher(options.repoRoot, options.ignoredDirectories),
  });

  let ready = false;
  let failed = false;

  const readyPromise = new Promise<void>((resolve, reject) => {
    const fail = (value: unknown): void => {
      if (failed) return;
      failed = true;
      const error = asError(value);
      if (!ready) {
        reject(error);
        return;
      }
      void closeSafely(watcher);
      try {
        options.onError(error);
      } catch {
        // A consumer error must not become another unhandled watcher error.
      }
    };

    watcher.on("error", fail);
    watcher.on("all", (_event, path) => {
      if (!ready || failed) return;
      try {
        options.onChange(path);
      } catch (error) {
        fail(error);
      }
    });
    watcher.on("ready", () => {
      if (failed) return;
      ready = true;
      resolve();
    });
  });

  try {
    await readyPromise;
    return watcher;
  } catch (error) {
    await closeSafely(watcher);
    throw error;
  }
}
