import * as path from "path";
import { isInsidePath } from "./helpers";

export function resolveSessionWorkspaceRoot(
  primaryRoot: string | undefined,
  worktreeRoot: string | undefined,
): string | undefined {
  const normalizedWorktreeRoot = worktreeRoot?.trim();
  if (!primaryRoot) return normalizedWorktreeRoot || undefined;
  if (!normalizedWorktreeRoot) return primaryRoot;
  return isInsidePath(primaryRoot, normalizedWorktreeRoot)
    ? path.resolve(normalizedWorktreeRoot)
    : primaryRoot;
}
