import * as child_process from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
const EXISTING_ENDPOINT_TIMEOUT_MS = 700;
const LAUNCH_TIMEOUT_MS = 10000;
const HTTP_TIMEOUT_MS = 3000;
const CDP_COMMAND_TIMEOUT_MS = 10000;
const DEFAULT_BODY_TEXT_LIMIT = 6000;
const DEFAULT_ELEMENT_LIMIT = 80;
const MAX_BODY_TEXT_LIMIT = 20000;
const MAX_ELEMENT_LIMIT = 200;
const WS_OPEN = 1;

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?: (eventName: string, handler: (event: unknown) => void) => void;
};

type WebSocketConstructorLike = new (url: string) => WebSocketLike;

type JsonVersion = {
  Browser?: string;
  webSocketDebuggerUrl?: string;
};

type JsonTarget = {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

type CdpWireMessage = {
  id?: number;
  result?: unknown;
  error?: { message?: string; data?: string };
};

type RuntimeEvaluateResult = {
  result?: { value?: unknown; description?: string };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string; value?: unknown };
  };
};

type PageMetadata = {
  url: string;
  title: string;
};

type ResolvedElement = {
  ok: boolean;
  error?: string;
  ref?: string;
  description?: string;
  x?: number;
  y?: number;
};

export type BrowserCdpOptions = {
  cdpEndpoint?: string;
  executablePath?: string;
  headless?: boolean;
  launchTimeoutMs?: number;
};

export type BrowserSnapshotElement = {
  ref: string;
  tag: string;
  role: string;
  text: string;
  ariaLabel: string;
  placeholder: string;
  inputType: string;
  href: string;
  disabled: boolean;
  rect: { x: number; y: number; width: number; height: number };
};

export type BrowserSnapshot = {
  url: string;
  title: string;
  bodyText: string;
  bodyTextTruncated: boolean;
  elements: BrowserSnapshotElement[];
  elementsTruncated: boolean;
};

export type BrowserScreenshotResult = {
  path: string;
  bytes: number;
  url: string;
  title: string;
  format: "png";
  fullPage: boolean;
  capturedAt: string;
};

type BrowserCdpSession = {
  endpoint: string;
  launched: boolean;
  child?: child_process.ChildProcess;
  userDataDir?: string;
  pageClient?: CdpClient;
  targetId?: string;
  lastSnapshot?: BrowserSnapshot;
};

let activeSession: BrowserCdpSession | undefined;

class CdpClient {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(private readonly ws: WebSocketLike) {
    setWebSocketHandler(ws, "message", (event) => this.handleMessage(event));
    setWebSocketHandler(ws, "close", () => this.rejectAll("CDP websocket closed."));
    setWebSocketHandler(ws, "error", (event) =>
      this.rejectAll(`CDP websocket error: ${describeWebSocketEvent(event)}`),
    );
  }

  isOpen(): boolean {
    return this.ws.readyState === WS_OPEN;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
    this.rejectAll("CDP websocket closed.");
  }

  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = CDP_COMMAND_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.isOpen()) {
      return Promise.reject(new Error("CDP websocket is not open."));
    }

    const id = ++this.nextId;
    const payload = JSON.stringify({
      id,
      method,
      ...(params ? { params } : {}),
    });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        this.ws.send(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(event: unknown) {
    const data = getWebSocketEventData(event);
    if (!data) return;

    let parsed: CdpWireMessage;
    try {
      parsed = JSON.parse(data) as CdpWireMessage;
    } catch {
      return;
    }

    if (typeof parsed.id !== "number") return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(parsed.id);

    if (parsed.error) {
      const message = [parsed.error.message, parsed.error.data]
        .filter(Boolean)
        .join(": ");
      pending.reject(new Error(message || "CDP command failed."));
      return;
    }

    pending.resolve(parsed.result);
  }

  private rejectAll(message: string) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}

export async function navigateBrowser(
  url: string,
  options: BrowserCdpOptions = {},
): Promise<string> {
  const normalizedUrl = normalizeBrowserUrl(url);
  const session = await ensureBrowserSession(options);
  const client = await ensurePageClient(session, normalizedUrl, true);

  await client.send("Page.navigate", { url: normalizedUrl });
  await waitForPageSettled(client, options.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS);
  const metadata = await getPageMetadata(client);

  return [
    "Browser navigated.",
    `URL: ${metadata.url}`,
    `Title: ${metadata.title || "(untitled)"}`,
    `CDP endpoint: ${session.endpoint}`,
  ].join("\n");
}

