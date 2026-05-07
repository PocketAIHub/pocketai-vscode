export function normalizeHttpExternalUrl(value: string): string | undefined {
  const raw = String(value || "").trim();
  if (!raw) return undefined;

  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function isHttpExternalUrl(value: string): boolean {
  return normalizeHttpExternalUrl(value) !== undefined;
}
