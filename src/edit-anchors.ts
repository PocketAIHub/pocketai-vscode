import { createHash } from "crypto";

export type ReadSnapshot = {
  filePath: string;
  lines: string[];
  contentHash: string;
  updatedAt: number;
};

export type AnchoredEditRange = {
  startLine: number;
  endLine: number;
};

const readSnapshots = new Map<string, ReadSnapshot>();

export function clearReadSnapshots() {
  readSnapshots.clear();
}

export function hasAnchoredEditRange(
  toolCall: { startLine?: number; endLine?: number },
): boolean {
  return toolCall.startLine !== undefined || toolCall.endLine !== undefined;
}

export function recordReadSnapshot(filePath: string, content: string): ReadSnapshot {
  const normalizedPath = normalizeSnapshotPath(filePath);
  const lines = splitLines(content);
  const snapshot: ReadSnapshot = {
    filePath: normalizedPath,
    lines,
    contentHash: hashLines(lines),
    updatedAt: Date.now(),
  };
  readSnapshots.set(normalizedPath, snapshot);
  return snapshot;
}

export function getReadSnapshot(filePath: string): ReadSnapshot | undefined {
  return readSnapshots.get(normalizeSnapshotPath(filePath));
}

export function resolveAnchoredEditRange(
  toolCall: { startLine?: number; endLine?: number },
): AnchoredEditRange | undefined {
  if (!hasAnchoredEditRange(toolCall)) return undefined;
  const startLine = Number(toolCall.startLine);
  const endLine = Number(toolCall.endLine ?? toolCall.startLine);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    return undefined;
  }
  return { startLine, endLine };
}

export function validateAnchoredEdit(
  filePath: string,
  currentContent: string,
  range: AnchoredEditRange,
):
  | { ok: true; oldText: string; currentHash: string; snapshotHash: string }
  | { ok: false; error: string } {
  const snapshot = getReadSnapshot(filePath);
  if (!snapshot) {
    return {
      ok: false,
      error: `Error: You must read ${filePath} before using an anchored edit. Use read_file first.`,
    };
  }

  const currentLines = splitLines(currentContent);
  const rangeError = validateRange(range, snapshot.lines.length, currentLines.length);
  if (rangeError) {
    return { ok: false, error: rangeError };
  }

  const snapshotLines = snapshot.lines.slice(range.startLine - 1, range.endLine);
  const currentRangeLines = currentLines.slice(range.startLine - 1, range.endLine);
  const snapshotHash = hashLines(snapshotLines);
  const currentHash = hashLines(currentRangeLines);

  if (snapshotHash !== currentHash) {
    return {
      ok: false,
      error:
        `Error: Anchored edit for \`${filePath}\` lines ${range.startLine}-${range.endLine} is stale.\n` +
        `The file changed since read_file. Re-read the target range and retry.\n` +
        `Last-read range hash: ${snapshotHash}\n` +
        `Current range hash: ${currentHash}`,
    };
  }

  return {
    ok: true,
    oldText: currentRangeLines.join("\n"),
    currentHash,
    snapshotHash,
  };
}

export function applyAnchoredEdit(
  filePath: string,
  currentContent: string,
  range: AnchoredEditRange,
  replacement: string,
):
  | {
      ok: true;
      content: string;
      oldText: string;
      currentHash: string;
      snapshotHash: string;
    }
  | { ok: false; error: string } {
  const validation = validateAnchoredEdit(filePath, currentContent, range);
  if (!validation.ok) return validation;

  const currentLines = splitLines(currentContent);
  const replacementLines = replacement.length > 0 ? replacement.split("\n") : [];
  const nextLines = [
    ...currentLines.slice(0, range.startLine - 1),
    ...replacementLines,
    ...currentLines.slice(range.endLine),
  ];
  const lineEnding = detectLineEnding(currentContent);

  return {
    ok: true,
    content: nextLines.join(lineEnding),
    oldText: validation.oldText,
    currentHash: validation.currentHash,
    snapshotHash: validation.snapshotHash,
  };
}

export function hashLines(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
}

export function splitLines(content: string): string[] {
  return content.split(/\r\n|\n/);
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function validateRange(
  range: AnchoredEditRange,
  snapshotLineCount: number,
  currentLineCount: number,
): string | undefined {
  if (range.startLine < 1 || range.endLine < 1) {
    return "Error: Anchored edit line numbers are 1-based and must be positive.";
  }
  if (range.endLine < range.startLine) {
    return "Error: Anchored edit end_line must be greater than or equal to start_line.";
  }
  if (range.endLine > snapshotLineCount) {
    return `Error: Anchored edit range ${range.startLine}-${range.endLine} was not present in the last read snapshot (${snapshotLineCount} lines). Re-read the target range.`;
  }
  if (range.endLine > currentLineCount) {
    return `Error: Anchored edit range ${range.startLine}-${range.endLine} is beyond the current file (${currentLineCount} lines). Re-read the target range.`;
  }
  return undefined;
}

function normalizeSnapshotPath(filePath: string): string {
  return String(filePath || "").replace(/\\/g, "/");
}