export async function snapshotBrowser(
  options: BrowserCdpOptions & {
    maxBodyChars?: number;
    maxElements?: number;
  } = {},
): Promise<string> {
  const session = await ensureBrowserSession(options);
  const client = await ensurePageClient(session);
  const snapshot = await captureBrowserSnapshot(client, {
    maxBodyChars: options.maxBodyChars,
    maxElements: options.maxElements,
  });
  session.lastSnapshot = snapshot;
  return formatBrowserSnapshot(snapshot);
}

export async function clickBrowserElement(
  refOrIndex: string,
  options: BrowserCdpOptions = {},
): Promise<string> {
  const session = await ensureBrowserSession(options);
  const client = await ensurePageClient(session);
  const ref = resolveLatestSnapshotRef(session, refOrIndex);
  const element = await evaluatePage<ResolvedElement>(
    client,
    buildResolveElementExpression(ref, "click"),
  );

  if (!element?.ok) {
    throw new Error(element?.error || `Browser element ${refOrIndex} is unavailable.`);
  }
  if (!isFiniteNumber(element.x) || !isFiniteNumber(element.y)) {
    throw new Error(`Browser element ${refOrIndex} has no clickable coordinates.`);
  }

  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: element.x,
    y: element.y,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: element.x,
    y: element.y,
    button: "left",
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: element.x,
    y: element.y,
    button: "left",
    clickCount: 1,
  });

  await delay(350);
  await waitForPageSettled(client, 3000);
  const metadata = await getPageMetadata(client);
  return [
    `Clicked browser element ${refOrIndex}.`,
    element.description ? `Element: ${element.description}` : "",
    `URL: ${metadata.url}`,
    `Title: ${metadata.title || "(untitled)"}`,
  ].filter(Boolean).join("\n");
}

export async function typeIntoBrowser(
  text: string,
  refOrIndex = "",
  options: BrowserCdpOptions = {},
): Promise<string> {
  if (!text) return "Error: No browser text was provided.";

  const session = await ensureBrowserSession(options);
  const client = await ensurePageClient(session);
  const ref = refOrIndex ? resolveLatestSnapshotRef(session, refOrIndex) : "";
  const focusResult = await evaluatePage<ResolvedElement>(
    client,
    ref
      ? buildResolveElementExpression(ref, "type")
      : buildActiveElementExpression(),
  );

  if (!focusResult?.ok) {
    throw new Error(
      focusResult?.error ||
        (refOrIndex
          ? `Browser element ${refOrIndex} cannot receive text.`
          : "No editable browser element is focused."),
    );
  }

  await client.send("Input.insertText", { text });
  await delay(100);
  const metadata = await getPageMetadata(client);
  return [
    `Typed ${text.length} character(s) into the browser.`,
    focusResult.description ? `Element: ${focusResult.description}` : "",
    `URL: ${metadata.url}`,
  ].filter(Boolean).join("\n");
}

