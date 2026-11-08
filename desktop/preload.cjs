"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nocturneDesktop", Object.freeze({
  isDesktop: true,
  isPinned: () => ipcRenderer.invoke("nocturne:is-pinned"),
  togglePin: () => ipcRenderer.invoke("nocturne:toggle-pin"),
  hide: () => ipcRenderer.send("nocturne:hide"),
  quit: () => ipcRenderer.send("nocturne:quit"),
}));
