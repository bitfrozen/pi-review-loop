import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/go/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/java/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/kotlin/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/rust/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
import { sameReviewTarget } from "../../src/review-comments.js";
import type { ChangedFile, FileCommentAnchor, FileContents, HostMessage, LineCommentAnchor, RangeCommentAnchor, ReviewComment, ReviewMode, WorkspaceState } from "../../src/types.js";
import { appearance, applyAppearance } from "./appearance.js";

declare global {
  interface Window {
    glimpse?: { send(message: unknown): void };
    __reviewReceive(message: HostMessage): void;
    __reviewWorkerSource: string;
    MonacoEnvironment: { getWorker(): Worker };
  }
}

applyAppearance();

let workerUrl: string | null = null;
window.MonacoEnvironment = {
  getWorker: () => {
    workerUrl ??= URL.createObjectURL(new Blob([window.__reviewWorkerSource], { type: "text/javascript" }));
    return new Worker(workerUrl);
  },
};

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element == null) throw new Error(`Missing #${id}`);
  return element as T;
};

const repoNameEl = byId("repo-name");
const repoMetaEl = byId("repo-meta");
const checkpointButton = byId<HTMLButtonElement>("mode-checkpoint");
const headButton = byId<HTMLButtonElement>("mode-head");
const submitButton = byId<HTMLButtonElement>("submit-review");
const searchInput = byId<HTMLInputElement>("search");
const recentCountEl = byId("recent-count");
const fileCountEl = byId("file-count");
const recentListEl = byId("recent-list");
const fileTreeEl = byId("file-tree");
const filePathEl = byId("file-path");
const fileStatusEl = byId("file-status");
const lineWrapButton = byId<HTMLButtonElement>("line-wrap");
const fileCommentButton = byId<HTMLButtonElement>("file-comment");
const emptyStateEl = byId("empty-state");
const editorEl = byId("editor");
const feedbackPanelEl = byId("feedback-panel");
const feedbackTitleEl = byId("feedback-title");
const commentListEl = byId("comment-list");
const fileCommentEditorEl = byId("file-comment-editor");
const fileCommentLocationEl = byId("file-comment-location");
const fileCommentInput = byId<HTMLTextAreaElement>("file-comment-input");
const deleteFileCommentButton = byId<HTMLButtonElement>("delete-file-comment");
const toastEl = byId("toast");

let workspace: WorkspaceState | null = null;
let activePath: string | null = null;
let mountedFingerprint = "";
let mountedPath: string | null = null;
let mountedMode: ReviewMode | null = null;
const scrollPositions = new Map<string, ScrollPosition>();
let activeRequestId = "";
let requestCounter = 0;
type InlineCommentSide = "original" | "modified";
type InlineReviewComment = ReviewComment & {
  side: InlineCommentSide;
  anchor: LineCommentAnchor | RangeCommentAnchor;
};
type FileReviewComment = ReviewComment & {
  side: "file";
  anchor: FileCommentAnchor;
};
type UiComment = ReviewComment & { id: string };
type UiInlineComment = UiComment & InlineReviewComment;
type UiFileComment = UiComment & FileReviewComment;
interface MountedCommentWidget {
  editor: monaco.editor.ICodeEditor;
  widget: monaco.editor.IContentWidget;
  kind: "icon" | "editor";
  domNode: HTMLElement;
}
interface MountedSelectionWidget {
  editor: monaco.editor.ICodeEditor;
  widget: monaco.editor.IContentWidget;
}
interface ActiveTextSelection {
  path: string;
  mode: ReviewMode;
  side: InlineCommentSide;
  anchor: RangeCommentAnchor;
}
interface ScrollPosition {
  originalTop: number;
  originalLeft: number;
  modifiedTop: number;
  modifiedLeft: number;
}

let comments: UiComment[] = [];
let activeCommentId: string | null = null;
let activeTextSelection: ActiveTextSelection | null = null;
let mountedSelectionWidget: MountedSelectionWidget | null = null;
let mountedCommentWidgets: MountedCommentWidget[] = [];
let commentWidgetGeneration = 0;
let paddedCommentSide: InlineCommentSide | null = null;
let pendingOpenPath: string | null = null;
let toastTimer = 0;
let readyTimer = 0;
const collapsedDirs = new Set<string>();