export async function screenshotBrowser(
  options: BrowserCdpOptions & { fullPage?: boolean } = {},
): Promise<string> {
  const session = await ensureBrowserSession(options);
  const client = await ensurePageClient(session);
  const metadata = await getPageMetadata(client);
  const result = await client.send<{ data?: string }>("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: Boolean(options.fullPage),
  });

  if (!result.data) {
    throw new Error("CDP did not return screenshot data.");
  }

  const filePath = path.join(
    os.tmpdir(),
    `pocketai-browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
  );
  fs.writeFileSync(filePath, result.data, "base64");
  const stat = fs.statSync(filePath);
  return formatBrowserScreenshotResult({
    path: filePath,
    bytes: stat.size,
    url: metadata.url,
    title: metadata.title,
    format: "png",
    fullPage: Boolean(options.fullPage),
    capturedAt: new Date().toISOString(),
  });
}

export function closeBrowserSession(): string {
  const session = activeSession;
  if (!session) return "No active browser session.";

  activeSession = undefined;
  try {
    session.pageClient?.close();
  } catch {}

  if (session.launched && session.child) {
    try {
      session.child.kill();
    } catch {}
  }
  if (session.userDataDir) {
    cleanupTempProfile(session.userDataDir);
  }

  return session.launched
    ? "Closed PocketAI-managed browser session."
    : "Disconnected from browser CDP session.";
}

export function formatBrowserSnapshot(snapshot: BrowserSnapshot): string {
  const lines: string[] = [
    "Browser snapshot",
    `URL: ${snapshot.url || "(unknown)"}`,
    `Title: ${snapshot.title || "(untitled)"}`,
    "",
    `Body text${snapshot.bodyTextTruncated ? " (truncated)" : ""}:`,
    snapshot.bodyText || "(empty)",
    "",
    `Interactive elements (${snapshot.elements.length}${snapshot.elementsTruncated ? ", truncated" : ""}):`,
  ];

  if (snapshot.elements.length === 0) {
    lines.push("(none visible)");
  } else {
    snapshot.elements.forEach((element, index) => {
      lines.push(formatSnapshotElement(element, index + 1));
    });
  }

  return lines.join("\n");
}

export function formatBrowserScreenshotResult(
  result: BrowserScreenshotResult,
): string {
  return [
    "Browser screenshot saved.",
    `Path: ${result.path}`,
    `Format: ${result.format}`,
    `Bytes: ${result.bytes}`,
    `URL: ${result.url || "(unknown)"}`,
    `Title: ${result.title || "(untitled)"}`,
    `Full page: ${result.fullPage ? "yes" : "no"}`,
    `Captured at: ${result.capturedAt}`,
  ].join("\n");
}

export function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("browser_navigate requires a URL.");

  const withScheme = hasExplicitBrowserUrlScheme(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Invalid browser URL: ${value}`);
  }

  if (!["http:", "https:", "file:", "about:"].includes(parsed.protocol)) {
    throw new Error(
      `Unsupported browser URL protocol "${parsed.protocol}". Use http, https, file, or about URLs.`,
    );
  }

  return parsed.toString();
}

