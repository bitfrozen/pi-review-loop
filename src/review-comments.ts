import type { ReviewComment } from "./types.js";

export function sameReviewTarget(left: ReviewComment, right: ReviewComment): boolean {
  if (left.path !== right.path || left.mode !== right.mode || left.side !== right.side) return false;
  if (left.anchor.kind !== right.anchor.kind) return false;

  switch (left.anchor.kind) {
    case "file":
      return true;
    case "line":
      return right.anchor.kind === "line" && left.anchor.line === right.anchor.line;
    case "range":
      return right.anchor.kind === "range"
        && left.anchor.startLine === right.anchor.startLine
        && left.anchor.startColumn === right.anchor.startColumn
        && left.anchor.endLine === right.anchor.endLine
        && left.anchor.endColumn === right.anchor.endColumn;
  }
}
