/* ------------------------------------------------------------------
   NOCTURNE / compact desktop widget runtime
------------------------------------------------------------------- */

(() => {
  "use strict";

  const config = window.NOCTURNE_CONFIG;
  if (!config) throw new Error("NOCTURNE_CONFIG is missing");

  const TARGET_MS = Date.parse(config.targetISO);
  const STORAGE_KEYS = config.storageKeys;
  const DAY_MS = 86_400_000;
  const HOUR_MS = 3_600_000;
  const MINUTE_MS = 60_000;

  const WEATHER_META = {
    0: { label: "晴朗", kind: "clear" },
    1: { label: "基本晴朗", kind: "partly" },
    2: { label: "局部多云", kind: "partly" },
    3: { label: "阴天", kind: "cloudy" },
    45: { label: "有雾", kind: "fog" },
    48: { label: "雾凇", kind: "fog" },
    51: { label: "毛毛雨", kind: "rain" },
    53: { label: "毛毛雨", kind: "rain" },
    55: { label: "浓密毛毛雨", kind: "rain" },
    56: { label: "冻毛毛雨", kind: "rain" },
    57: { label: "浓冻毛毛雨", kind: "rain" },
    61: { label: "小雨", kind: "rain" },
    63: { label: "中雨", kind: "rain" },
    65: { label: "大雨", kind: "rain" },
    66: { label: "冻雨", kind: "rain" },
    67: { label: "强冻雨", kind: "rain" },
    71: { label: "小雪", kind: "snow" },
    73: { label: "中雪", kind: "snow" },
    75: { label: "大雪", kind: "snow" },
    77: { label: "米雪", kind: "snow" },
    80: { label: "阵雨", kind: "rain" },
    81: { label: "强阵雨", kind: "rain" },
    82: { label: "暴阵雨", kind: "rain" },
    85: { label: "阵雪", kind: "snow" },
    86: { label: "强阵雪", kind: "snow" },
    95: { label: "雷暴", kind: "storm" },
    96: { label: "雷暴伴冰雹", kind: "storm" },
    99: { label: "强雷暴伴冰雹", kind: "storm" },
  };

  const WEATHER_ICON = {
    "clear-day": "i-sun",
    "clear-night": "i-moon",
    partly: "i-cloud-sun",
    cloudy: "i-cloud",
    fog: "i-fog",
    rain: "i-rain",
    snow: "i-snow",
    storm: "i-storm",
  };

  const CURRENCY_SYMBOLS = { CNY: "¥", USD: "$" };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const elements = {
    windowChrome: $("#windowChrome"),
    date: $("#widgetDate"),
    time: $("#widgetTime"),
    days: $("#daysRemaining"),
    hours: $("#hoursRemaining"),
    minutes: $("#minutesRemaining"),
    seconds: $("#secondsRemaining"),
    weatherCard: $("#weatherCard"),
    weatherTemp: $("#weatherTemp"),
    weatherCondition: $("#weatherCondition"),
    weatherIcon: $("#weatherIcon"),
    weatherIconUse: $("#weatherIcon use"),
    weatherRange: $("#weatherRange"),
    weatherHumidity: $("#weatherHumidity"),
    refreshWeather: $("#refreshWeather"),
    balanceCard: $("#balanceCard"),
    balanceAmount: $("#balanceAmount"),
    balanceSub: $("#balanceSub"),
    balanceStatus: $("#balanceStatus"),
    refreshBalance: $("#refreshBalance"),
    openKeyModal: $("#openKeyModal"),
    keyModal: $("#keyModal"),
    keyForm: $("#keyForm"),
    apiKey: $("#apiKey"),
    removeKey: $("#removeKey"),
    agendaOpenCount: $("#agendaOpenCount"),
    taskList: $("#taskList"),
    emptyState: $("#emptyState"),
    openAddModal: $("#openAddModal"),
    addModal: $("#addModal"),
    addForm: $("#addForm"),
    entryTitle: $("#entryTitle"),
    entryDate: $("#entryDate"),
    entryTime: $("#entryTime"),
    submitEntry: $("#submitEntry"),
    toast: $("#toast"),
  };

  const state = {
    tasks: [],
    apiKey: "",
    type: "event",
    weatherLoaded: false,
    balanceLoaded: false,
  };

  let toastTimer = null;
  let weatherInFlight = null;
  let balanceInFlight = null;
  let lastFocused = null;

  /* ----------------------------------------------------------------
     Helpers
  ---------------------------------------------------------------- */

  function storageGet(key, fallback = null) {
    try {
      const value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch {
      showToast("本地存储不可用");
      return false;
    }
  }

  function storageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Ignore unavailable storage.
    }
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function localDateKey(date = new Date()) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function parseDateKey(key) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function friendlyDate(dateKey) {
    const date = parseDateKey(dateKey);
    if (!date) return "未定日期";
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = Math.round((date - today) / DAY_MS);
    if (diff === 0) return "今天";
    if (diff === 1) return "明天";
    if (diff === -1) return "昨天";
    if (diff > 1 && diff < 7) {
      return new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date);
    }
    return date.getFullYear() === now.getFullYear()
      ? `${date.getMonth() + 1}月${date.getDate()}日`
      : `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
  }

  function makeIcon(id) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${id}`);
    svg.append(use);
    return svg;
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 2200);
  }

  function tickClock() {
    const now = new Date();
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" })
      .format(now)
      .toUpperCase();
    elements.date.textContent = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())} / ${weekday}`;
    elements.time.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  function tickCountdown() {
    const remaining = Math.max(0, TARGET_MS - Date.now());
    elements.days.textContent = Math.floor(remaining / DAY_MS).toLocaleString("en-US");
    elements.hours.textContent = pad(Math.floor((remaining % DAY_MS) / HOUR_MS));
    elements.minutes.textContent = pad(Math.floor((remaining % HOUR_MS) / MINUTE_MS));
    elements.seconds.textContent = pad(Math.floor((remaining % MINUTE_MS) / 1000));
  }

  /* ----------------------------------------------------------------
     Modals
  ---------------------------------------------------------------- */

  function openModal(modal) {
    lastFocused = document.activeElement;
    modal.hidden = false;
  }

  function closeModal(modal) {
    modal.hidden = true;
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  }

  function closeAllModals() {
    for (const modal of [elements.addModal, elements.keyModal]) {
      if (!modal.hidden) closeModal(modal);
    }
  }

  function trapModalFocus(event) {
    if (event.key !== "Tab") return;
    const modal = $$(".modal-layer").find((layer) => !layer.hidden);
    if (!modal) return;
    const focusable = $$(
      'button:not([hidden]):not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])',
      modal,
    ).filter((node) => node.offsetParent !== null);
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /* ----------------------------------------------------------------
     Weather
  ---------------------------------------------------------------- */

  function weatherMeta(code, isDay = 1) {
    const meta = WEATHER_META[code] ?? { label: "天气变化中", kind: "cloudy" };
    if (meta.kind === "clear" && !isDay) return { ...meta, icon: WEATHER_ICON["clear-night"] };
    if (meta.kind === "clear") return { ...meta, icon: WEATHER_ICON["clear-day"] };
    return { ...meta, icon: WEATHER_ICON[meta.kind] ?? "i-cloud" };
  }

  function setWeatherError() {
    elements.weatherTemp.textContent = "—";
    elements.weatherCondition.textContent = "天气暂不可用";
    elements.weatherRange.textContent = "稍后重试";
    elements.weatherHumidity.textContent = "湿度 --";
    elements.weatherCard.dataset.state = "error";
  }

  function renderWeather(data) {
    const current = data?.current;
    if (!current || !Number.isFinite(Number(current.temperature_2m))) {
      throw new Error("Incomplete weather payload");
    }

    const meta = weatherMeta(Number(current.weather_code), Number(current.is_day));
    const high = Number(data.daily?.temperature_2m_max?.[0]);
    const low = Number(data.daily?.temperature_2m_min?.[0]);
    const humidity = Number(current.relative_humidity_2m);

    elements.weatherTemp.textContent = String(Math.round(Number(current.temperature_2m)));
    elements.weatherCondition.textContent = meta.label;
    elements.weatherRange.textContent = Number.isFinite(high) && Number.isFinite(low)
      ? `${Math.round(high)}° / ${Math.round(low)}°`
      : "今日温度";
    elements.weatherHumidity.textContent = Number.isFinite(humidity) ? `湿度 ${Math.round(humidity)}%` : "湿度 --";
    elements.weatherIcon.dataset.kind = meta.kind;
    elements.weatherIconUse.setAttribute("href", `#${meta.icon}`);
    elements.weatherCard.dataset.state = "ready";
    state.weatherLoaded = true;
  }

  async function loadWeather({ manual = false } = {}) {
    if (weatherInFlight) return weatherInFlight;

    elements.refreshWeather.classList.add("is-spinning");
    if (!state.weatherLoaded) {
      elements.weatherTemp.textContent = "--";
      elements.weatherCondition.textContent = "正在同步";
      elements.weatherCard.dataset.state = "loading";
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);

    weatherInFlight = (async () => {
      try {
        const response = await fetch(config.weatherUrl, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`Weather HTTP ${response.status}`);
        renderWeather(await response.json());
        if (manual) showToast("天气已更新");
      } catch {
        if (!state.weatherLoaded) setWeatherError();
        if (manual) showToast("天气刷新失败");
      } finally {
        window.clearTimeout(timeout);
        weatherInFlight = null;
        elements.refreshWeather.classList.remove("is-spinning");
      }
    })();

    return weatherInFlight;
  }

  /* ----------------------------------------------------------------
     DeepSeek balance
  ---------------------------------------------------------------- */

  function setBalanceState(mode, statusText) {
    elements.balanceCard.dataset.state = mode;
    if (statusText) setBalanceStatus(statusText);
  }

  function setBalanceStatus(text) {
    const dot = document.createElement("span");
    elements.balanceStatus.replaceChildren(dot, document.createTextNode(text));
  }

  function setBalanceAmount(text, small = false) {
    elements.balanceAmount.textContent = text;
    elements.balanceAmount.classList.toggle("is-small", small);
  }

  function showBalanceEmpty() {
    setBalanceAmount("未连接", true);
    elements.balanceSub.textContent = "本地密钥 · 仅本机";
    setBalanceState("empty", "未配置");
    elements.openKeyModal.textContent = "配置";
  }

  function formatMoney(value, symbol) {
    const number = Number(value);
    if (!Number.isFinite(number)) return `${symbol}--`;
    return `${symbol}${number.toLocaleString("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  function renderBalance(payload) {
    const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
    const info = infos.find((item) => item?.currency === "CNY") || infos[0];
    if (!info) throw new Error("No balance information");

    const currency = String(info.currency || "CNY").toUpperCase();
    const symbol = CURRENCY_SYMBOLS[currency] || "";
    const amount = Number(info.total_balance);
    if (!Number.isFinite(amount)) throw new Error("Invalid balance");

    setBalanceAmount(formatMoney(amount, symbol));
    elements.balanceSub.textContent = `可用余额 · ${currency}`;
    elements.balanceCard.title = `赠送 ${formatMoney(info.granted_balance, symbol)} · 充值 ${formatMoney(info.topped_up_balance, symbol)}`;
    elements.openKeyModal.textContent = "设置";
    setBalanceState(payload.is_available === false ? "error" : "ready", payload.is_available === false ? "不可用" : "已连接");
    state.balanceLoaded = true;
  }

  function renderBalanceError(error) {
    const authError = error?.status === 401 || error?.status === 403;
    setBalanceAmount(authError ? "密钥无效" : "读取失败", true);
    elements.balanceSub.textContent = authError ? "请在配置中更换密钥" : "检查网络连接后重试";
    setBalanceState("error", authError ? "需要密钥" : "暂不可用");
    elements.openKeyModal.textContent = "设置";
    elements.balanceCard.title = error?.message || "余额读取失败";
  }

  async function loadBalance({ manual = false } = {}) {
    if (!state.apiKey) {
      showBalanceEmpty();
      return;
    }
    if (balanceInFlight) return balanceInFlight;

    setBalanceState("loading", "读取中");
    elements.balanceSub.textContent = "正在读取账户余额";
    elements.openKeyModal.textContent = "设置";
    if (!state.balanceLoaded) setBalanceAmount("—");

    balanceInFlight = (async () => {
      try {
        const response = await fetch("/api/deepseek/balance", {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${state.apiKey}`,
          },
          cache: "no-store",
        });

        let payload = null;
        try {
          payload = await response.json();
        } catch {
          // Keep payload null and surface a readable error.
        }

        if (!response.ok) {
          const error = new Error(response.status === 401 ? "密钥无效" : "余额服务暂不可用");
          error.status = response.status;
          throw error;
        }
        renderBalance(payload);
        if (manual) showToast("余额已更新");
      } catch (error) {
        renderBalanceError(error);
        if (manual) showToast("余额刷新失败");
      } finally {
        balanceInFlight = null;
      }
    })();

    return balanceInFlight;
  }

  function openKeySettings() {
    elements.apiKey.value = "";
    elements.removeKey.hidden = !Boolean(state.apiKey);
    openModal(elements.keyModal);
    window.setTimeout(() => elements.apiKey.focus(), 60);
  }

  function saveKey(event) {
    event.preventDefault();
    const key = elements.apiKey.value.trim();
    if (key.length < 8) {
      elements.apiKey.setCustomValidity("请输入有效的 DeepSeek API Key");
      elements.apiKey.reportValidity();
      elements.apiKey.setCustomValidity("");
      return;
    }

    state.apiKey = key;
    state.balanceLoaded = false;
    storageSet(STORAGE_KEYS.apiKey, key);
    closeModal(elements.keyModal);
    showToast("密钥已保存在本机");
    loadBalance();
  }

  function removeKey() {
    state.apiKey = "";
    state.balanceLoaded = false;
    storageRemove(STORAGE_KEYS.apiKey);
    closeModal(elements.keyModal);
    showBalanceEmpty();
    showToast("已移除本地密钥");
  }

  function initializeBalance() {
    state.apiKey = storageGet(STORAGE_KEYS.apiKey, "") || "";
    if (!state.apiKey) {
      showBalanceEmpty();
      return;
    }
    elements.openKeyModal.textContent = "设置";
    setBalanceAmount("—");
    elements.balanceSub.textContent = "正在读取账户余额";
    setBalanceState("loading", "读取中");
    loadBalance();
  }

  /* ----------------------------------------------------------------
     Agenda
  ---------------------------------------------------------------- */

  function normalizeTask(raw) {
    if (!raw || typeof raw !== "object") return null;
    const title = String(raw.title || "").trim().slice(0, 80);
    if (!title) return null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw.date) && parseDateKey(raw.date)
      ? raw.date
      : localDateKey();
    const time = /^\d{2}:\d{2}$/.test(raw.time || "") ? raw.time : "";
    const type = raw.type === "task" ? "task" : "event";
    return {
      id: String(raw.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      title,
      type,
      date,
      time,
      done: type === "task" ? Boolean(raw.done) : false,
      createdAt: Number(raw.createdAt) || Date.now(),
    };
  }

  function loadTasks() {
    try {
      const raw = storageGet(STORAGE_KEYS.tasks, "[]");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(normalizeTask).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function saveTasks() {
    storageSet(STORAGE_KEYS.tasks, JSON.stringify(state.tasks));
  }

  function sortKey(task) {
    return `${task.date}T${task.time || "23:59"}`;
  }

  function sortedTasks() {
    return state.tasks.slice().sort((a, b) => {
      if (a.done !== b.done) return Number(a.done) - Number(b.done);
      return sortKey(a).localeCompare(sortKey(b)) || a.createdAt - b.createdAt;
    });
  }

  function createRow(task, index) {
    const row = document.createElement("li");
    row.className = `agenda-row agenda-row--${task.type}${task.done ? " is-done" : ""}`;
    row.dataset.id = task.id;
    row.style.animationDelay = `${Math.min(index * 24, 120)}ms`;

    let marker;
    if (task.type === "task") {
      marker = document.createElement("button");
      marker.type = "button";
      marker.className = "agenda-row__marker";
      marker.dataset.action = "toggle";
      marker.setAttribute("aria-pressed", String(task.done));
      marker.setAttribute("aria-label", task.done ? `恢复「${task.title}」` : `完成「${task.title}」`);
      if (task.done) marker.append(makeIcon("i-check"));
    } else {
      marker = document.createElement("span");
      marker.className = "agenda-row__marker";
      marker.setAttribute("aria-hidden", "true");
      const dot = document.createElement("span");
      marker.append(dot);
    }

    const body = document.createElement("div");
    body.className = "agenda-row__body";
    const title = document.createElement("div");
    title.className = "agenda-row__title";
    title.textContent = task.title;
    title.title = task.title;
    const meta = document.createElement("div");
    meta.className = "agenda-row__meta";
    const typeLabel = document.createElement("span");
    typeLabel.textContent = task.type === "task" ? "任务" : "日程";
    meta.append(typeLabel);
    body.append(title, meta);

    const when = document.createElement("div");
    when.className = "agenda-row__when";
    const time = document.createElement("strong");
    time.textContent = task.time || "全天";
    const date = document.createElement("span");
    date.textContent = friendlyDate(task.date);
    when.append(time, date);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "agenda-row__delete";
    remove.dataset.action = "delete";
    remove.setAttribute("aria-label", `删除「${task.title}」`);
    remove.title = "删除";
    remove.append(makeIcon("i-trash"));

    row.append(marker, body, when, remove);
    return row;
  }

  function renderTasks() {
    const tasks = sortedTasks();
    elements.taskList.replaceChildren(...tasks.map(createRow));
    elements.emptyState.hidden = tasks.length > 0;
    elements.taskList.hidden = tasks.length === 0;

    const open = state.tasks.filter((task) => !task.done).length;
    elements.agendaOpenCount.textContent = `${open} OPEN`;
  }

  function refreshOpenState() {
    renderTasks();
  }

  function openAdd() {
    state.type = "event";
    $$(".type-switch__button", elements.addForm).forEach((button) => {
      const active = button.dataset.type === "event";
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    elements.entryTitle.value = "";
    elements.entryTime.value = "";
    elements.entryDate.value = localDateKey();
    elements.submitEntry.textContent = "添加到日程";
    openModal(elements.addModal);
    window.setTimeout(() => elements.entryTitle.focus(), 60);
  }

  function setType(type) {
    state.type = type;
    $$(".type-switch__button", elements.addForm).forEach((button) => {
      const active = button.dataset.type === type;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    elements.submitEntry.textContent = type === "task" ? "添加任务" : "添加到日程";
  }

  function addTask(event) {
    event.preventDefault();
    const title = elements.entryTitle.value.trim();
    if (!title) {
      elements.entryTitle.setCustomValidity("请填写标题");
      elements.entryTitle.reportValidity();
      elements.entryTitle.setCustomValidity("");
      elements.entryTitle.focus();
      return;
    }

    if (!elements.entryDate.value) elements.entryDate.value = localDateKey();

    const task = normalizeTask({
      id: typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      type: state.type,
      date: elements.entryDate.value,
      time: elements.entryTime.value,
      createdAt: Date.now(),
    });
    if (!task) return;

    state.tasks.push(task);
    saveTasks();
    renderTasks();
    closeModal(elements.addModal);
    showToast(task.type === "task" ? "任务已添加" : "日程已添加");
  }

  function handleAgendaClick(event) {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    const row = action.closest(".agenda-row");
    if (!row) return;
    const task = state.tasks.find((item) => item.id === row.dataset.id);
    if (!task) return;

    if (action.dataset.action === "toggle" && task.type === "task") {
      task.done = !task.done;
      saveTasks();
      renderTasks();
      showToast(task.done ? "任务已完成" : "已恢复为待办");
      return;
    }

    if (action.dataset.action === "delete") {
      state.tasks = state.tasks.filter((item) => item.id !== task.id);
      saveTasks();
      renderTasks();
      showToast(task.type === "task" ? "任务已删除" : "日程已删除");
    }
  }

  /* ----------------------------------------------------------------
     Desktop window controls (Electron preload)
  ---------------------------------------------------------------- */

  function initDesktopChrome() {
    const desktop = window.nocturneDesktop;
    if (!desktop?.isDesktop) return;

    elements.windowChrome.hidden = false;
    document.body.classList.add("is-desktop");

    const pinButton = $('[data-window-action="pin"]', elements.windowChrome);
    const hideButton = $('[data-window-action="hide"]', elements.windowChrome);
    const quitButton = $('[data-window-action="quit"]', elements.windowChrome);

    const paintPin = (pinned) => {
      pinButton.classList.toggle("is-active", Boolean(pinned));
      const label = pinned ? "取消置顶" : "置顶窗口";
      pinButton.setAttribute("aria-label", label);
      pinButton.title = label;
    };

    Promise.resolve(desktop.isPinned())
      .then(paintPin)
      .catch(() => paintPin(true));

    pinButton.addEventListener("click", async () => {
      try {
        paintPin(await desktop.togglePin());
      } catch {
        showToast("无法切换窗口置顶");
      }
    });
    hideButton.addEventListener("click", () => desktop.hide());
    quitButton.addEventListener("click", () => desktop.quit());
  }

  /* ----------------------------------------------------------------
     Events & boot
  ---------------------------------------------------------------- */

  function bindEvents() {
    elements.refreshWeather.addEventListener("click", () => loadWeather({ manual: true }));
    elements.refreshBalance.addEventListener("click", () => {
      if (state.apiKey) loadBalance({ manual: true });
      else openKeySettings();
    });
    elements.openKeyModal.addEventListener("click", openKeySettings);
    elements.keyForm.addEventListener("submit", saveKey);
    elements.removeKey.addEventListener("click", removeKey);
    elements.apiKey.addEventListener("input", () => elements.apiKey.setCustomValidity(""));

    elements.openAddModal.addEventListener("click", openAdd);
    elements.addForm.addEventListener("submit", addTask);
    $$(".type-switch__button", elements.addForm).forEach((button) => {
      button.addEventListener("click", () => setType(button.dataset.type));
    });
    elements.taskList.addEventListener("click", handleAgendaClick);

    $$("[data-close]").forEach((button) => {
      button.addEventListener("click", () => {
        const modal = document.getElementById(button.dataset.close);
        if (modal) closeModal(modal);
      });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeAllModals();
        return;
      }
      trapModalFocus(event);
    });
  }

  function init() {
    state.tasks = loadTasks();
    renderTasks();
    initializeBalance();
    bindEvents();
    initDesktopChrome();

    tickClock();
    tickCountdown();
    window.setInterval(() => {
      tickClock();
      tickCountdown();
    }, 1000);

    loadWeather();

    window.__NOCTURNE_WIDGET__ = Object.freeze({
      targetISO: config.targetISO,
      storageKeys: STORAGE_KEYS,
      getTasks: () => state.tasks.map((task) => ({ ...task })),
      loadWeather,
      loadBalance,
    });
  }

  init();
})();
