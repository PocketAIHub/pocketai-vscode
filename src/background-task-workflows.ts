import type { HarnessBackgroundTask } from "./types";

export function shouldPersistBackgroundTaskUpdate(
  previousTask: HarnessBackgroundTask | undefined,
  nextTask: HarnessBackgroundTask,
): boolean {
  if (!previousTask) return true;

  return (
    previousTask.command !== nextTask.command ||
    previousTask.kind !== nextTask.kind ||
    previousTask.toolCallId !== nextTask.toolCallId ||
    previousTask.status !== nextTask.status ||
    previousTask.outputPreview !== nextTask.outputPreview ||
    previousTask.exitCode !== nextTask.exitCode ||
    previousTask.startedAt !== nextTask.startedAt ||
    previousTask.completedAt !== nextTask.completedAt ||
    previousTask.cwd !== nextTask.cwd
  );
}
