/* ------------------------------------------------------------------
   NOCTURNE / compact widget end-to-end test
------------------------------------------------------------------- */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startServer } from "../server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOT = path.join(ROOT, "screenshots", "widget-browser.png");
const TARGET_MS = Date.parse("2027-09-18T09:00:00+08:00");
const DAY_MS = 86_400_000;
const VIEWPORT = { width: 432, height: 690 };

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => process.stdout.write(`${message}\n`);

async function findBrowser() {
  const { access } = await import("node:fs/promises");
  for (const candidate of EDGE_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try next.
    }
  }
  throw new Error("No Chromium browser found. Set EDGE_PATH.");
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

class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP open failed")), {
        once: true,
      });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      } else {
        const handlers = this.listeners.get(message.method);
        if (handlers) handlers.forEach((handler) => handler(message.params));
      }
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      for (const request of this.pending.values()) request.reject(new Error("CDP closed"));
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
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP closed"));
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.socket && this.socket.readyState <= 1) this.socket.close();
  }
}

async function launch(executable) {
  const profile = await mkdtemp(path.join(tmpdir(), "nocturne-widget-e2e-"));
  const child = spawn(executable, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const portData = await waitForFile(path.join(profile, "DevToolsActivePort"));
  const port = Number(portData.split(/\r?\n/)[0]);
  let target;
  const started = Date.now();
  while (!target && Date.now() - started < 10_000) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((item) => item.type === "page");
    } catch {
      await sleep(120);
    }
  }
  if (!target) throw new Error(`No page target found.\n${stderr}`);

  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();

  return {
    cdp,
    async close() {
      try { await cdp.send("Browser.close"); } catch { /* already gone */ }
      cdp.close();
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(2000)]);
      if (child.exitCode === null) child.kill();
      await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    },
  };
}