function hasExplicitBrowserUrlScheme(value: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return true;
  if (/^(?:about|file):/i.test(value)) return true;
  if (/^[^/:]+:\d+(?:[/?#]|$)/.test(value)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

export function findChromiumExecutable(configuredPath?: string): string | undefined {
  const configured = configuredPath?.trim();
  if (configured) {
    if (fs.existsSync(configured)) return configured;
    throw new Error(
      `Configured Chromium executable does not exist: ${configured}`,
    );
  }

  for (const candidate of getChromiumExecutableCandidates()) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function ensureBrowserSession(
  options: BrowserCdpOptions,
): Promise<BrowserCdpSession> {
  const configuredEndpoint = normalizeCdpEndpoint(options.cdpEndpoint);

  if (
    activeSession &&
    (!configuredEndpoint || activeSession.endpoint === configuredEndpoint) &&
    await isEndpointAvailable(activeSession.endpoint, HTTP_TIMEOUT_MS)
  ) {
    return activeSession;
  }

  if (activeSession?.pageClient) {
    activeSession.pageClient.close();
  }
  activeSession = undefined;

  if (configuredEndpoint) {
    await waitForEndpoint(
      configuredEndpoint,
      options.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS,
    );
    activeSession = { endpoint: configuredEndpoint, launched: false };
    return activeSession;
  }

  if (await isEndpointAvailable(DEFAULT_CDP_ENDPOINT, EXISTING_ENDPOINT_TIMEOUT_MS)) {
    activeSession = { endpoint: DEFAULT_CDP_ENDPOINT, launched: false };
    return activeSession;
  }

  activeSession = await launchBrowserSession(options);
  return activeSession;
}

async function launchBrowserSession(
  options: BrowserCdpOptions,
): Promise<BrowserCdpSession> {
  const executable = findChromiumExecutable(options.executablePath);
  if (!executable) {
    throw new Error(
      "Could not find a Chromium-family browser. Install Chrome/Chromium/Edge/Brave or set pocketai.browserExecutablePath.",
    );
  }

  const port = await getFreePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pocketai-chrome-"));
  const args = buildChromiumArgs(port, userDataDir, Boolean(options.headless));
  const child = child_process.spawn(executable, args, {
    detached: false,
    stdio: "ignore",
  });

  const spawnError = await waitForSpawnError(child, 250);
  if (spawnError) {
    cleanupTempProfile(userDataDir);
    throw new Error(`Failed to launch Chromium: ${spawnError.message}`);
  }

  child.unref();
  scheduleLaunchedBrowserCleanup(child, userDataDir);

  try {
    await waitForEndpoint(endpoint, options.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS);
  } catch (error) {
    try {
      child.kill();
    } catch {}
    cleanupTempProfile(userDataDir);
    throw error;
  }

  return {
    endpoint,
    launched: true,
    child,
    userDataDir,
  };
}

async function ensurePageClient(
  session: BrowserCdpSession,
  initialUrl = "about:blank",
  preferNewTarget = false,
): Promise<CdpClient> {
  if (session.pageClient?.isOpen()) {
    return session.pageClient;
  }

  const target = preferNewTarget
    ? await createPageTarget(session.endpoint, initialUrl).catch(() =>
        getOrCreatePageTarget(session.endpoint, initialUrl),
      )
    : await getOrCreatePageTarget(session.endpoint, initialUrl);
  if (!target.webSocketDebuggerUrl) {
    throw new Error("Chromium did not expose a page websocket URL.");
  }

  const client = await connectCdpWebSocket(target.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  session.pageClient = client;
  session.targetId = target.id;
  return client;
}

async function getOrCreatePageTarget(
  endpoint: string,
  initialUrl: string,
): Promise<JsonTarget> {
  const targets = await fetchJson<JsonTarget[]>(`${endpoint}/json/list`);
  const page = targets.find(
    (target) => target.type === "page" && target.webSocketDebuggerUrl,
  );
  if (page) return page;

  return createPageTarget(endpoint, initialUrl);
}

async function createPageTarget(
  endpoint: string,
  initialUrl: string,
): Promise<JsonTarget> {
  const url = `${endpoint}/json/new?${encodeURIComponent(initialUrl)}`;
  try {
    return await fetchJson<JsonTarget>(url, { method: "PUT" });
  } catch (error) {
    return fetchJson<JsonTarget>(url, { method: "GET" });
  }
}

async function waitForEndpoint(
  endpoint: string,
  timeoutMs: number,
): Promise<JsonVersion> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetchJson<JsonVersion>(
        `${endpoint}/json/version`,
        undefined,
        Math.min(HTTP_TIMEOUT_MS, Math.max(250, deadline - Date.now())),
      );
    } catch (error) {
      lastError = error;
      await delay(150);
    }
  }

  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(
    `Unable to connect to Chromium DevTools at ${endpoint} within ${timeoutMs}ms.${detail}`,
  );
}

async function isEndpointAvailable(
  endpoint: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await fetchJson<JsonVersion>(`${endpoint}/json/version`, undefined, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function captureBrowserSnapshot(
  client: CdpClient,
  options: { maxBodyChars?: number; maxElements?: number },
): Promise<BrowserSnapshot> {
  const maxBodyChars = clampInteger(
    options.maxBodyChars,
    DEFAULT_BODY_TEXT_LIMIT,
    1000,
    MAX_BODY_TEXT_LIMIT,
  );
  const maxElements = clampInteger(
    options.maxElements,
    DEFAULT_ELEMENT_LIMIT,
    1,
    MAX_ELEMENT_LIMIT,
  );
  return evaluatePage<BrowserSnapshot>(
    client,
    buildSnapshotExpression(maxBodyChars, maxElements),
  );
}

async function waitForPageSettled(client: CdpClient, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await evaluatePage<string>(
        client,
        "document.readyState",
        1000,
      );
      if (state === "complete" || state === "interactive") {
        await delay(250);
        return;
      }
    } catch {}
    await delay(150);
  }
}

async function getPageMetadata(client: CdpClient): Promise<PageMetadata> {
  return evaluatePage<PageMetadata>(
    client,
    "(() => ({ url: String(location.href || ''), title: String(document.title || '') }))()",
    3000,
  );
}

async function evaluatePage<T>(
  client: CdpClient,
  expression: string,
  timeoutMs = CDP_COMMAND_TIMEOUT_MS,
): Promise<T> {
  const result = await client.send<RuntimeEvaluateResult>(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: false,
      userGesture: true,
    },
    timeoutMs,
  );

  if (result.exceptionDetails) {
    const detail =
      result.exceptionDetails.exception?.description ||
      String(result.exceptionDetails.exception?.value || "") ||
      result.exceptionDetails.text ||
      "Runtime.evaluate failed.";
    throw new Error(detail);
  }

  return result.result?.value as T;
}

async function connectCdpWebSocket(
  wsUrl: string,
  timeoutMs = CDP_COMMAND_TIMEOUT_MS,
): Promise<CdpClient> {
  const WebSocketCtor = getGlobalWebSocket();
  const ws = new WebSocketCtor(wsUrl);

  return new Promise<CdpClient>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {}
      reject(new Error(`Timed out connecting to CDP websocket: ${wsUrl}`));
    }, timeoutMs);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    setWebSocketHandler(ws, "open", () =>
      settle(() => resolve(new CdpClient(ws))),
    );
    setWebSocketHandler(ws, "error", (event) =>
      settle(() =>
        reject(
          new Error(
            `Could not connect to CDP websocket: ${describeWebSocketEvent(event)}`,
          ),
        ),
      ),
    );
    setWebSocketHandler(ws, "close", () =>
      settle(() => reject(new Error("CDP websocket closed before connecting."))),
    );
  });
}

