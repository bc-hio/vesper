/* ------------------------------------------------------------------
   NOCTURNE / frameless desktop widget host
   - keeps the local server alive while the widget is open
   - opens a fixed, always-on-top, frameless window in the top-right
   - provides a tray icon so the widget can be restored or quit
------------------------------------------------------------------- */

"use strict";

const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
  dialog,
} = require("electron");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const APP_ROOT = app.isPackaged ? app.getAppPath() : PROJECT_ROOT;
const WIDGET_URL = "http://127.0.0.1:4173/widget.html";
const HEALTH_URL = "http://127.0.0.1:4173/api/health";
const ICON_PATH = path.join(APP_ROOT, "assets", "nocturne.ico");
const TRAY_ICON_PATH = path.join(APP_ROOT, "assets", "nocturne-icon.png");

// Dev runs keep state inside the project. An installed app uses the normal
// roaming profile so updates/reinstalls do not wipe the user's agenda.
const DATA_DIR = process.env.NOCTURNE_DATA_DIR
  ? path.resolve(process.env.NOCTURNE_DATA_DIR)
  : app.isPackaged
    ? path.join(app.getPath("appData"), "NOCTURNE")
    : path.join(PROJECT_ROOT, ".data");
const PROFILE_DIR = process.env.NOCTURNE_USER_DATA_DIR || path.join(DATA_DIR, "profile");
const LOG_DIR = path.join(DATA_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "widget.log");

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
} catch {
  // The app will show a native error if Chromium still cannot use the profile.
}

app.setPath("userData", PROFILE_DIR);

// Test-only override. Ignored during normal desktop launches.
if (process.env.NOCTURNE_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.NOCTURNE_DEBUG_PORT);
}

// NOCTURNE only renders its own localhost page. These switches keep the
// frameless widget usable in managed/remote Windows sessions where Chromium's
// GPU sandbox is unavailable. They are also why the startup shortcut is stable.
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu");
app.disableHardwareAcceleration();

const WINDOW_WIDTH = 432;
const WINDOW_HEIGHT = 748;
const WINDOW_MARGIN = 20;

let mainWindow = null;
let tray = null;
let httpServer = null;
let isPinned = true;
let isQuitting = false;

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // Logging is best-effort.
}

function log(message) {
  try {
    fs.appendFileSync(
      LOG_FILE,
      `${new Date().toISOString()}  ${message}\n`,
      "utf8",
    );
  } catch {
    // A missing log must not prevent the widget from launching.
  }
}

async function isServerHealthy() {
  try {
    const response = await fetch(HEALTH_URL, {
      signal: AbortSignal.timeout(1400),
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await isServerHealthy()) {
    log("Reusing running local server.");
    return true;
  }

  const serverScript = path.join(APP_ROOT, "server.mjs");
  if (!fs.existsSync(serverScript)) {
    log(`Server script missing: ${serverScript}`);
    return false;
  }

  try {
    log("Starting in-process local server.");
    const serverModule = await import(pathToFileURL(serverScript).href);
    httpServer = serverModule.createServer();
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(4173, "127.0.0.1", resolve);
    });
  } catch (error) {
    log(`Unable to start local server: ${error.message}`);
    httpServer = null;
    return false;
  }

  for (let attempt = 0; attempt < 45; attempt += 1) {
    if (await isServerHealthy()) {
      log("Local server is ready.");
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  log("Local server did not become healthy.");
  stopServer();
  return false;
}

function stopServer() {
  if (!httpServer) return;
  try {
    httpServer.close();
    log("Stopped in-process local server.");
  } catch {
    // Ignore if the server is already closed.
  }
  httpServer = null;
}

function registerLoginItem() {
  if (!app.isPackaged || process.platform !== "win32") return;
  if (process.env.NOCTURNE_SKIP_AUTOSTART === "1") return;

  try {
    // Keep the login entry pointing at wherever this copy was installed.
    const command = `"${process.execPath}" --no-sandbox --disable-gpu`;
    execFileSync(
      "reg.exe",
      [
        "add",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        "/v",
        "NOCTURNE",
        "/t",
        "REG_SZ",
        "/d",
        command,
        "/f",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    log(`Autostart registered: ${command}`);
  } catch (error) {
    log(`Autostart registration failed: ${error.message}`);
  }
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (isPinned) mainWindow.setAlwaysOnTop(true, "floating");
}

function createTray() {
  try {
    const image = nativeImage.createFromPath(
      fs.existsSync(TRAY_ICON_PATH) ? TRAY_ICON_PATH : ICON_PATH,
    );
    tray = new Tray(
      image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }),
    );
    tray.setToolTip("NOCTURNE 浮窗");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "显示 NOCTURNE", click: showWindow },
      { label: "隐藏浮窗", click: () => mainWindow?.hide() },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]));
    tray.on("double-click", showWindow);
  } catch (error) {
    log(`Tray creation failed: ${error.message}`);
  }
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const x = Math.max(area.x + 8, area.x + area.width - WINDOW_WIDTH - WINDOW_MARGIN);
  const y = Math.max(area.y + 8, area.y + WINDOW_MARGIN);

  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x,
    y,
    minWidth: WINDOW_WIDTH,
    minHeight: WINDOW_HEIGHT,
    maxWidth: WINDOW_WIDTH,
    maxHeight: WINDOW_HEIGHT,
    frame: false,
    transparent: false,
    backgroundColor: "#07080a",
    show: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    title: "NOCTURNE",
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.loadURL(WIDGET_URL);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
    log("Widget window shown.");
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("http://127.0.0.1:4173/")) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    log(`Page load failed (${code}): ${description}`);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

ipcMain.on("nocturne:hide", () => {
  if (!mainWindow) return;
  if (tray) {
    mainWindow.hide();
  } else {
    // If the tray is unavailable, keep the window recoverable from the taskbar.
    mainWindow.setSkipTaskbar(false);
    mainWindow.minimize();
  }
});

ipcMain.on("nocturne:quit", () => {
  isQuitting = true;
  app.quit();
});

ipcMain.handle("nocturne:is-pinned", () => isPinned);

ipcMain.handle("nocturne:toggle-pin", () => {
  isPinned = !isPinned;
  if (mainWindow) mainWindow.setAlwaysOnTop(isPinned, "floating");
  return isPinned;
});

const hasLock = app.requestSingleInstanceLock();

if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(async () => {
    app.setAppUserModelId("com.nocturne.widget");
    log("Widget starting.");

    const serverReady = await ensureServer();
    if (!serverReady) {
      dialog.showErrorBox(
        "NOCTURNE 无法启动",
        "本地数据服务未能启动。请检查端口 4173 是否被占用，并查看：\n" + LOG_FILE,
      );
      app.quit();
      return;
    }

    registerLoginItem();
    createWindow();
    createTray();
  }).catch((error) => {
    log(`Startup failed: ${error.stack || error.message}`);
    app.quit();
  });

  app.on("activate", showWindow);

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });

  app.on("will-quit", () => {
    if (tray) {
      tray.destroy();
      tray = null;
    }
    stopServer();
    if (isQuitting) log("Widget quitting.");
  });
}
