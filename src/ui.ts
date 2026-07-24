import { fileURLToPath } from "node:url";

const reviewHtmlPath = fileURLToPath(new URL("../web/dist/index.html", import.meta.url));

export function getReviewHtmlPath(): string {
  return reviewHtmlPath;
}
