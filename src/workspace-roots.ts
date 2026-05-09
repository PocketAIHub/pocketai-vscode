import * as vscode from "vscode";
import type { ChatSession } from "./types";
import { resolveSessionWorkspaceRoot } from "./workspace-root-workflows";

export function getPrimaryWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function getSessionWorkspaceRoot(session?: Pick<ChatSession, "worktreeRoot">): string | undefined {
  return resolveSessionWorkspaceRoot(
    getPrimaryWorkspaceRoot(),
    session?.worktreeRoot,
  );
}
