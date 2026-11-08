/* ------------------------------------------------------------------
   NOCTURNE / Electron desktop widget end-to-end test
   Verifies the frameless host, preload bridge, server lifecycle,
   persistent agenda, layout and window controls.
------------------------------------------------------------------- */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const APP_DIR = path.join(ROOT, "desktop");
const SHOT = path.join(ROOT, "screenshots", "nocturne-widget.png");
const DEBUG_PORT = 9337;
const SERVER_HEALTH = "http://127.0.0.1:4173/api/health";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => process.stdout.write(`${message}\n`);

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
      const timer = setTimeout(() => reject(new Error("CDP open timed out")), 10_000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP open failed"));
      }, { once: true });
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

async function serverStatus() {
  try {
    const response = await fetch(SERVER_HEALTH, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(expected, timeout = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if ((await serverStatus()) === expected) return true;
    await sleep(250);
  }
  return false;
}

async function waitForTarget() {
  const started = Date.now();
  while (Date.now() - started < 25_000) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const target = targets.find((item) => item.type === "page" && item.url.includes("widget.html"));
      if (target) return target;
    } catch {
      // Electron is still booting.
    }
    await sleep(180);
  }
  return null;
}

async function launchWidget(profileDir) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.NOCTURNE_DEBUG_PORT = String(DEBUG_PORT);
  env.NOCTURNE_USER_DATA_DIR = profileDir;

  // Chromium needs an inherited desktop/console context in this managed
  // session; captured stdio can prevent it from creating a browser process.
  const child = spawn(ELECTRON, [APP_DIR, "--no-sandbox", "--disable-gpu"], {
    cwd: ROOT,
    env,
    windowsHide: false,
    stdio: "inherit",
  });

  const target = await waitForTarget();
  if (!target) {
    throw new Error("Electron widget did not expose a page target on port " + DEBUG_PORT);
  }

  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();

  return {
    child,
    cdp,
    async quit() {
      try {
        await cdp.send("Runtime.evaluate", {
          expression: "window.nocturneDesktop.quit(); true",
          userGesture: true,
        });
      } catch {
        // The page context disappears as the app quits.
      }
      cdp.close();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        sleep(6000),
      ]);
      if (child.exitCode === null) child.kill();
    },
  };
}