const monacoToken = (color: string): string => color.replace(/^#/, "");
const editorColors = appearance.colors.editor;
const syntaxColors = appearance.colors.syntax;

monaco.editor.defineTheme("review-loop", {
  base: appearance.mode === "dark" ? "vs-dark" : "vs",
  inherit: true,
  rules: [
    { token: "", foreground: monacoToken(syntaxColors.foreground) },
    { token: "comment", foreground: monacoToken(syntaxColors.comment) },
    { token: "keyword", foreground: monacoToken(syntaxColors.keyword) },
    { token: "string", foreground: monacoToken(syntaxColors.string) },
    { token: "number", foreground: monacoToken(syntaxColors.number) },
    { token: "type", foreground: monacoToken(syntaxColors.type) },
    { token: "type.identifier", foreground: monacoToken(syntaxColors.type) },
    { token: "function", foreground: monacoToken(syntaxColors.function) },
    { token: "identifier", foreground: monacoToken(syntaxColors.variable) },
    { token: "operator", foreground: monacoToken(syntaxColors.operator) },
    { token: "delimiter", foreground: monacoToken(syntaxColors.punctuation) },
  ],
  colors: {
    "editor.background": editorColors.background,
    "editor.foreground": editorColors.foreground,
    "editorGutter.background": editorColors.gutterBackground,
    "editorLineNumber.foreground": editorColors.lineNumber,
    "editorLineNumber.activeForeground": editorColors.activeLineNumber,
    "editor.selectionBackground": editorColors.selectionBackground,
    "editor.lineHighlightBackground": editorColors.lineHighlightBackground,
    "diffEditor.insertedTextBackground": editorColors.insertedTextBackground,
    "diffEditor.removedTextBackground": editorColors.removedTextBackground,
    "diffEditor.insertedLineBackground": editorColors.insertedLineBackground,
    "diffEditor.removedLineBackground": editorColors.removedLineBackground,
    "diffEditor.diagonalFill": editorColors.diagonalFill,
    "scrollbarSlider.background": editorColors.scrollbarSlider,
    "scrollbarSlider.hoverBackground": editorColors.scrollbarSliderHover,
    "editorOverviewRuler.border": editorColors.overviewRulerBorder,
  },
});
monaco.editor.setTheme("review-loop");

const COMMENT_EDITOR_HEIGHT = 128;
const DEFAULT_EDITOR_PADDING = 8;
const ACTIVE_EDITOR_BOTTOM_PADDING = COMMENT_EDITOR_HEIGHT + 16;

const diffEditor = monaco.editor.createDiffEditor(editorEl, {
  readOnly: true,
  originalEditable: false,
  automaticLayout: true,
  renderSideBySide: true,
  enableSplitViewResizing: true,
  minimap: { enabled: true, renderCharacters: false, showSlider: "always", size: "proportional" },
  glyphMargin: true,
  folding: true,
  lineNumbersMinChars: 3,
  lineDecorationsWidth: 8,
  scrollBeyondLastLine: false,
  renderOverviewRuler: true,
  overviewRulerLanes: 3,
  overviewRulerBorder: false,
  wordWrap: "off",
  diffWordWrap: "off",
  hideUnchangedRegions: { enabled: false },
  padding: { top: DEFAULT_EDITOR_PADDING, bottom: DEFAULT_EDITOR_PADDING },
  fontFamily: appearance.typography.codeFontFamily,
  fontSize: appearance.typography.editorFontSize,
  lineHeight: appearance.typography.editorLineHeight,
});

let originalModel: monaco.editor.ITextModel | null = null;
let modifiedModel: monaco.editor.ITextModel | null = null;
let originalDecorations: string[] = [];
let modifiedDecorations: string[] = [];

function send(message: unknown): void {
  window.glimpse?.send(message);
}

function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.add("visible");
  toastTimer = window.setTimeout(() => toastEl.classList.remove("visible"), 2200);
}

function statusLetter(status: ChangedFile["status"]): string {
  return status === "modified" ? "M" : status === "added" ? "A" : "D";
}

function statusSpan(file: ChangedFile): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = `status ${file.status}`;
  span.textContent = statusLetter(file.status);
  return span;
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

