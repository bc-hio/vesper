/* ------------------------------------------------------------------
   NOCTURNE / end-to-end smoke test
   Uses Edge headless + the Chrome DevTools Protocol (no npm packages).
------------------------------------------------------------------- */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startServer } from "../server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCREENSHOT_DIR = path.join(ROOT, "screenshots");
const DESKTOP_SHOT = path.join(SCREENSHOT_DIR, "nocturne-dashboard.png");
const MOBILE_SHOT = path.join(SCREENSHOT_DIR, "nocturne-mobile.png");
const TARGET_MS = Date.parse("2027-09-18T09:00:00+08:00");
const DAY_MS = 86_400_000;

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function findBrowser() {
  const { access } = await import("node:fs/promises");
  for (const candidate of EDGE_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known install path.
    }
  }
  throw new Error("No Chromium browser found. Set EDGE_PATH to a headless-capable browser.");
}

async function waitForFile(filePath, timeout = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP socket open timed out")), 10_000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP socket failed to open"));
      }, { once: true });
    });

    this.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }

      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
        return;
      }

      const handlers = this.listeners.get(message.method);
      if (handlers) handlers.forEach((handler) => handler(message.params));
    });

    this.socket.addEventListener("close", () => {
      this.closed = true;
      for (const request of this.pending.values()) {
        request.reject(new Error("CDP socket closed"));
      }
      this.pending.clear();
    });
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) || new Set();
    handlers.add(handler);
    this.listeners.set(method, handlers);
    return () => handlers.delete(handler);
  }

  once(method, timeout = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for CDP event: ${method}`));
      }, timeout);
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP socket is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.socket && this.socket.readyState <= 1) this.socket.close();
  }
}

async function launchBrowser(url) {
  const executable = await findBrowser();
  const profileDir = await mkdtemp(path.join(tmpdir(), "nocturne-edge-"));
  const child = spawn(executable, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--window-size=1440,960",
    url,
  ], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 12_000) stderr = stderr.slice(-12_000);
  });

  const portFile = path.join(profileDir, "DevToolsActivePort");
  const portData = await waitForFile(portFile);
  const debugPort = Number(portData.split(/\r?\n/)[0]);
  assert.ok(Number.isInteger(debugPort) && debugPort > 0, "DevTools port should be valid");

  let target = null;
  const started = Date.now();
  while (!target && Date.now() - started < 10_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      target = targets.find((item) => item.type === "page");
    } catch {
      await sleep(120);
    }
  }
  if (!target) throw new Error(`No debuggable Edge page found.\n${stderr}`);

  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();

  return {
    child,
    client,
    profileDir,
    debugPort,
    getStderr: () => stderr,
    async close() {
      try {
        await client.send("Browser.close");
      } catch {
        // The browser may already be gone.
      }
      client.close();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        sleep(2_500),
      ]);
      if (child.exitCode === null) child.kill();
      await rm(profileDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    },
  };
}

async function main() {
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  let dashboard;
  let browser;
  const runtimeExceptions = [];
  const consoleErrors = [];

  try {
    dashboard = await startServer({ port: 0 });
    log(`\nNOCTURNE E2E\n  server  ${dashboard.url}`);

    // --- HTTP contract -------------------------------------------------
    const health = await fetch(`${dashboard.url}/api/health`);
    assert.equal(health.status, 200, "health endpoint should respond 200");
    assert.equal((await health.json()).ok, true, "health payload should be ok");

    const guarded = await fetch(`${dashboard.url}/api/deepseek/balance`);
    assert.equal(guarded.status, 401, "balance proxy should reject missing keys");

    const traversal = await fetch(`${dashboard.url}/..%2fserver.mjs`);
    assert.ok([403, 404].includes(traversal.status), "static server must not escape the workspace");
    log("  ✓  static server, health check and API auth guard");

    // --- Browser -------------------------------------------------------
    browser = await launchBrowser("about:blank");
    const { client } = browser;
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });

    client.on("Runtime.exceptionThrown", (params) => {
      runtimeExceptions.push(params.exceptionDetails?.text || "Unknown runtime exception");
    });
    client.on("Runtime.consoleAPICalled", (params) => {
      if (params.type === "error") {
        consoleErrors.push(params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
      }
    });
    client.on("Log.entryAdded", (params) => {
      if (params.entry?.level === "error") consoleErrors.push(params.entry.text);
    });

    const evaluate = async (expression) => {
      const result = await client.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      }
      return result.result.value;
    };

    const waitFor = async (expression, label, timeout = 15_000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const value = await evaluate(expression);
        if (value) return value;
        await sleep(140);
      }
      throw new Error(`Timed out: ${label}`);
    };

    const loaded = client.once("Page.loadEventFired");
    await client.send("Page.navigate", { url: `${dashboard.url}/` });
    await loaded;
    await waitFor("Boolean(window.__NOCTURNE__)", "dashboard application bootstrap");
    log("  ✓  single-page app booted");

    // --- Countdown -----------------------------------------------------
    const targetInPage = await evaluate("window.__NOCTURNE__.targetISO");
    assert.equal(targetInPage, "2027-09-18T09:00:00+08:00", "countdown target should be 2027-09-18");
    const expectedDays = Math.max(0, Math.floor((TARGET_MS - Date.now()) / DAY_MS));
    await waitFor(
      'Number(document.querySelector("#daysRemaining").textContent.replace(/,/g, "")) > 0',
      "countdown day count",
    );
    const renderedDays = await evaluate(
      'Number(document.querySelector("#daysRemaining").textContent.replace(/,/g, ""))',
    );
    assert.ok(
      Math.abs(renderedDays - expectedDays) <= 1,
      `countdown should be accurate (expected ~${expectedDays}, got ${renderedDays})`,
    );
    const countdownTime = await evaluate(
      '["#hoursRemaining","#minutesRemaining","#secondsRemaining"].map((id) => document.querySelector(id).textContent)',
    );
    assert.match(countdownTime.join(":"), /^\d{2}:\d{2}:\d{2}$/, "countdown should tick hh:mm:ss");
    log(`  ✓  countdown target parsed — ${renderedDays} days remaining`);

    // --- Weather -------------------------------------------------------
    await waitFor(
      'document.querySelector("#weatherCard").dataset.state === "ready"',
      "live Open-Meteo weather",
      20_000,
    );
    const weather = await evaluate(`(() => ({
      temp: document.querySelector("#weatherTemp").textContent,
      condition: document.querySelector("#weatherCondition").textContent,
      range: document.querySelector("#weatherRange").textContent,
      humidity: document.querySelector("#weatherHumidity").textContent,
      wind: document.querySelector("#weatherWind").textContent
    }))()`);
    assert.match(weather.temp, /^-?\d+$/, "weather temperature should be populated");
    assert.match(weather.humidity, /^\d+%$/, "humidity should be populated");
    assert.match(weather.wind, /^\d+ km\/h$/, "wind speed should be populated");
    assert.ok(weather.condition && weather.condition !== "正在获取天气", "weather condition should render");
    assert.match(weather.range, /最高 -?\d+° \/ 最低 -?\d+°/, "daily high/low should render");
    log(`  ✓  Open-Meteo live data — ${weather.temp}°, ${weather.condition}, ${weather.humidity}`);

    // --- Form helpers --------------------------------------------------
    const addAgenda = async ({ title, type, date, time }, expectedCount) => {
      await evaluate(`(() => {
        document.querySelector('.type-button[data-type="${type}"]').click();
        const set = (selector, value) => {
          const input = document.querySelector(selector);
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        };
        set("#taskTitle", ${JSON.stringify(title)});
        set("#taskDate", ${JSON.stringify(date)});
        set("#taskTime", ${JSON.stringify(time)});
        document.querySelector("#taskForm").requestSubmit();
        return true;
      })()`);
      await waitFor(
        `JSON.parse(localStorage.getItem("nocturne.agenda.v1") || "[]").length === ${expectedCount}`,
        `agenda item "${title}" to persist`,
      );
      await waitFor(
        `document.querySelectorAll("#taskList .entry").length === ${expectedCount}`,
        `agenda item "${title}" to render`,
      );
    };

    const dates = await evaluate(`(() => {
      const key = (offset) => {
        const d = new Date();
        d.setDate(d.getDate() + offset);
        return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
      };
      return { today: key(0), tomorrow: key(1) };
    })()`);

    // Seeded through the real form so persistence is exercised end-to-end.
    await addAgenda({ title: "晨间复盘与本周计划", type: "event", date: dates.today, time: "16:30" }, 1);
    await addAgenda({ title: "CSP-S 图论专题训练", type: "task", date: dates.today, time: "18:30" }, 2);
    await addAgenda({ title: "图书馆 · 算法专题自习", type: "event", date: dates.tomorrow, time: "14:00" }, 3);
    await addAgenda({ title: "整理错题与当日复盘", type: "task", date: dates.tomorrow, time: "21:00" }, 4);
    log("  ✓  agenda add flow — 4 entries saved to LocalStorage");

    // Sort order, completion and filtering.
    const titles = await evaluate(
      '[...document.querySelectorAll("#taskList .entry__title")].map((node) => node.textContent)',
    );
    assert.deepEqual(titles, [
      "晨间复盘与本周计划",
      "CSP-S 图论专题训练",
      "图书馆 · 算法专题自习",
      "整理错题与当日复盘",
    ], "entries should sort chronologically");

    await evaluate(`(() => {
      const rows = [...document.querySelectorAll("#taskList .entry")];
      const row = rows.find((node) => node.querySelector(".entry__title").textContent === "整理错题与当日复盘");
      row.querySelector('[data-action="toggle"]').click();
      return true;
    })()`);
    await waitFor(
      'document.querySelectorAll("#taskList .entry.is-done").length === 1',
      "task completion toggle",
    );
    assert.equal(
      await evaluate('JSON.parse(localStorage.getItem("nocturne.agenda.v1")).filter((task) => task.done).length'),
      1,
      "completion should persist",
    );

    await evaluate('document.querySelector(\'.filter__button[data-filter="task"]\').click()');
    await waitFor(
      'document.querySelectorAll("#taskList .entry").length === 2',
      "task filter",
    );
    assert.equal(
      await evaluate('[...document.querySelectorAll("#taskList .entry")].every((row) => row.classList.contains("entry--task"))'),
      true,
      "task filter should show tasks only",
    );
    await evaluate('document.querySelector(\'.filter__button[data-filter="all"]\').click()');
    await waitFor(
      'document.querySelectorAll("#taskList .entry").length === 4',
      "all filter",
    );
    log("  ✓  sorting, completion state and filters");

    // --- Reload persistence -------------------------------------------
    const reloaded = client.once("Page.loadEventFired");
    await client.send("Page.reload", { ignoreCache: true });
    await reloaded;
    await waitFor("Boolean(window.__NOCTURNE__)", "reloaded application bootstrap");
    await waitFor(
      'document.querySelectorAll("#taskList .entry").length === 4',
      "agenda restore after reload",
    );
    assert.equal(
      await evaluate('document.querySelectorAll("#taskList .entry.is-done").length'),
      1,
      "completed state should survive reload",
    );
    await waitFor(
      'document.querySelector("#weatherCard").dataset.state === "ready"',
      "weather after reload",
      20_000,
    );
    await sleep(700);
    log("  ✓  agenda restored after full page reload");

    // --- Desktop screenshot -------------------------------------------
    const desktopMetrics = await evaluate(`({
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      cardCount: document.querySelectorAll(".card").length,
      footerVisible: document.querySelector(".footer").getBoundingClientRect().bottom <= innerHeight + 1
    })`);
    assert.equal(desktopMetrics.cardCount, 4, "four dashboard cards should exist");
    assert.ok(
      desktopMetrics.scrollWidth <= desktopMetrics.width,
      `desktop layout must not overflow horizontally (${desktopMetrics.scrollWidth} > ${desktopMetrics.width})`,
    );
    assert.equal(desktopMetrics.footerVisible, true, "footer should be visible at 1440×960");

    await evaluate("document.activeElement instanceof HTMLElement && document.activeElement.blur()");
    const desktopShot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await writeFile(DESKTOP_SHOT, Buffer.from(desktopShot.data, "base64"));
    log(`  ✓  desktop screenshot — ${DESKTOP_SHOT}`);

    // --- Mobile responsive check --------------------------------------
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await sleep(450);
    const mobileMetrics = await evaluate(`({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      cards: [...document.querySelectorAll(".card")].map((card) => card.getBoundingClientRect().width),
      composer: document.querySelector(".composer").getBoundingClientRect().width
    })`);
    assert.ok(
      mobileMetrics.scrollWidth <= mobileMetrics.width,
      `mobile layout must not overflow horizontally (${mobileMetrics.scrollWidth} > ${mobileMetrics.width})`,
    );
    assert.ok(
      mobileMetrics.cards.every((width) => width > 300 && width < 390),
      "all cards should fit the mobile viewport",
    );
    assert.ok(mobileMetrics.composer > 300, "composer should span the mobile card");
    const mobileLayout = await client.send("Page.getLayoutMetrics");
    const mobileShot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: 390,
        height: Math.ceil(mobileLayout.cssContentSize.height),
        scale: 1,
      },
    });
    await writeFile(MOBILE_SHOT, Buffer.from(mobileShot.data, "base64"));
    log(`  ✓  mobile layout — no horizontal overflow, ${MOBILE_SHOT}`);

    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(300);

    // --- DeepSeek key entry + LocalStorage -----------------------------
    const fakeKey = "sk-nocturne-e2e-invalid-key";
    await evaluate(`(() => {
      const input = document.querySelector("#apiKey");
      input.value = ${JSON.stringify(fakeKey)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#keyForm").requestSubmit();
      return true;
    })()`);
    await waitFor(
      `localStorage.getItem("nocturne.deepseek.key.v1") === ${JSON.stringify(fakeKey)}`,
      "API key stored in LocalStorage",
    );
    await waitFor(
      '["error", "ready"].includes(document.querySelector("#balanceCard").dataset.state)',
      "DeepSeek balance response",
      20_000,
    );
    assert.equal(
      await evaluate('document.querySelector("#balanceCard").dataset.state'),
      "error",
      "an invalid key should render an error state, not a fake balance",
    );
    assert.equal(
      await evaluate('document.querySelector("#balanceAlert").hidden'),
      false,
      "invalid key should surface a readable error",
    );
    await evaluate('document.querySelector("#changeKey").click()');
    assert.equal(
      await evaluate('localStorage.getItem("nocturne.deepseek.key.v1")'),
      null,
      "changing the key should remove it from LocalStorage",
    );
    assert.equal(
      await evaluate('document.querySelector("#balanceSetup").hidden'),
      false,
      "setup form should return after removing the key",
    );
    log("  ✓  DeepSeek key entry, storage, error handling and removal");

    // --- Delete flow ---------------------------------------------------
    const beforeDelete = await evaluate(
      'JSON.parse(localStorage.getItem("nocturne.agenda.v1")).length',
    );
    await evaluate(`(() => {
      const row = document.querySelector("#taskList .entry");
      row.querySelector('[data-action="delete"]').click();
      return true;
    })()`);
    await waitFor(
      `JSON.parse(localStorage.getItem("nocturne.agenda.v1")).length === ${beforeDelete - 1}`,
      "agenda deletion to persist",
    );
    await waitFor(
      `document.querySelectorAll("#taskList .entry").length === ${beforeDelete - 1}`,
      "agenda deletion to render",
    );
    log("  ✓  agenda delete flow");

    assert.equal(runtimeExceptions.length, 0, `runtime exceptions: ${runtimeExceptions.join(" | ")}`);
    const unexpectedConsoleErrors = consoleErrors.filter(
      (message) => !/deepseek|401|Failed to load resource|ERR_/i.test(message),
    );
    assert.equal(
      unexpectedConsoleErrors.length,
      0,
      `unexpected console errors: ${unexpectedConsoleErrors.join(" | ")}`,
    );

    log("\nAll NOCTURNE checks passed.\n");
    log(`Final screenshot: ${DESKTOP_SHOT}`);
    log(`Mobile screenshot: ${MOBILE_SHOT}\n`);
  } finally {
    if (browser) await browser.close();
    if (dashboard?.server) {
      await new Promise((resolve) => dashboard.server.close(resolve));
    }
  }
}

main().catch(async (error) => {
  console.error("\nNOCTURNE checks failed:\n", error);
  process.exitCode = 1;
});
