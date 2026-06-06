import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (typeof fetch !== "function" || typeof WebSocket !== "function") {
  throw new Error("This script requires a Node runtime with global fetch and WebSocket.");
}

const chromePath = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const repoRoot = resolve(".");
const screenshotDir = join(repoRoot, "tmp-preview-screenshots-cdp");
const userDataDir = join(repoRoot, `tmp-preview-chrome-profile-${process.pid}-${Date.now()}`);
const port = 9223;
const previewBaseUrl = process.env.PREVIEW_BASE_URL ?? "https://preview.presciaiq.com";
const hostResolverRule = process.env.PREVIEW_HOST_RESOLVER_RULE;
const templates = ["concreting", "electrical", "general", "hvac", "landscaping", "plumbing"];
const viewports = [
  { name: "desktop", width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false },
  { name: "mobile", width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
];

mkdirSync(screenshotDir, { recursive: true });

const chromeArgs = [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--remote-debugging-port=" + port,
  "--user-data-dir=" + userDataDir,
  "about:blank",
];
if (hostResolverRule) {
  chromeArgs.splice(-1, 0, "--host-resolver-rules=" + hostResolverRule);
}

const chrome = spawn(chromePath, chromeArgs);

let stderr = "";
chrome.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

async function waitForDebugEndpoint() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still booting.
    }
    await delay(100);
  }
  throw new Error("Chrome DevTools endpoint did not start.");
}

async function createTarget(url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });
  if (!response.ok) {
    throw new Error(`Failed to create target: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function connect(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const events = [];

  ws.addEventListener("message", (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) {
      const { resolve: resolvePending, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(JSON.stringify(data.error)));
      else resolvePending(data.result ?? {});
      return;
    }
    if (data.method) events.push(data);
  });

  const ready = new Promise((resolveReady, rejectReady) => {
    ws.addEventListener("open", resolveReady, { once: true });
    ws.addEventListener("error", rejectReady, { once: true });
  });

  return {
    events,
    ready,
    send(method, params = {}) {
      id += 1;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          rejectPromise(new Error(`CDP command timed out: ${method}`));
        }, 15000);
        pending.set(id, {
          resolve(value) {
            clearTimeout(timeout);
            resolvePromise(value);
          },
          reject(error) {
            clearTimeout(timeout);
            rejectPromise(error);
          },
        });
      });
    },
    close() {
      ws.close();
    },
  };
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result?.value;
}

async function verifyPage(template, viewport) {
  const url = `${previewBaseUrl.replace(/\/$/, "")}/sample-${template}.html`;
  const target = await createTarget(url);
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", viewport);
  await cdp.send("Page.navigate", { url });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await evaluate(cdp, "document.readyState");
    if (ready === "complete") break;
    await delay(100);
  }

  await evaluate(
    cdp,
    "new Promise(resolve => setTimeout(resolve, 3200)).then(() => document.getElementById('loader')?.className ?? '')",
    true,
  );

  const firstViewportScreenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  const screenshotPath = join(screenshotDir, `${template}-${viewport.name}.png`);
  writeFileSync(screenshotPath, Buffer.from(firstViewportScreenshot.data, "base64"));

  await evaluate(
    cdp,
    `new Promise(async resolve => {
      const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const step = Math.max(window.innerHeight - 80, 300);
      for (let y = 0; y <= height; y += step) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 180));
      }
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 300));
      resolve(true);
    })`,
    true,
  );

  const audit = await evaluate(
    cdp,
    `(async () => {
      const images = Array.from(document.images).map(img => ({
        src: img.currentSrc || img.src,
        complete: img.complete,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight
      }));
      const imageFetches = await Promise.all(images
        .filter(img => img.src.includes('/assets/previews/'))
        .map(async img => {
          try {
            const response = await fetch(img.src, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
            const blob = await response.blob();
            return { src: img.src, ok: response.ok, status: response.status, size: blob.size };
          } catch (error) {
            return { src: img.src, ok: false, status: 0, size: 0, error: String(error) };
          }
        }));
      const bg = getComputedStyle(document.querySelector('.hero-bg')).backgroundImage;
      const externalRequests = performance.getEntriesByType('resource')
        .map(entry => entry.name)
        .filter(name => name.includes('images.unsplash.com'));
      return {
        title: document.title,
        bodyText: document.body.innerText.slice(0, 200),
        loaderClass: document.getElementById('loader')?.className ?? '',
        unresolvedTokens: document.documentElement.innerHTML.includes('{{') || document.documentElement.innerHTML.includes('}}'),
        unsplashInDom: document.documentElement.innerHTML.includes('images.unsplash.com'),
        externalRequests,
        imageCount: images.length,
        failedImageFetches: imageFetches.filter(result => !result.ok || result.size === 0),
        heroBackgroundLoaded: bg.includes('/assets/previews/')
      };
    })()`,
    true,
  );

  const relevantEvents = cdp.events.filter((event) => {
    if (event.method === "Network.loadingFailed") {
      return event.params?.requestId && JSON.stringify(event).includes("/assets/previews/");
    }
    if (event.method === "Runtime.consoleAPICalled") return true;
    if (event.method === "Log.entryAdded") return true;
    return false;
  });

  cdp.close();
  await Promise.race([
    fetch(`http://127.0.0.1:${port}/json/close/${target.id}`),
    delay(3000),
  ]).catch(() => {});

  const failures = [];
  if (!audit.loaderClass.includes("hidden")) failures.push("loader not hidden");
  if (audit.unresolvedTokens) failures.push("unresolved template token");
  if (audit.unsplashInDom) failures.push("Unsplash reference in DOM");
  if (audit.externalRequests.length > 0) failures.push("Unsplash network request");
  if (!audit.heroBackgroundLoaded) failures.push("hero background missing local asset");
  if (audit.failedImageFetches.length > 0) {
    failures.push(`${audit.failedImageFetches.length} failed image fetches`);
  }
  const loadingFailures = relevantEvents.filter((event) => event.method === "Network.loadingFailed");
  if (loadingFailures.length > 0) failures.push(`${loadingFailures.length} network loading failures`);

  return {
    template,
    viewport: viewport.name,
    screenshotPath,
    audit,
    eventCount: relevantEvents.length,
    failures,
  };
}

let exitCode = 0;

try {
  await waitForDebugEndpoint();
  const results = [];
  for (const template of templates) {
    for (const viewport of viewports) {
      const result = await verifyPage(template, viewport);
      results.push(result);
      console.log(
        `${result.template}\t${result.viewport}\timages=${result.audit.imageCount}\tfailedFetches=${result.audit.failedImageFetches.length}\tloader=${result.audit.loaderClass}\tscreenshot=${result.screenshotPath}`,
      );
      if (result.failures.length > 0) {
        console.log(`  FAIL ${result.failures.join(", ")}`);
      }
    }
  }

  const failed = results.filter((result) => result.failures.length > 0);
  console.log(`checked=${results.length} failed=${failed.length}`);
  if (failed.length > 0) exitCode = 1;
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  chrome.kill();
  await delay(500);
  try {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    // Chrome may keep Crashpad/Download Service files locked briefly on Windows.
  }
  if (exitCode) {
    console.error(stderr);
  }
}

process.exit(exitCode);