async function main() {
  await mkdir(path.dirname(SHOT), { recursive: true });
  assert.equal(existsSync(ELECTRON), true, "Electron runtime should be installed");
  assert.equal(await serverStatus(), false, "Start this test with no server already on port 4173");

  // Keep the test profile inside the workspace. Some managed Windows
  // sessions grant the browser process write access only to the project.
  const cacheRoot = path.join(ROOT, ".cache");
  await mkdir(cacheRoot, { recursive: true });
  const profileDir = await mkdtemp(path.join(cacheRoot, "electron-e2e-profile-"));
  let widget = null;
  const runtimeErrors = [];

  try {
    widget = await launchWidget(profileDir);
    const { cdp } = widget;

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

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

    const waitFor = async (expression, label, timeout = 20_000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const value = await evaluate(expression);
        if (value) return value;
        await sleep(140);
      }
      throw new Error(`Timed out: ${label}`);
    };

    await waitFor("Boolean(window.__NOCTURNE_WIDGET__)", "widget boot");
    await waitFor('document.querySelector("#weatherCard").dataset.state === "ready"', "live weather");
    assert.equal(await serverStatus(), true, "widget should have started its local server");
    log("  ✓  Electron host booted with its own local server");

    const host = await evaluate(`(async () => ({
      desktop: Boolean(window.nocturneDesktop),
      chromeVisible: !document.querySelector("#windowChrome").hidden,
      title: document.title,
      pinned: await window.nocturneDesktop.isPinned()
    }))()`);
    assert.equal(host.desktop, true, "preload bridge should be available");
    assert.equal(host.chromeVisible, true, "custom frameless chrome should be visible");
    assert.equal(host.title, "NOCTURNE DESK WIDGET");
    assert.equal(host.pinned, true, "widget should start pinned above other windows");
    log("  ✓  frameless chrome and preload bridge");

    // Pin control works through IPC.
    const pinWasActive = await evaluate(
      'document.querySelector(\'[data-window-action="pin"]\').classList.contains("is-active")',
    );
    await evaluate('document.querySelector(\'[data-window-action="pin"]\').click()');
    await waitFor(
      `document.querySelector('[data-window-action="pin"]').classList.contains("is-active") === ${!pinWasActive}`,
      "pin toggle",
    );
    await evaluate('document.querySelector(\'[data-window-action="pin"]\').click()');
    await waitFor(
      `document.querySelector('[data-window-action="pin"]').classList.contains("is-active") === ${pinWasActive}`,
      "pin restored",
    );
    log("  ✓  always-on-top pin toggles through IPC");

    const dates = await evaluate(`(() => {
      const key = (offset) => {
        const d = new Date();
        d.setDate(d.getDate() + offset);
        return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
      };
      return { today: key(0), tomorrow: key(1) };
    })()`);

    // One real interaction through the add modal.
    await evaluate('document.querySelector("#openAddModal").click()');
    await waitFor('!document.querySelector("#addModal").hidden', "add modal");
    await evaluate(`(() => {
      const set = (selector, value) => {
        const input = document.querySelector(selector);
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      document.querySelector('.type-switch__button[data-type="task"]').click();
      set("#entryTitle", "桌面浮窗联调");
      set("#entryDate", ${JSON.stringify(dates.today)});
      set("#entryTime", "15:00");
      document.querySelector("#addForm").requestSubmit();
      return true;
    })()`);
    await waitFor(
      'JSON.parse(localStorage.getItem("nocturne.agenda.v1") || "[]").length === 1',
      "task created",
    );
    log("  ✓  add modal writes through to LocalStorage");

    // Seed a calm set of sample rows for the final widget screenshot.
    // This only touches the isolated test profile.
    await evaluate(`(() => {
      const today = ${JSON.stringify(dates.today)};
      const tomorrow = ${JSON.stringify(dates.tomorrow)};
      const rows = [
        { id: "e2e-1", title: "晨间复盘与今日计划", type: "event", date: today, time: "16:30", done: false },
        { id: "e2e-2", title: "CSP-S 图论专题训练", type: "task", date: today, time: "18:30", done: false },
        { id: "e2e-3", title: "夜跑 · 5 公里", type: "event", date: today, time: "20:00", done: false },
        { id: "e2e-4", title: "图书馆 · 算法专题自习", type: "event", date: tomorrow, time: "14:00", done: false },
        { id: "e2e-5", title: "整理错题与当日复盘", type: "task", date: tomorrow, time: "21:00", done: true }
      ].map((row) => ({ ...row, createdAt: Date.now() }));
      localStorage.setItem("nocturne.agenda.v1", JSON.stringify(rows));
      return true;
    })()`);

    const reloaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.reload", { ignoreCache: true });
    await reloaded;
    await waitFor("Boolean(window.__NOCTURNE_WIDGET__)", "widget reload");
    await waitFor('document.querySelectorAll(".agenda-row").length === 5', "five rows after reload");
    await waitFor('document.querySelector("#weatherCard").dataset.state === "ready"', "weather after reload");
    assert.equal(await evaluate('document.querySelectorAll(".agenda-row.is-done").length'), 1);
    log("  ✓  five agenda rows restored after reload");

    const layout = await evaluate(`({
      innerWidth,
      innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      chromeVisible: !document.querySelector("#windowChrome").hidden,
      footerBottom: document.querySelector(".widget-footer").getBoundingClientRect().bottom,
      agendaBottom: document.querySelector(".agenda").getBoundingClientRect().bottom,
      heroRight: document.querySelector(".hero").getBoundingClientRect().right,
      miniRight: document.querySelector(".mini-grid").getBoundingClientRect().right
    })`);
    assert.ok(layout.scrollWidth <= layout.innerWidth, "widget must not overflow horizontally");
    assert.ok(layout.scrollHeight <= layout.innerHeight + 1, "widget must fit its window vertically");
    assert.ok(layout.footerBottom <= layout.innerHeight, "footer must remain visible");
    assert.ok(layout.agendaBottom <= layout.innerHeight, "agenda must remain visible");
    assert.ok(layout.heroRight <= layout.innerWidth, "hero must not be clipped");
    assert.ok(layout.miniRight <= layout.innerWidth, "mini cards must not be clipped");
    log("  ✓  frameless window layout has no clipping or overflow");

    await evaluate("document.activeElement instanceof HTMLElement && document.activeElement.blur()");
    await sleep(500);
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await writeFile(SHOT, Buffer.from(screenshot.data, "base64"));
    log(`  ✓  widget screenshot — ${SHOT}`);

    assert.equal(runtimeErrors.length, 0, `runtime errors: ${runtimeErrors.join(" | ")}`);

    // Quit through the custom close control path; the owned server must stop.
    await widget.quit();
    widget = null;
    assert.equal(
      await waitForServer(false, 10_000),
      true,
      "the local server should stop when the widget quits",
    );
    log("  ✓  graceful quit stops the widget-owned local server");

    log("\nAll NOCTURNE Electron widget checks passed.\n");
    log(`Widget screenshot: ${SHOT}\n`);
  } finally {
    if (widget) await widget.quit();
    await rm(profileDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error("\nNOCTURNE Electron widget checks failed:\n", error);
  process.exitCode = 1;
});