function resolveLatestSnapshotRef(
  session: BrowserCdpSession,
  refOrIndex: string,
): string {
  const raw = refOrIndex.trim();
  if (!raw) {
    throw new Error("A browser element ref or index is required.");
  }

  const snapshot = session.lastSnapshot;
  if (!snapshot) {
    throw new Error("Run browser_snapshot before clicking or typing by ref.");
  }

  if (snapshot.elements.some((element) => element.ref === raw)) {
    return raw;
  }

  const index = Number(raw);
  if (Number.isInteger(index) && index >= 1 && index <= snapshot.elements.length) {
    return snapshot.elements[index - 1].ref;
  }

  throw new Error(
    `No browser element "${refOrIndex}" exists in the latest snapshot. Run browser_snapshot again.`,
  );
}

function buildSnapshotExpression(maxBodyChars: number, maxElements: number): string {
  return `(() => {
    const maxBodyChars = ${maxBodyChars};
    const maxElements = ${maxElements};
    const selector = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      'summary',
      '[contenteditable="true"]',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="tab"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    const win = window;
    const previousMap = win.__pocketaiRefMap instanceof Map ? win.__pocketaiRefMap : new Map();
    const nextMap = new Map();
    let nextRef = Number(win.__pocketaiNextRef || 1);

    function compactText(value, limit) {
      return String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit);
    }
    function getRef(el) {
      let ref = el.__pocketaiBrowserRef;
      if (!ref) {
        ref = String(nextRef++);
        try {
          Object.defineProperty(el, '__pocketaiBrowserRef', {
            value: ref,
            configurable: true
          });
        } catch {
          el.__pocketaiBrowserRef = ref;
        }
      }
      nextMap.set(ref, el);
      return ref;
    }
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (Number(style.opacity) === 0) return false;
      const rects = Array.from(el.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
      if (!rects.length) return false;
      const rect = rects[0];
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    }
    function nativeRole(el) {
      const role = el.getAttribute('role');
      if (role) return role;
      const tag = el.tagName.toLowerCase();
      const type = String(el.getAttribute('type') || '').toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'input') {
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
        return 'textbox';
      }
      return '';
    }
    function elementText(el) {
      const tag = el.tagName.toLowerCase();
      const type = String(el.getAttribute('type') || '').toLowerCase();
      const value = typeof el.value === 'string' ? el.value : '';
      const aria = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const alt = el.getAttribute('alt') || '';
      const placeholder = el.getAttribute('placeholder') || '';
      const text = compactText(el.innerText || el.textContent || '', 180);
      if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) {
        return compactText(aria || value || text || title || placeholder, 180);
      }
      return compactText(aria || text || value || title || alt || placeholder, 180);
    }
    function isDisabled(el) {
      return Boolean(el.disabled) || String(el.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
    }

    const rawText = String((document.body && document.body.innerText) || document.documentElement.innerText || '')
      .replace(/[ \\t]+/g, ' ')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();
    const candidates = Array.from(document.querySelectorAll(selector));
    const elements = [];
    for (const el of candidates) {
      if (elements.length >= maxElements) break;
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      elements.push({
        ref: getRef(el),
        tag: el.tagName.toLowerCase(),
        role: nativeRole(el),
        text: elementText(el),
        ariaLabel: compactText(el.getAttribute('aria-label') || '', 160),
        placeholder: compactText(el.getAttribute('placeholder') || '', 120),
        inputType: compactText(el.getAttribute('type') || '', 60),
        href: compactText(el.href || '', 220),
        disabled: isDisabled(el),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
    }

    win.__pocketaiRefMap = nextMap;
    win.__pocketaiNextRef = nextRef;
    return {
      url: String(location.href || ''),
      title: String(document.title || ''),
      bodyText: rawText.slice(0, maxBodyChars),
      bodyTextTruncated: rawText.length > maxBodyChars,
      elements,
      elementsTruncated: candidates.length > elements.length
    };
  })()`;
}