function parent(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function relativeTime(value?: number): string {
  if (!value) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function matches(file: ChangedFile): boolean {
  const query = searchInput.value.trim().toLowerCase();
  return !query || file.path.toLowerCase().includes(query);
}

function scrollKey(path: string, mode: ReviewMode): string {
  return `${mode}:${path}`;
}

function saveMountedScroll(): void {
  if (mountedPath == null || mountedMode == null || originalModel == null || modifiedModel == null) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  scrollPositions.set(scrollKey(mountedPath, mountedMode), {
    originalTop: originalEditor.getScrollTop(),
    originalLeft: originalEditor.getScrollLeft(),
    modifiedTop: modifiedEditor.getScrollTop(),
    modifiedLeft: modifiedEditor.getScrollLeft(),
  });
}

function restoreScroll(path: string, mode: ReviewMode): void {
  const position = scrollPositions.get(scrollKey(path, mode)) ?? {
    originalTop: 0,
    originalLeft: 0,
    modifiedTop: 0,
    modifiedLeft: 0,
  };
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  originalEditor.setScrollPosition({ scrollTop: position.originalTop, scrollLeft: position.originalLeft });
  modifiedEditor.setScrollPosition({ scrollTop: position.modifiedTop, scrollLeft: position.modifiedLeft });
}

function selectPath(path: string, preferCheckpoint = false): void {
  if (workspace == null) return;
  const inCurrentMode = workspace.files.some((file) => file.path === path);
  if (!inCurrentMode && preferCheckpoint && workspace.mode !== "checkpoint") {
    saveMountedScroll();
    pendingOpenPath = path;
    send({ type: "set-mode", mode: "checkpoint" });
    return;
  }
  if (!inCurrentMode) return;
  saveMountedScroll();
  settleActiveComment();
  dismissTextSelection();
  clearCommentWidgets();
  activePath = path;
  mountedFingerprint = "";
  render();
  requestActiveFile();
}

function makeCommentId(): string {
  return `comment:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function isPendingReview(path: string): boolean {
  return workspace?.pendingFiles.some((file) => file.path === path) ?? false;
}

function commentCount(path: string): number {
  return comments.filter((comment) => comment.path === path).length;
}

function commentBadge(path: string): HTMLSpanElement | null {
  const count = commentCount(path);
  if (count === 0) return null;
  const badge = document.createElement("span");
  badge.className = "comment-count";
  badge.textContent = String(count);
  badge.title = `${count} review comment${count === 1 ? "" : "s"}`;
  return badge;
}

function makeRecentRow(file: ChangedFile): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = `file-row${file.path === activePath ? " active" : ""}`;
  button.append(statusSpan(file));
  const copy = document.createElement("span");
  copy.className = "copy";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = basename(file.path);
  const pathParent = document.createElement("span");
  pathParent.className = "parent";
  pathParent.textContent = parent(file.path);
  copy.append(name, pathParent);
  const time = document.createElement("time");
  time.textContent = relativeTime(file.recentAt);
  button.append(copy);
  const badge = commentBadge(file.path);
  if (badge) button.append(badge);
  if (workspace?.mode === "head" && !isPendingReview(file.path)) {
    const reviewed = document.createElement("span");
    reviewed.className = "reviewed-check";
    reviewed.textContent = "✓";
    reviewed.title = "Matches the last reviewed checkpoint";
    button.append(reviewed);
  }
  button.append(time);
  button.addEventListener("click", () => selectPath(file.path, true));
  return button;
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file?: ChangedFile;
}

function buildTree(files: ChangedFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const file of files) {
    let node = root;
    let path = "";
    const parts = file.path.split("/");
    parts.forEach((name, index) => {
      path = path ? `${path}/${name}` : name;
      let child = node.children.get(name);
      if (child == null) {
        child = { name, path, children: new Map() };
        node.children.set(name, child);
      }
      if (index === parts.length - 1) child.file = file;
      node = child;
    });
  }
  return root;
}

function appendTree(node: TreeNode, depth: number): void {
  const children = [...node.children.values()].sort((a, b) => {
    if (!!a.file !== !!b.file) return a.file ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  for (const child of children) {
    if (child.file) {
      const row = document.createElement("button");
      row.className = `tree-row${child.file.path === activePath ? " active" : ""}`;
      row.style.paddingLeft = `${8 + depth * 12}px`;
      row.append(statusSpan(child.file));
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = child.name;
      row.append(label);
      const badge = commentBadge(child.file.path);
      if (badge) row.append(badge);
      if (isPendingReview(child.file.path)) {
        const dot = document.createElement("span");
        dot.className = "recent-dot";
        dot.title = "Changed since the last review";
        row.append(dot);
      } else if (workspace?.mode === "head") {
        const reviewed = document.createElement("span");
        reviewed.className = "reviewed-check";
        reviewed.textContent = "✓";
        reviewed.title = "Matches the last reviewed checkpoint";
        row.append(reviewed);
      }
      row.addEventListener("click", () => selectPath(child.file!.path));
      fileTreeEl.append(row);
      continue;
    }

    const collapsed = collapsedDirs.has(child.path);
    const row = document.createElement("button");
    row.className = "tree-row directory";
    row.style.paddingLeft = `${8 + depth * 12}px`;
    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.textContent = collapsed ? "▶" : "▼";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = child.name;
    row.append(chevron, label);
    row.addEventListener("click", () => {
      collapsed ? collapsedDirs.delete(child.path) : collapsedDirs.add(child.path);
      renderTree();
    });
    fileTreeEl.append(row);
    if (!collapsed) appendTree(child, depth + 1);
  }
}

function renderRecent(): void {
  if (workspace == null) return;
  recentListEl.replaceChildren();
  const activeFiles = new Map(workspace.files.map((file) => [file.path, file]));
  const files = workspace.recentPaths.map((path) => activeFiles.get(path)).filter((file): file is ChangedFile => file != null).filter(matches);
  recentCountEl.textContent = files.length ? String(files.length) : "";
  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = workspace.files.length ? "No recent matches" : workspace.mode === "checkpoint" ? "No new changes" : "Working tree is clean";
    recentListEl.append(empty);
    return;
  }
  files.forEach((file) => recentListEl.append(makeRecentRow(file)));
}

function renderTree(): void {
  if (workspace == null) return;
  fileTreeEl.replaceChildren();
  const files = workspace.files.filter(matches);
  fileCountEl.textContent = String(files.length);
  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = searchInput.value ? "No matching files" : workspace.mode === "checkpoint" ? "Nothing since the last review" : "Working tree is clean";
    fileTreeEl.append(empty);
    return;
  }
  appendTree(buildTree(files), 0);
}

function updateSubmitButton(): void {
  const count = workspace?.pendingFiles.length ?? 0;
  const commentCount = comments.filter((comment) => comment.body.trim().length > 0).length;
  submitButton.disabled = count === 0 && commentCount === 0;
  if (commentCount > 0) submitButton.textContent = `Submit ${commentCount} comment${commentCount === 1 ? "" : "s"} · review ${count}`;
  else if (count > 0) submitButton.textContent = `Mark ${count} reviewed`;
  else submitButton.textContent = "Mark reviewed";
}

function updateHeader(): void {
  if (workspace == null) return;
  repoNameEl.textContent = workspace.repoName;
  const baseline = workspace.hasCheckpoint && workspace.checkpointCreatedAt
    ? `reviewed ${relativeTime(workspace.checkpointCreatedAt)} ago`
    : "not reviewed yet";
  repoMetaEl.textContent = [workspace.branch, baseline].filter(Boolean).join(" · ");
  checkpointButton.classList.toggle("active", workspace.mode === "checkpoint");
  headButton.classList.toggle("active", workspace.mode === "head");
}

function activeFile(): ChangedFile | null {
  return workspace?.files.find((file) => file.path === activePath) ?? null;
}

function renderFilebar(): void {
  const file = activeFile();
  fileStatusEl.className = file ? `status ${file.status}` : "status";
  fileStatusEl.textContent = file ? statusLetter(file.status) : "";
  filePathEl.textContent = file?.path ?? "No changes to review";
  lineWrapButton.disabled = file == null;
  fileCommentButton.disabled = file == null;
}

function render(): void {
  if (workspace == null) return;
  updateHeader();
  renderRecent();
  renderTree();
  renderFilebar();
  updateSubmitButton();

  const file = activeFile();
  emptyStateEl.classList.toggle("hidden", file != null);
  editorEl.classList.toggle("hidden", file == null);
  if (file == null) disposeModels();
  renderFeedback();
}

function inferLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return ({
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", css: "css", html: "html", htm: "html", md: "markdown", py: "python", rs: "rust",
    go: "go", java: "java", kt: "kotlin", sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml",
  } as Record<string, string>)[ext ?? ""] ?? "plaintext";
}

function clearSelectionCommentWidget(): void {
  if (mountedSelectionWidget == null) return;
  mountedSelectionWidget.editor.removeContentWidget(mountedSelectionWidget.widget);
  mountedSelectionWidget = null;
}

function dismissTextSelection(): void {
  activeTextSelection = null;
  clearSelectionCommentWidget();
}

function clearCommentWidgets(): void {
  if (mountedCommentWidgets.length === 0) return;
  for (const mounted of mountedCommentWidgets) mounted.editor.removeContentWidget(mounted.widget);
  mountedCommentWidgets = [];
}

function disposeModels(): void {
  saveMountedScroll();
  dismissTextSelection();
  clearCommentWidgets();
  diffEditor.setModel(null);
  originalModel?.dispose();
  modifiedModel?.dispose();
  originalModel = null;
  modifiedModel = null;
  mountedFingerprint = "";
  mountedPath = null;
  mountedMode = null;
}

function mountFile(file: FileContents): void {
  if (file.path !== activePath || workspace?.mode !== file.mode) return;
  disposeModels();
  const language = inferLanguage(file.path);
  originalModel = monaco.editor.createModel(file.originalContent, language);
  modifiedModel = monaco.editor.createModel(file.modifiedContent, language);
  diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  mountedFingerprint = file.fingerprint;
  mountedPath = file.path;
  mountedMode = file.mode;
  syncInlineComments();
  requestAnimationFrame(() => {
    restoreScroll(file.path, file.mode);
    setTimeout(() => restoreScroll(file.path, file.mode), 30);
  });
}

function requestActiveFile(): void {
  const file = activeFile();
  if (file == null || file.fingerprint === mountedFingerprint) return;
  activeRequestId = `file:${++requestCounter}`;
  send({ type: "request-file", requestId: activeRequestId, path: file.path, mode: workspace!.mode });
}

function commentSideLabel(comment: ReviewComment): string {
  if (comment.side === "modified") return "Current";
  return comment.mode === "head" ? "HEAD" : "Reviewed";
}

function commentLocation(comment: ReviewComment): string {
  if (comment.anchor.kind === "file") return comment.path;
  const side = commentSideLabel(comment).toLowerCase();
  if (comment.anchor.kind === "line") return `${comment.path}:${comment.anchor.line} ${side}`;
  const anchor = comment.anchor;
  return `${comment.path}:${anchor.startLine}:${anchor.startColumn}–${anchor.endLine}:${anchor.endColumn} ${side}`;
}

function removeComment(id: string): void {
  if (activeCommentId === id) activeCommentId = null;
  comments = comments.filter((comment) => comment.id !== id);
  renderFeedback();
  renderRecent();
  renderTree();
  updateSubmitButton();
  syncInlineComments();
}

function isFileComment(comment: ReviewComment): comment is FileReviewComment {
  return comment.side === "file" && comment.anchor.kind === "file";
}

function currentFileComments(): UiFileComment[] {
  if (activePath == null || workspace == null) return [];
  const path = activePath;
  const mode = workspace.mode;
  return comments.filter((comment): comment is UiFileComment =>
    comment.path === path
    && comment.mode === mode
    && isFileComment(comment),
  );
}

function activeFileComment(): UiFileComment | undefined {
  return currentFileComments().find((comment) => comment.id === activeCommentId);
}

function renderFeedback(): void {
  const fileComments = currentFileComments();
  const active = fileComments.find((comment) => comment.id === activeCommentId);
  feedbackPanelEl.classList.toggle("hidden", fileComments.length === 0);
  feedbackTitleEl.textContent = fileComments.length ? `File notes · ${fileComments.length}` : "File note";
  commentListEl.replaceChildren();
  const activeIndex = active ? fileComments.indexOf(active) : -1;
  fileCommentEditorEl.classList.toggle("hidden", active == null);
  fileCommentEditorEl.classList.toggle("first", activeIndex === 0);
  fileCommentEditorEl.style.order = String(activeIndex);
  if (active) {
    fileCommentLocationEl.textContent = commentLocation(active);
    if (fileCommentInput.dataset.commentId !== active.id || fileCommentInput.value !== active.body) {
      fileCommentInput.value = active.body;
    }
    fileCommentInput.dataset.commentId = active.id;
  } else {
    delete fileCommentInput.dataset.commentId;
    fileCommentInput.value = "";
  }

  fileComments.forEach((comment, index) => {
    if (comment.id === active?.id) return;
    const row = document.createElement("div");
    row.className = `comment editable${index === 0 ? " first" : ""}`;
    row.style.order = String(index);
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.title = "Edit file note";
    const location = document.createElement("div");
    location.className = "comment-location";
    location.textContent = commentLocation(comment);
    location.title = commentLocation(comment);
    const body = document.createElement("div");
    body.className = "comment-body";
    body.textContent = comment.body;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Delete note";
    remove.setAttribute("aria-label", `Delete file note for ${comment.path}`);
    remove.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeComment(comment.id);
    });
    row.append(location, body, remove);
    row.addEventListener("click", () => activateFileComment(comment.id));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activateFileComment(comment.id);
    });
    commentListEl.append(row);
  });
}

function activateFileComment(id: string): void {
  if (activeCommentId !== id) settleActiveComment();
  const comment = comments.find((candidate): candidate is UiFileComment => candidate.id === id && isFileComment(candidate));
  if (!comment) return;
  dismissTextSelection();
  activeCommentId = id;
  renderFeedback();
  renderRecent();
  renderTree();
  updateSubmitButton();
  syncInlineComments();
  requestAnimationFrame(() => {
    if (activeCommentId === id) fileCommentInput.focus();
  });
}

function openFileComment(): void {
  if (activePath == null || workspace == null) return;
  const comment: UiFileComment = {
    id: makeCommentId(),
    path: activePath,
    mode: workspace.mode,
    side: "file",
    anchor: { kind: "file" },
    body: "",
  };
  comments.push(comment);
  activateFileComment(comment.id);
}

function collapseFileComment(id: string): void {
  if (activeCommentId !== id) return;
  settleActiveComment();
  renderFeedback();
  renderRecent();
  renderTree();
  updateSubmitButton();
  syncInlineComments();
}

function isInlineComment(comment: ReviewComment): comment is InlineReviewComment {
  return comment.side !== "file" && comment.anchor.kind !== "file";
}

function currentInlineComments(): UiInlineComment[] {
  if (activePath == null || workspace == null) return [];
  const path = activePath;
  const mode = workspace.mode;
  return comments.filter((comment): comment is UiInlineComment =>
    comment.path === path
    && comment.mode === mode
    && isInlineComment(comment),
  );
}

function activeInlineComment(): UiInlineComment | undefined {
  return currentInlineComments().find((comment) => comment.id === activeCommentId);
}

function commentStartLine(comment: InlineReviewComment): number {
  if (comment.anchor.kind === "line") return comment.anchor.line;
  return comment.anchor.startLine;
}

function commentEditorLine(comment: InlineReviewComment): number {
  if (comment.anchor.kind === "line") return comment.anchor.line;
  return comment.anchor.endLine;
}

function commentEditorPosition(comment: InlineReviewComment, model: monaco.editor.ITextModel): monaco.Position {
  if (comment.anchor.kind === "range") {
    return model.validatePosition({ lineNumber: comment.anchor.endLine, column: comment.anchor.endColumn });
  }
  const line = Math.min(comment.anchor.line, model.getLineCount());
  return new monaco.Position(line, model.getLineMaxColumn(line));
}

function commentEditorTitle(comment: InlineReviewComment): string {
  if (comment.anchor.kind === "line") return `${commentSideLabel(comment)} line ${comment.anchor.line}`;
  const anchor = comment.anchor;
  return `${commentSideLabel(comment)} ${anchor.startLine}:${anchor.startColumn}–${anchor.endLine}:${anchor.endColumn}`;
}

function decorationsFor(side: InlineCommentSide, model: monaco.editor.ITextModel): monaco.editor.IModelDeltaDecoration[] {
  const inlineComments = currentInlineComments();
  const active = inlineComments.find((comment) => comment.id === activeCommentId);
  return inlineComments
    .filter((comment) => comment.side === side)
    .map((comment) => {
      if (comment.anchor.kind === "line") {
        const line = Math.min(comment.anchor.line, model.getLineCount());
        const markerHidden = active?.side === side && commentEditorLine(active) === line;
        return {
          range: new monaco.Range(line, 1, line, 1),
          options: {
            isWholeLine: true,
            className: "review-comment-line",
            glyphMarginClassName: markerHidden ? undefined : "codicon codicon-comment review-comment-glyph",
          },
        };
      }
      const anchor = comment.anchor;
      return {
        range: model.validateRange(new monaco.Range(anchor.startLine, anchor.startColumn, anchor.endLine, anchor.endColumn)),
        options: { inlineClassName: "review-comment-range" },
      };
    });
}

function renderDecorations(): void {
  if (originalModel) originalDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalDecorations, decorationsFor("original", originalModel));
  if (modifiedModel) modifiedDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedDecorations, decorationsFor("modified", modifiedModel));
}

function sizeInlineComment(container: HTMLElement, editor: monaco.editor.ICodeEditor): void {
  const width = editor.getLayoutInfo().contentWidth;
  container.style.width = `${width}px`;
  container.style.maxWidth = `${width}px`;
}

function updateCommentEditorPadding(): void {
  const nextSide = activeInlineComment()?.side ?? null;
  if (nextSide === paddedCommentSide) return;
  paddedCommentSide = nextSide;

  const originalBottom = nextSide === "original" ? ACTIVE_EDITOR_BOTTOM_PADDING : DEFAULT_EDITOR_PADDING;
  const modifiedBottom = nextSide === "modified" ? ACTIVE_EDITOR_BOTTOM_PADDING : DEFAULT_EDITOR_PADDING;
  diffEditor.getOriginalEditor().updateOptions({
    padding: { top: DEFAULT_EDITOR_PADDING, bottom: originalBottom },
  });
  diffEditor.getModifiedEditor().updateOptions({
    padding: { top: DEFAULT_EDITOR_PADDING, bottom: modifiedBottom },
  });
}

function settleActiveComment(): void {
  if (activeCommentId == null) return;
  const active = comments.find((comment) => comment.id === activeCommentId);
  activeCommentId = null;
  if (active && active.body.trim().length === 0) {
    comments = comments.filter((comment) => comment.id !== active.id);
  }
  updateCommentEditorPadding();
}

function collapseInlineComment(id: string): void {
  if (activeCommentId !== id) return;
  settleActiveComment();
  renderRecent();
  renderTree();
  updateSubmitButton();
  syncInlineComments();
}

function editorForComment(comment: InlineReviewComment): monaco.editor.ICodeEditor {
  return comment.side === "original" ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();
}

function revealCommentEditor(comment: InlineReviewComment): void {
  const editor = editorForComment(comment);
  const model = editor.getModel();
  if (!model) return;
  const position = commentEditorPosition(comment, model);
  const positionTop = editor.getTopForPosition(position.lineNumber, position.column);
  const positionBottom = positionTop + editor.getLineHeightForPosition(position);
  const scrollTop = editor.getScrollTop();
  const viewportHeight = editor.getLayoutInfo().height;
  const editorMargin = DEFAULT_EDITOR_PADDING;
  const requiredBottom = positionBottom + COMMENT_EDITOR_HEIGHT + editorMargin;

  if (positionTop < scrollTop + editorMargin) {
    editor.setScrollTop(Math.max(0, positionTop - editorMargin), monaco.editor.ScrollType.Immediate);
  } else if (requiredBottom > scrollTop + viewportHeight) {
    editor.setScrollTop(requiredBottom - viewportHeight, monaco.editor.ScrollType.Immediate);
  }
}

function activateInlineComment(id: string): void {
  if (activeCommentId !== id) settleActiveComment();
  const comment = comments.find((candidate) => candidate.id === id);
  if (!comment || !isInlineComment(comment)) return;
  dismissTextSelection();
  activeCommentId = id;
  renderRecent();
  renderTree();
  updateSubmitButton();
  updateCommentEditorPadding();
  revealCommentEditor(comment);
  syncInlineComments();
}

function inlineCommentElement(comment: UiInlineComment, editor: monaco.editor.ICodeEditor, generation: number): HTMLElement {
  const container = document.createElement("div");
  container.className = "inline-comment";
  container.tabIndex = -1;
  sizeInlineComment(container, editor);

  const header = document.createElement("div");
  header.className = "inline-comment-header";
  const title = document.createElement("strong");
  title.textContent = commentEditorTitle(comment);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Delete";
  remove.addEventListener("click", () => removeComment(comment.id));
  header.append(title, remove);

  const textarea = document.createElement("textarea");
  textarea.dataset.commentId = comment.id;
  textarea.rows = 3;
  textarea.placeholder = "Leave actionable feedback…";
  textarea.spellcheck = false;
  textarea.setAttribute("autocorrect", "off");
  textarea.autocapitalize = "off";
  textarea.value = comment.body;
  textarea.addEventListener("input", () => {
    comment.body = textarea.value;
    updateSubmitButton();
  });
  textarea.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      textarea.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      textarea.blur();
    }
  });
  container.addEventListener("mousedown", (event) => {
    event.stopPropagation();
    if (!(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      textarea.focus();
    }
  });
  container.addEventListener("focusout", () => {
    window.setTimeout(() => {
      if (generation !== commentWidgetGeneration || activeCommentId !== comment.id || container.contains(document.activeElement)) return;
      collapseInlineComment(comment.id);
    }, 0);
  });
  container.append(header, textarea);
  window.setTimeout(() => {
    if (generation === commentWidgetGeneration && activeCommentId === comment.id) textarea.focus();
  }, 20);
  return container;
}

function commentIconElement(comment: UiInlineComment): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "review-comment-icon range-comment-icon";
  button.title = `Edit comment · ${commentEditorTitle(comment)}`;
  button.setAttribute("aria-label", button.title);
  button.addEventListener("mousedown", (event) => event.stopPropagation());
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    activateInlineComment(comment.id);
  });
  return button;
}

function mountCommentWidget(
  editor: monaco.editor.ICodeEditor,
  comment: UiInlineComment,
  kind: "icon" | "editor",
  generation: number,
): void {
  const model = editor.getModel();
  if (!model) return;

  const expanded = kind === "editor";
  let domNode: HTMLElement;
  let position: monaco.Position;
  let preference: monaco.editor.ContentWidgetPositionPreference[];

  if (expanded) {
    domNode = inlineCommentElement(comment, editor, generation);
    position = commentEditorPosition(comment, model);
    preference = [monaco.editor.ContentWidgetPositionPreference.BELOW];
  } else {
    domNode = commentIconElement(comment);
    if (comment.anchor.kind === "range") {
      position = model.validatePosition({
        lineNumber: comment.anchor.startLine,
        column: comment.anchor.startColumn,
      });
      preference = [
        monaco.editor.ContentWidgetPositionPreference.ABOVE,
        monaco.editor.ContentWidgetPositionPreference.EXACT,
      ];
    } else {
      position = model.validatePosition({ lineNumber: commentStartLine(comment), column: 1 });
      preference = [monaco.editor.ContentWidgetPositionPreference.EXACT];
    }
  }

  const widget: monaco.editor.IContentWidget = {
    allowEditorOverflow: false,
    getId: () => `review-comment:${comment.id}:${kind}:${generation}`,
    getDomNode: () => domNode,
    getPosition: () => ({ position, preference }),
    beforeRender: () => {
      if (expanded) {
        sizeInlineComment(domNode, editor);
        return { width: editor.getLayoutInfo().contentWidth, height: COMMENT_EDITOR_HEIGHT };
      }
      return { width: 18, height: 18 };
    },
  };
  editor.addContentWidget(widget);
  mountedCommentWidgets.push({ editor, widget, kind, domNode });
}

function syncInlineComments(): void {
  commentWidgetGeneration += 1;
  const generation = commentWidgetGeneration;
  clearCommentWidgets();
  updateCommentEditorPadding();
  if (!originalModel || !modifiedModel) return;

  const inlineComments = currentInlineComments();
  const active = inlineComments.find((comment) => comment.id === activeCommentId);
  const activeLine = active ? commentEditorLine(active) : null;

  for (const comment of inlineComments) {
    if (comment.id === activeCommentId || comment.anchor.kind === "line") continue;
    if (active && comment.side === active.side && commentStartLine(comment) === activeLine) continue;
    mountCommentWidget(editorForComment(comment), comment, "icon", generation);
  }
  if (active) mountCommentWidget(editorForComment(active), active, "editor", generation);
  renderDecorations();
}

function addCommentAtTarget(target: Omit<InlineReviewComment, "body">): void {
  const candidate: InlineReviewComment = { ...target, body: "" };
  const existing = comments.find((comment) => sameReviewTarget(comment, candidate));
  if (existing) {
    activateInlineComment(existing.id);
    return;
  }
  const comment: UiInlineComment = { ...candidate, id: makeCommentId() };
  comments.push(comment);
  activateInlineComment(comment.id);
}

function addInlineComment(side: InlineCommentSide, line: number): void {
  if (activePath == null || workspace == null) return;
  addCommentAtTarget({ path: activePath, mode: workspace.mode, side, anchor: { kind: "line", line } });
}

function currentTextSelection(): ActiveTextSelection | null {
  const selection = activeTextSelection;
  if (selection == null) return null;
  if (selection.path !== activePath || selection.mode !== workspace?.mode) return null;
  return selection;
}

function createSelectionCommentButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "selection-comment-popover";
  button.textContent = "Add comment";
  button.setAttribute("aria-label", "Add a comment to the selected text");
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    addSelectionComment();
  });
  return button;
}

function syncSelectionCommentWidget(): void {
  clearSelectionCommentWidget();
  const selection = currentTextSelection();
  if (selection == null || activeCommentId != null) return;

  const editor = selection.side === "original" ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();
  const model = editor.getModel();
  if (!model) return;
  const domNode = createSelectionCommentButton();
  const position = model.validatePosition({
    lineNumber: selection.anchor.startLine,
    column: selection.anchor.startColumn,
  });
  const widget: monaco.editor.IContentWidget = {
    allowEditorOverflow: false,
    getId: () => "selection-comment",
    getDomNode: () => domNode,
    getPosition: () => ({
      position,
      preference: [
        monaco.editor.ContentWidgetPositionPreference.ABOVE,
        monaco.editor.ContentWidgetPositionPreference.BELOW,
      ],
    }),
    beforeRender: () => ({ width: 94, height: 30 }),
  };
  editor.addContentWidget(widget);
  mountedSelectionWidget = { editor, widget };
}

function captureTextSelection(editor: monaco.editor.ICodeEditor, side: InlineCommentSide): void {
  const selection = editor.getSelection();
  const model = editor.getModel();
  if (selection == null || selection.isEmpty() || model == null || activePath == null || workspace == null) {
    dismissTextSelection();
    return;
  }
  activeTextSelection = {
    path: activePath,
    mode: workspace.mode,
    side,
    anchor: {
      kind: "range",
      startLine: selection.startLineNumber,
      startColumn: selection.startColumn,
      endLine: selection.endLineNumber,
      endColumn: selection.endColumn,
      selectedText: model.getValueInRange(selection),
    },
  };
  syncSelectionCommentWidget();
}

function addSelectionComment(): void {
  const selection = currentTextSelection();
  if (selection == null) return;
  dismissTextSelection();
  addCommentAtTarget({ path: selection.path, mode: selection.mode, side: selection.side, anchor: { ...selection.anchor } });
}

function isCommentGutter(target: monaco.editor.MouseTargetType): boolean {
  return target === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
    || target === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
}

function installGutterComments(editor: monaco.editor.ICodeEditor, side: InlineCommentSide): void {
  let hoverDecorations: string[] = [];
  editor.onMouseMove((event) => {
    const target = event.target;
    const gutter = isCommentGutter(target.type);
    const line = gutter ? target.position?.lineNumber : undefined;
    const hasLineComment = line != null && comments.some((comment) =>
      comment.path === activePath
      && comment.mode === workspace?.mode
      && comment.side === side
      && comment.anchor.kind === "line"
      && comment.anchor.line === line,
    );
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    if (line != null && !hasLineComment) {
      decorations.push({
        range: new monaco.Range(line, 1, line, 1),
        options: { glyphMarginClassName: "review-glyph-plus" },
      });
    }
    hoverDecorations = editor.deltaDecorations(hoverDecorations, decorations);
  });
  editor.onMouseLeave(() => {
    hoverDecorations = editor.deltaDecorations(hoverDecorations, []);
  });
  editor.onMouseDown((event) => {
    const target = event.target;
    const gutter = isCommentGutter(target.type);
    const line = target.position?.lineNumber ?? target.range?.startLineNumber;
    if (!gutter || line == null) return;
    try {
      addInlineComment(side, line);
    } catch (error) {
      showToast(`Could not add comment: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function installTextSelection(editor: monaco.editor.ICodeEditor, side: InlineCommentSide): void {
  let mouseSelecting = false;
  const finishMouseSelection = (): void => {
    if (!mouseSelecting) return;
    mouseSelecting = false;
    if (editor.hasTextFocus()) captureTextSelection(editor, side);
    else dismissTextSelection();
  };

  editor.onMouseDown((event) => {
    const target = event.target.type;
    mouseSelecting = target === monaco.editor.MouseTargetType.CONTENT_TEXT
      || target === monaco.editor.MouseTargetType.CONTENT_EMPTY;
    if (mouseSelecting) dismissTextSelection();
  });
  editor.onMouseUp(finishMouseSelection);
  window.addEventListener("mouseup", finishMouseSelection);
  editor.onDidFocusEditorText(() => {
    if (!mouseSelecting) captureTextSelection(editor, side);
  });
  editor.onDidBlurEditorText(() => {
    window.setTimeout(() => {
      if (!editor.hasTextFocus() && activeTextSelection?.side === side) dismissTextSelection();
    }, 0);
  });
  editor.onDidChangeCursorSelection(() => {
    if (editor.hasTextFocus() && !mouseSelecting) captureTextSelection(editor, side);
  });
}

function layoutCommentWidgets(editor: monaco.editor.ICodeEditor): void {
  for (const mounted of mountedCommentWidgets) {
    if (mounted.editor !== editor) continue;
    if (mounted.kind === "editor") sizeInlineComment(mounted.domNode, editor);
    editor.layoutContentWidget(mounted.widget);
  }
  if (mountedSelectionWidget?.editor === editor) editor.layoutContentWidget(mountedSelectionWidget.widget);
}

const originalEditor = diffEditor.getOriginalEditor();
const modifiedEditor = diffEditor.getModifiedEditor();
installGutterComments(originalEditor, "original");
installGutterComments(modifiedEditor, "modified");
installTextSelection(originalEditor, "original");
installTextSelection(modifiedEditor, "modified");
originalEditor.onDidLayoutChange(() => layoutCommentWidgets(originalEditor));
modifiedEditor.onDidLayoutChange(() => layoutCommentWidgets(modifiedEditor));

window.__reviewReceive = (message: HostMessage): void => {
  if (message.type === "workspace") {
    window.clearInterval(readyTimer);
    saveMountedScroll();
    const previousPath = activePath;
    const previousMode = workspace?.mode;
    workspace = message.state;
    if (pendingOpenPath && workspace.files.some((file) => file.path === pendingOpenPath)) {
      activePath = pendingOpenPath;
      pendingOpenPath = null;
    } else if (!activePath || !workspace.files.some((file) => file.path === activePath)) {
      activePath = workspace.recentPaths.find((path) => workspace!.files.some((file) => file.path === path)) ?? workspace.files[0]?.path ?? null;
    }
    const file = activeFile();
    if (previousPath !== activePath || previousMode !== workspace.mode) {
      settleActiveComment();
      dismissTextSelection();
      clearCommentWidgets();
    }
    if (previousPath !== activePath || previousMode !== workspace.mode || file?.fingerprint !== mountedFingerprint) mountedFingerprint = "";
    render();
    requestActiveFile();
    return;
  }
  if (message.type === "file") {
    if (message.requestId === activeRequestId) mountFile(message.file);
    return;
  }
  if (message.type === "file-error") {
    if (message.requestId === activeRequestId) showToast(message.message);
    return;
  }
  if (message.type === "review-submitted") {
    comments = [];
    activeCommentId = null;
    dismissTextSelection();
    submitButton.disabled = false;
    renderFeedback();
    renderRecent();
    renderTree();
    updateSubmitButton();
    syncInlineComments();
    showToast(message.insertedFeedback ? "Checkpoint saved · feedback inserted into pi" : "Checkpoint saved");
  }
};

function requestMode(mode: ReviewMode): void {
  saveMountedScroll();
  settleActiveComment();
  dismissTextSelection();
  syncInlineComments();
  send({ type: "set-mode", mode });
}

checkpointButton.addEventListener("click", () => requestMode("checkpoint"));
headButton.addEventListener("click", () => requestMode("head"));
searchInput.addEventListener("input", () => { renderRecent(); renderTree(); });
lineWrapButton.addEventListener("click", () => {
  const enabled = lineWrapButton.getAttribute("aria-pressed") !== "true";
  const wordWrap = enabled ? "on" : "off";
  lineWrapButton.setAttribute("aria-pressed", String(enabled));
  lineWrapButton.classList.toggle("active", enabled);
  lineWrapButton.title = enabled ? "Disable line wrap" : "Enable line wrap";
  // Monaco uses wordWrapOverride1 internally for diffWordWrap. Set the
  // higher-priority override too so both nested editors receive the toggle.
  diffEditor.updateOptions({ diffWordWrap: wordWrap, wordWrapOverride2: wordWrap });
});
fileCommentButton.addEventListener("click", openFileComment);
deleteFileCommentButton.addEventListener("mousedown", (event) => {
  // Keep the textarea focused until the click runs. Otherwise its deferred
  // focusout handler can collapse the editor and remove this button first.
  event.preventDefault();
});
deleteFileCommentButton.addEventListener("click", () => {
  const active = activeFileComment();
  if (active) removeComment(active.id);
});
fileCommentInput.addEventListener("input", () => {
  const active = activeFileComment();
  if (!active) return;
  active.body = fileCommentInput.value;
  updateSubmitButton();
});
fileCommentInput.addEventListener("focusout", () => {
  const id = fileCommentInput.dataset.commentId;
  window.setTimeout(() => {
    if (!id || activeCommentId !== id || fileCommentInput === document.activeElement) return;
    collapseFileComment(id);
  }, 0);
});
fileCommentInput.addEventListener("keydown", (event) => {
  if (((event.metaKey || event.ctrlKey) && event.key === "Enter") || event.key === "Escape") {
    event.preventDefault();
    fileCommentInput.blur();
  }
});
submitButton.addEventListener("click", () => {
  if (submitButton.disabled) return;
  settleActiveComment();
  dismissTextSelection();
  submitButton.disabled = true;
  submitButton.textContent = "Saving…";
  send({ type: "submit-review", comments });
  window.setTimeout(() => updateSubmitButton(), 5000);
});
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});
window.setInterval(renderRecent, 10_000);

const announceReady = (): void => {
  if (workspace == null) send({ type: "ready" });
};
announceReady();
readyTimer = window.setInterval(announceReady, 250);