async function main() {
  await mkdir(path.dirname(SHOT), { recursive: true });
  let server;
  let browser;
  const runtimeErrors = [];

  try {
    server = await startServer({ port: 0 });
    browser = await launch(await findBrowser());
    const { cdp } = browser;

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    cdp.on("Runtime.exceptionThrown", (params) => {
      runtimeErrors.push(params.exceptionDetails?.text || "Runtime exception");
    });

    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", {
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
        await sleep(120);
      }
      throw new Error(`Timed out: ${label}`);
    };

    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: `${server.url}/widget.html` });
    await loaded;
    await waitFor("Boolean(window.__NOCTURNE_WIDGET__)", "widget bootstrap");

    assert.equal(await evaluate("document.title"), "NOCTURNE DESK WIDGET");
    assert.equal(await evaluate("window.__NOCTURNE_WIDGET__.targetISO"), "2027-09-18T09:00:00+08:00");

    const expectedDays = Math.floor((TARGET_MS - Date.now()) / DAY_MS);
    const days = await evaluate(
      'Number(document.querySelector("#daysRemaining").textContent.replace(/,/g, ""))',
    );
    assert.ok(Math.abs(days - expectedDays) <= 1, `countdown expected ~${expectedDays}, got ${days}`);
    log(`  ✓  compact widget booted — ${days} days`);

    await waitFor(
      'document.querySelector("#weatherCard").dataset.state === "ready"',
      "widget weather",
      20_000,
    );
    assert.match(
      await evaluate('document.querySelector("#weatherTemp").textContent'),
      /^-?\d+$/,
      "weather temperature should load",
    );
    log("  ✓  live weather loaded in compact card");

    // Add via the real modal form.
    const dates = await evaluate(`(() => {
      const key = (offset) => {
        const d = new Date();
        d.setDate(d.getDate() + offset);
        return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
      };
      return { today: key(0), tomorrow: key(1) };
    })()`);

    const addEntry = async ({ title, type, date, time }, count) => {
      await evaluate('document.querySelector("#openAddModal").click()');
      await waitFor('!document.querySelector("#addModal").hidden', "add modal");
      await evaluate(`(() => {
        document.querySelector('.type-switch__button[data-type="${type}"]').click();
        const set = (selector, value) => {
          const input = document.querySelector(selector);
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        };
        set("#entryTitle", ${JSON.stringify(title)});
        set("#entryDate", ${JSON.stringify(date)});
        set("#entryTime", ${JSON.stringify(time)});
        document.querySelector("#addForm").requestSubmit();
        return true;
      })()`);
      await waitFor(
        `JSON.parse(localStorage.getItem("nocturne.agenda.v1") || "[]").length === ${count}`,
        `entry ${title}`,
      );
      await waitFor(
        `document.querySelectorAll("#taskList .agenda-row").length === ${count}`,
        `row ${title}`,
      );
    };

    await addEntry({ title: "晨间复盘与今日计划", type: "event", date: dates.today, time: "16:30" }, 1);
    await addEntry({ title: "CSP-S 图论专题训练", type: "task", date: dates.today, time: "18:30" }, 2);
    await addEntry({ title: "夜跑 · 5 公里", type: "event", date: dates.today, time: "20:00" }, 3);
    await addEntry({ title: "图书馆 · 算法专题自习", type: "event", date: dates.tomorrow, time: "14:00" }, 4);
    await addEntry({ title: "整理错题与当日复盘", type: "task", date: dates.tomorrow, time: "21:00" }, 5);
    log("  ✓  add-modal flow and LocalStorage persistence");

    await evaluate(`(() => {
      const row = [...document.querySelectorAll(".agenda-row")].find((node) => node.querySelector(".agenda-row__title").textContent === "整理错题与当日复盘");
      row.querySelector('[data-action="toggle"]').click();
      return true;
    })()`);
    await waitFor('document.querySelectorAll(".agenda-row.is-done").length === 1', "task completion");
    assert.equal(
      await evaluate('JSON.parse(localStorage.getItem("nocturne.agenda.v1")).filter((item) => item.done).length'),
      1,
    );

    const overflow = await evaluate(`({
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      agendaBottom: document.querySelector(".agenda").getBoundingClientRect().bottom,
      footerBottom: document.querySelector(".widget-footer").getBoundingClientRect().bottom,
      heroRight: document.querySelector(".hero").getBoundingClientRect().right,
      miniRight: document.querySelector(".mini-grid").getBoundingClientRect().right
    })`);
    assert.ok(
      overflow.scrollWidth <= overflow.width,
      `widget must not overflow horizontally (${overflow.scrollWidth} > ${overflow.width})`,
    );
    assert.ok(
      overflow.scrollHeight <= overflow.height + 1,
      `widget must fit vertically (${overflow.scrollHeight} > ${overflow.height})`,
    );
    assert.ok(overflow.footerBottom <= overflow.height, "footer must stay inside the widget");
    assert.ok(overflow.heroRight <= overflow.width, "hero must not be clipped");
    assert.ok(overflow.miniRight <= overflow.width, "mini cards must not be clipped");

    await evaluate("document.activeElement instanceof HTMLElement && document.activeElement.blur()");
    await sleep(2450);
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await writeFile(SHOT, Buffer.from(screenshot.data, "base64"));
    log(`  ✓  aligned compact layout — ${SHOT}`);

    // Reload persistence.
    const reloaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.reload", { ignoreCache: true });
    await reloaded;
    await waitFor("Boolean(window.__NOCTURNE_WIDGET__)", "widget reload");
    await waitFor('document.querySelectorAll(".agenda-row").length === 5', "widget rows after reload");
    assert.equal(await evaluate('document.querySelectorAll(".agenda-row.is-done").length'), 1);
    log("  ✓  widget restored after reload");

    // Modal and key workflow.
    await evaluate('document.querySelector("#openAddModal").click()');
    await waitFor('!document.querySelector("#addModal").hidden', "add modal reopened");
    await evaluate('document.querySelector("#addModal [data-close]").click()');
    await waitFor('document.querySelector("#addModal").hidden', "add modal closed");

    await evaluate('document.querySelector("#openKeyModal").click()');
    await waitFor('!document.querySelector("#keyModal").hidden', "key modal opened");
    const fakeKey = "sk-nocturne-widget-invalid";
    await evaluate(`(() => {
      const input = document.querySelector("#apiKey");
      input.value = ${JSON.stringify(fakeKey)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#keyForm").requestSubmit();
      return true;
    })()`);
    await waitFor(
      `localStorage.getItem("nocturne.deepseek.key.v1") === ${JSON.stringify(fakeKey)}`,
      "widget key storage",
    );
    await waitFor(
      '["error", "ready"].includes(document.querySelector("#balanceCard").dataset.state)',
      "widget balance response",
      20_000,
    );
    assert.equal(await evaluate('document.querySelector("#balanceCard").dataset.state'), "error");

    await evaluate('document.querySelector("#openKeyModal").click()');
    await waitFor('!document.querySelector("#keyModal").hidden', "key modal for removal");
    await evaluate('document.querySelector("#removeKey").click()');
    assert.equal(await evaluate('localStorage.getItem("nocturne.deepseek.key.v1")'), null);
    log("  ✓  key modal, storage and removal");

    // Delete one entry.
    await evaluate(`(() => {
      const row = document.querySelector(".agenda-row");
      row.querySelector('[data-action="delete"]').click();
      return true;
    })()`);
    await waitFor(
      'JSON.parse(localStorage.getItem("nocturne.agenda.v1")).length === 4',
      "widget delete",
    );
    log("  ✓  delete flow");

    assert.equal(runtimeErrors.length, 0, `runtime errors: ${runtimeErrors.join(" | ")}`);
    log("\nAll NOCTURNE widget checks passed.\n");
    log(`Widget screenshot: ${SHOT}\n`);
  } finally {
    if (browser) await browser.close();
    if (server?.server) await new Promise((resolve) => server.server.close(resolve));
  }
}

main().catch((error) => {
  console.error("\nNOCTURNE widget checks failed:\n", error);
  process.exitCode = 1;
});