function buildResolveElementExpression(ref: string, action: "click" | "type"): string {
  return `(() => {
    const ref = ${JSON.stringify(ref)};
    const action = ${JSON.stringify(action)};
    const map = window.__pocketaiRefMap;
    const el = map instanceof Map ? map.get(ref) : undefined;
    if (!el || !el.isConnected) {
      return { ok: false, error: 'Browser element ref ' + ref + ' is no longer available. Run browser_snapshot again.' };
    }
    function text(el) {
      return String(el.getAttribute('aria-label') || el.innerText || el.textContent || el.value || el.getAttribute('placeholder') || el.tagName || '')
        .replace(/\\s+/g, ' ')
        .trim()
        .slice(0, 160);
    }
    function isDisabled(el) {
      return Boolean(el.disabled) || String(el.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
    }
    function isEditable(el) {
      const tag = el.tagName.toLowerCase();
      const type = String(el.getAttribute('type') || 'text').toLowerCase();
      const blockedTypes = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color']);
      return Boolean(el.isContentEditable) ||
        tag === 'textarea' ||
        (tag === 'input' && !blockedTypes.has(type) && !el.readOnly && !isDisabled(el));
    }
    if (isDisabled(el)) {
      return { ok: false, error: 'Browser element ref ' + ref + ' is disabled.' };
    }
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (action === 'type') {
      if (!isEditable(el)) {
        return { ok: false, error: 'Browser element ref ' + ref + ' is not editable.' };
      }
      el.focus({ preventScroll: false });
    }
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return { ok: false, error: 'Browser element ref ' + ref + ' is not visible.' };
    }
    return {
      ok: true,
      ref,
      description: '<' + el.tagName.toLowerCase() + '> ' + text(el),
      x: Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2)),
      y: Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2))
    };
  })()`;
}

function buildActiveElementExpression(): string {
  return `(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) {
      return { ok: false, error: 'No editable browser element is focused.' };
    }
    function isDisabled(el) {
      return Boolean(el.disabled) || String(el.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
    }
    function isEditable(el) {
      const tag = el.tagName.toLowerCase();
      const type = String(el.getAttribute('type') || 'text').toLowerCase();
      const blockedTypes = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color']);
      return Boolean(el.isContentEditable) ||
        tag === 'textarea' ||
        (tag === 'input' && !blockedTypes.has(type) && !el.readOnly && !isDisabled(el));
    }
    if (!isEditable(el)) {
      return { ok: false, error: 'The active browser element is not editable.' };
    }
    const label = String(el.getAttribute('aria-label') || el.innerText || el.textContent || el.value || el.getAttribute('placeholder') || el.tagName || '')
      .replace(/\\s+/g, ' ')
      .trim()
      .slice(0, 160);
    return { ok: true, description: '<' + el.tagName.toLowerCase() + '> ' + label };
  })()`;
}

