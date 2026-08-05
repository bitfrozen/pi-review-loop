import type { ReviewComment } from "./types.js";

function sideSuffix(comment: ReviewComment): string {
  if (comment.side === "file") return "";
  if (comment.side === "modified") return " (current)";
  if (comment.mode === "head") return " (HEAD)";
  return " (reviewed)";
}

function location(comment: ReviewComment): string {
  if (comment.anchor.kind === "file") return comment.path;
  if (comment.anchor.kind === "line") return `${comment.path}:${comment.anchor.line}${sideSuffix(comment)}`;
  const anchor = comment.anchor;
  return `${comment.path}:${anchor.startLine}:${anchor.startColumn}-${anchor.endLine}:${anchor.endColumn}${sideSuffix(comment)}`;
}

function appendIndented(lines: string[], value: string, prefix: string): void {
  for (const line of value.split("\n")) lines.push(`${prefix}${line}`);
}

export function composeFeedback(comments: ReviewComment[]): string {
  const valid = comments.filter((comment) => comment.body.trim().length > 0);
  if (valid.length === 0) return "";

  const lines = ["Please address the following review feedback:", ""];
  valid.forEach((comment, index) => {
    lines.push(`${index + 1}. ${location(comment)}`);
    if (comment.anchor.kind === "range") {
      lines.push("   Selected text:");
      appendIndented(lines, comment.anchor.selectedText, "       ");
    }
    appendIndented(lines, comment.body.trim(), "   ");
    lines.push("");
  });
  return lines.join("\n").trim();
}