function formatSnapshotElement(
  element: BrowserSnapshotElement,
  index: number,
): string {
  const label =
    element.text ||
    element.ariaLabel ||
    element.placeholder ||
    element.href ||
    "(no label)";
  const details = [
    element.role ? `role=${element.role}` : "",
    element.inputType ? `type=${element.inputType}` : "",
    element.disabled ? "disabled" : "",
    element.href ? `href=${truncate(element.href, 100)}` : "",
  ].filter(Boolean);
  const detailText = details.length ? ` (${details.join(", ")})` : "";
  const rect = `${element.rect.x},${element.rect.y} ${element.rect.width}x${element.rect.height}`;
  return `[${index}] ref=${element.ref} <${element.tag}> ${truncate(label, 140)}${detailText} @ ${rect}`;
}

function buildChromiumArgs(
  port: number,
  userDataDir: string,
  headless: boolean,
): string[] {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-extensions",
    "--disable-popup-blocking",
    "--new-window",
    "about:blank",
  ];

  if (headless) {
    args.splice(args.length - 1, 0, "--headless=new", "--disable-gpu");
  }

  return args;
}

function getChromiumExecutableCandidates(): string[] {
  if (process.platform === "darwin") {
    const homeApplications = path.join(os.homedir(), "Applications");
    const appPaths = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      path.join(homeApplications, "Google Chrome.app/Contents/MacOS/Google Chrome"),
      path.join(homeApplications, "Chromium.app/Contents/MacOS/Chromium"),
      path.join(homeApplications, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
      path.join(homeApplications, "Brave Browser.app/Contents/MacOS/Brave Browser"),
    ];
    return appPaths;
  }

  if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean) as string[];
    const suffixes = [
      "Google/Chrome/Application/chrome.exe",
      "Microsoft/Edge/Application/msedge.exe",
      "BraveSoftware/Brave-Browser/Application/brave.exe",
      "Chromium/Application/chrome.exe",
    ];
    return roots.flatMap((root) =>
      suffixes.map((suffix) => path.join(root, suffix)),
    );
  }

  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/usr/bin/brave-browser",
    "/snap/bin/chromium",
    "/opt/google/chrome/chrome",
  ];
}

function getGlobalWebSocket(): WebSocketConstructorLike {
  const WebSocketCtor = (globalThis as unknown as {
    WebSocket?: WebSocketConstructorLike;
  }).WebSocket;
  if (!WebSocketCtor) {
    throw new Error(
      "This Node runtime does not expose globalThis.WebSocket, which is required for CDP browser tools.",
    );
  }
  return WebSocketCtor;
}

function setWebSocketHandler(
  ws: WebSocketLike,
  eventName: string,
  handler: (event: unknown) => void,
) {
  if (typeof ws.addEventListener === "function") {
    ws.addEventListener(eventName, handler);
    return;
  }
  (ws as unknown as Record<string, unknown>)[`on${eventName}`] = handler;
}

function getWebSocketEventData(event: unknown): string {
  const data =
    event && typeof event === "object" && "data" in event
      ? (event as { data?: unknown }).data
      : event;
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf-8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf-8");
  }
  return "";
}

function describeWebSocketEvent(event: unknown): string {
  if (event instanceof Error) return event.message;
  if (event && typeof event === "object" && "message" in event) {
    return String((event as { message?: unknown }).message || "unknown error");
  }
  return "unknown error";
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<T> {
  if (typeof fetch !== "function") {
    throw new Error("This Node runtime does not expose global fetch.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...(init || {}),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeCdpEndpoint(value?: string): string {
  const trimmed = value?.trim() || "";
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`Invalid Chromium DevTools endpoint: ${value}`);
  }
}

function waitForSpawnError(
  child: child_process.ChildProcess,
  timeoutMs: number,
): Promise<Error | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener("error", finish);
      resolve(error);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    child.once("error", finish);
  });
}

function scheduleLaunchedBrowserCleanup(
  child: child_process.ChildProcess,
  userDataDir: string,
) {
  child.once("exit", () => cleanupTempProfile(userDataDir));
  process.once("exit", () => {
    try {
      if (!child.killed) child.kill();
    } catch {}
  });
}

function cleanupTempProfile(userDataDir: string) {
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {}
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(Number(value))));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function truncate(value: string, maxLength: number): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
