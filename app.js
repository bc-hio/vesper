/* ------------------------------------------------------------------
   NOCTURNE / app.js
   Live countdown, weather, DeepSeek credit and local-first agenda.
------------------------------------------------------------------- */

(() => {
  "use strict";

  const DAY_MS = 86_400_000;
  const HOUR_MS = 3_600_000;
  const MINUTE_MS = 60_000;

  const config = window.NOCTURNE_CONFIG;
  if (!config) throw new Error("NOCTURNE_CONFIG is missing");

  const TARGET_ISO = config.targetISO;
  const TARGET_MS = Date.parse(TARGET_ISO);
  const STORAGE_KEYS = config.storageKeys;
  const WEATHER_URL = config.weatherUrl;

  const WEATHER_META = {
    0: { label: "晴朗", kind: "clear" },
    1: { label: "基本晴朗", kind: "partly" },
    2: { label: "局部多云", kind: "partly" },
    3: { label: "阴天", kind: "cloudy" },
    45: { label: "有雾", kind: "fog" },
    48: { label: "雾凇", kind: "fog" },
    51: { label: "轻微毛毛雨", kind: "rain" },
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

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const elements = {
    headerDate: $("#headerDate"),
    headerTime: $("#headerTime"),
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
    weatherWind: $("#weatherWind"),
    weatherFeels: $("#weatherFeels"),
    weatherUpdated: $("#weatherUpdated"),
    refreshWeather: $("#refreshWeather"),
    balanceCard: $("#balanceCard"),
    balanceStatus: $("#balanceStatus"),
    balanceSetup: $("#balanceSetup"),
    balanceData: $("#balanceData"),
    balanceAmount: $("#balanceAmount"),
    balanceCurrency: $("#balanceCurrency"),
    balanceCurrencyCode: $("#balanceCurrencyCode"),
    balanceGranted: $("#balanceGranted"),
    balanceTopped: $("#balanceTopped"),
    balanceUpdated: $("#balanceUpdated"),
    balanceAlert: $("#balanceAlert"),
    balanceAlertText: $("#balanceAlertText"),
    keyForm: $("#keyForm"),
    apiKey: $("#apiKey"),
    refreshBalance: $("#refreshBalance"),
    changeKey: $("#changeKey"),
    taskForm: $("#taskForm"),
    taskTitle: $("#taskTitle"),
    taskDate: $("#taskDate"),
    taskTime: $("#taskTime"),
    addTaskButton: $("#addTaskButton"),
    taskList: $("#taskList"),
    emptyState: $("#emptyState"),
    agendaSummary: $("#agendaSummary"),
    listSummary: $("#listSummary"),
    agendaFilter: $("#agendaFilter"),
    toast: $("#toast"),
  };

  const state = {
    tasks: [],
    filter: "all",
    type: "event",
    apiKey: "",
    weatherLoaded: false,
    balanceLoaded: false,
    adding: false,
  };

  let toastTimer = null;
  let weatherInFlight = null;
  let balanceInFlight = null;

  /* ----------------------------------------------------------------
     Storage
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
      showToast("本地存储不可用，数据未能保存");
      return false;
    }
  }

  function storageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Nothing else to do when storage is unavailable.
    }
  }

  /* ----------------------------------------------------------------
     Time helpers
  ---------------------------------------------------------------- */

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
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const diff = Math.round((date - todayStart) / DAY_MS);
    if (diff === 0) return "今天";
    if (diff === 1) return "明天";
    if (diff === -1) return "昨天";
    if (diff > 1 && diff < 7) {
      return new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date);
    }
    const sameYear = date.getFullYear() === today.getFullYear();
    return sameYear
      ? `${date.getMonth() + 1}月${date.getDate()}日`
      : `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
  }

  function tickClock() {
    const now = new Date();
    const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(now);
    elements.headerDate.textContent = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())} / ${weekday}`;
    elements.headerTime.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  function tickCountdown() {
    const diff = TARGET_MS - Date.now();
    const remaining = Math.max(0, diff);
    const days = Math.floor(remaining / DAY_MS);
    const hours = Math.floor((remaining % DAY_MS) / HOUR_MS);
    const minutes = Math.floor((remaining % HOUR_MS) / MINUTE_MS);
    const seconds = Math.floor((remaining % MINUTE_MS) / 1000);

    elements.days.textContent = diff > 0 ? days.toLocaleString("en-US") : "0";
    elements.hours.textContent = pad(hours);
    elements.minutes.textContent = pad(minutes);
    elements.seconds.textContent = pad(seconds);
  }

  /* ----------------------------------------------------------------
     Toasts & icons
  ---------------------------------------------------------------- */

  function showToast(message) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => {
      elements.toast.classList.remove("is-visible");
    }, 2600);
  }

  function makeIcon(id, className = "icon") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${id}`);
    svg.append(use);
    return svg;
  }

  /* ----------------------------------------------------------------
     Weather
  ---------------------------------------------------------------- */

  function weatherMeta(code, isDay = 1) {
    const meta = WEATHER_META[code] ?? { label: "天气变化中", kind: "cloudy" };
    if (meta.kind === "clear" && !isDay) {
      return { ...meta, icon: WEATHER_ICON["clear-night"] };
    }
    if (meta.kind === "clear") {
      return { ...meta, icon: WEATHER_ICON["clear-day"] };
    }
    return { ...meta, icon: WEATHER_ICON[meta.kind] ?? "i-cloud" };
  }

  function setWeatherState(mode, label) {
    elements.weatherCard.dataset.state = mode;
    if (label) elements.weatherUpdated.textContent = label;
  }

  function renderWeather(data) {
    const current = data?.current;
    if (!current || !Number.isFinite(Number(current.temperature_2m))) {
      throw new Error("Weather payload is incomplete");
    }

    const meta = weatherMeta(Number(current.weather_code), Number(current.is_day));
    const high = Number(data.daily?.temperature_2m_max?.[0]);
    const low = Number(data.daily?.temperature_2m_min?.[0]);
    const temp = Math.round(Number(current.temperature_2m));
    const feels = Math.round(Number(current.apparent_temperature));
    const wind = Math.round(Number(current.wind_speed_10m));
    const humidity = Math.round(Number(current.relative_humidity_2m));

    elements.weatherTemp.textContent = String(temp);
    elements.weatherCondition.textContent = meta.label;
    elements.weatherRange.textContent = Number.isFinite(high) && Number.isFinite(low)
      ? `最高 ${Math.round(high)}° / 最低 ${Math.round(low)}°`
      : "今日温度";
    elements.weatherHumidity.textContent = Number.isFinite(humidity) ? `${humidity}%` : "--%";
    elements.weatherWind.textContent = Number.isFinite(wind) ? `${wind} km/h` : "-- km/h";
    elements.weatherFeels.textContent = Number.isFinite(feels) ? `${feels}°` : "--°";
    elements.weatherIcon.dataset.kind = meta.kind;
    elements.weatherIconUse.setAttribute("href", `#${meta.icon}`);

    const localTime = String(current.time || "").split("T")[1]?.slice(0, 5);
    setWeatherState("ready", localTime ? `${localTime} 更新` : "刚刚更新");
    state.weatherLoaded = true;
  }

  function weatherError(message) {
    elements.weatherTemp.textContent = "—";
    elements.weatherCondition.textContent = "天气暂不可用";
    elements.weatherRange.textContent = "请稍后重试";
    setWeatherState("error", "同步失败");
    if (message) console.warn("[Nocturne] weather:", message);
  }

  async function loadWeather({ manual = false } = {}) {
    if (weatherInFlight) return weatherInFlight;

    elements.refreshWeather.classList.add("is-spinning");
    if (!state.weatherLoaded) {
      setWeatherState("loading", "正在同步");
      elements.weatherCondition.textContent = "正在获取天气";
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);

    weatherInFlight = (async () => {
      try {
        const response = await fetch(WEATHER_URL, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
        renderWeather(await response.json());
        if (manual) showToast("天气已更新");
      } catch (error) {
        if (state.weatherLoaded) {
          setWeatherState("error", "更新失败");
          showToast("天气刷新失败，已保留上次数据");
        } else {
          weatherError(error?.message);
          if (manual) showToast("天气获取失败，请检查网络后重试");
        }
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

  const CURRENCY_SYMBOLS = { CNY: "¥", USD: "$" };

  function setBalanceState(mode, statusText) {
    elements.balanceCard.dataset.state = mode;
    if (statusText) setBalanceStatusText(statusText);
  }

  function setBalanceStatusText(text) {
    const dot = document.createElement("span");
    elements.balanceStatus.replaceChildren(dot, document.createTextNode(text));
  }

  function showBalanceData() {
    elements.balanceSetup.hidden = true;
    elements.balanceData.hidden = false;
  }

  function showBalanceSetup() {
    elements.balanceData.hidden = true;
    elements.balanceSetup.hidden = false;
    elements.apiKey.value = "";
    elements.balanceAlert.hidden = true;
    setBalanceState("empty", "未连接");
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

    if (!info) {
      throw new Error("该账户暂未返回余额信息");
    }

    const currency = String(info.currency || "CNY").toUpperCase();
    const symbol = CURRENCY_SYMBOLS[currency] || "";
    const amount = Number(info.total_balance);
    if (!Number.isFinite(amount)) throw new Error("余额数据格式异常");

    elements.balanceCurrency.textContent = symbol;
    elements.balanceCurrencyCode.textContent = currency;
    elements.balanceAmount.textContent = amount.toLocaleString("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    elements.balanceGranted.textContent = formatMoney(info.granted_balance, symbol);
    elements.balanceTopped.textContent = formatMoney(info.topped_up_balance, symbol);
    elements.balanceUpdated.textContent = `${new Date().toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })} 更新`;
    elements.balanceAlert.hidden = true;

    const available = payload.is_available !== false;
    setBalanceState("ready", available ? "已连接" : "服务不可用");
    state.balanceLoaded = true;
  }

  function balanceError(error) {
    const code = error?.code;
    const message = code === "auth"
      ? "密钥无效或已过期，请更换密钥"
      : code === "rate"
        ? "请求过于频繁，请稍后重试"
        : error?.message || "余额读取失败，请稍后重试";
    elements.balanceAlertText.textContent = message;
    elements.balanceAlert.hidden = false;
    elements.balanceAmount.textContent = "--";
    setBalanceState("error", code === "auth" ? "密钥无效" : "读取失败");
  }

  async function fetchBalance(key) {
    let response;
    try {
      response = await fetch("/api/deepseek/balance", {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${key}`,
        },
        cache: "no-store",
      });
    } catch {
      const error = new Error("无法连接余额代理，请通过本地服务打开页面");
      error.code = "network";
      throw error;
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // Upstream could return an empty body or plain text.
    }

    if (!response.ok) {
      const error = new Error(
        response.status === 401
          ? "密钥无效或已过期"
          : response.status === 429
            ? "请求过于频繁"
            : "余额服务暂时不可用",
      );
      error.code = response.status === 401 || response.status === 403
        ? "auth"
        : response.status === 429
          ? "rate"
          : "upstream";
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  async function loadBalance({ manual = false } = {}) {
    if (!state.apiKey) {
      showBalanceSetup();
      return;
    }
    if (balanceInFlight) return balanceInFlight;

    showBalanceData();
    elements.balanceAlert.hidden = true;
    setBalanceState("loading", "同步中");
    if (!state.balanceLoaded) elements.balanceAmount.textContent = "--";
    elements.refreshBalance.classList.add("is-spinning");

    balanceInFlight = (async () => {
      try {
        const payload = await fetchBalance(state.apiKey);
        renderBalance(payload);
        if (manual) showToast("余额已更新");
      } catch (error) {
        balanceError(error);
        if (manual) showToast("余额刷新失败");
      } finally {
        balanceInFlight = null;
        elements.refreshBalance.classList.remove("is-spinning");
      }
    })();

    return balanceInFlight;
  }

  function initializeBalance() {
    state.apiKey = storageGet(STORAGE_KEYS.apiKey, "") || "";
    if (!state.apiKey) {
      showBalanceSetup();
      return;
    }
    showBalanceData();
    loadBalance();
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
    showBalanceData();
    loadBalance();
  }

  function beginKeyChange() {
    state.apiKey = "";
    state.balanceLoaded = false;
    storageRemove(STORAGE_KEYS.apiKey);
    showBalanceSetup();
    elements.apiKey.focus();
    showToast("已移除本地密钥");
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
    const raw = storageGet(STORAGE_KEYS.tasks, "[]");
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeTask).filter(Boolean);
    } catch {
      return [];
    }
  }

  function saveTasks() {
    storageSet(STORAGE_KEYS.tasks, JSON.stringify(state.tasks));
  }

  function taskSortKey(task) {
    return `${task.date}T${task.time || "23:59"}`;
  }

  function visibleTasks() {
    const filtered = state.filter === "all"
      ? state.tasks
      : state.tasks.filter((task) => task.type === state.filter);
    return filtered.slice().sort((a, b) => {
      if (a.done !== b.done) return Number(a.done) - Number(b.done);
      return taskSortKey(a).localeCompare(taskSortKey(b)) || a.createdAt - b.createdAt;
    });
  }

  function updateAgendaSummary() {
    const active = state.tasks.filter((task) => !task.done).length;
    const today = localDateKey();
    const todayCount = state.tasks.filter((task) => task.date === today && !task.done).length;

    if (!state.tasks.length) {
      elements.agendaSummary.textContent = "今天没有安排";
    } else {
      elements.agendaSummary.textContent = `${active} 项待办 · 今日 ${todayCount}`;
    }

    const visible = visibleTasks();
    elements.listSummary.textContent = visible.length
      ? `${visible.length} ITEMS · ${visible.filter((task) => !task.done).length} OPEN`
      : "0 ITEMS";
  }

  function createEntry(task, index) {
    const item = document.createElement("li");
    item.className = `entry entry--${task.type}${task.done ? " is-done" : ""}`;
    item.dataset.id = task.id;
    item.style.animationDelay = `${Math.min(index * 28, 140)}ms`;

    const marker = document.createElement(task.type === "task" ? "button" : "span");
    marker.className = "entry__marker";
    if (task.type === "task") {
      marker.type = "button";
      marker.dataset.action = "toggle";
      marker.setAttribute(
        "aria-label",
        task.done ? `将「${task.title}」标记为未完成` : `完成「${task.title}」`,
      );
      marker.setAttribute("aria-pressed", String(task.done));
      if (task.done) marker.append(makeIcon("i-check"));
    } else {
      marker.setAttribute("aria-hidden", "true");
      marker.append(makeIcon("i-calendar"));
    }

    const body = document.createElement("div");
    body.className = "entry__body";

    const title = document.createElement("div");
    title.className = "entry__title";
    title.textContent = task.title;
    title.title = task.title;

    const meta = document.createElement("div");
    meta.className = "entry__meta";

    const typeLabel = document.createElement("span");
    typeLabel.className = "entry__type";
    typeLabel.textContent = task.type === "task"
      ? task.done ? "任务 · 已完成" : "任务"
      : "日程";
    meta.append(typeLabel);
    body.append(title, meta);

    const when = document.createElement("div");
    when.className = "entry__when";
    const whenDate = document.createElement("span");
    whenDate.textContent = friendlyDate(task.date);
    const whenTime = document.createElement("strong");
    whenTime.textContent = task.time || "全天";
    when.append(whenDate, whenTime);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "entry__delete";
    remove.dataset.action = "delete";
    remove.setAttribute("aria-label", `删除「${task.title}」`);
    remove.title = "删除";
    remove.append(makeIcon("i-trash"));

    item.append(marker, body, when, remove);
    return item;
  }

  function renderTasks() {
    const visible = visibleTasks();
    elements.taskList.replaceChildren(...visible.map(createEntry));
    elements.taskList.hidden = visible.length === 0;
    elements.emptyState.hidden = visible.length > 0;

    if (!state.tasks.length) {
      $("p", elements.emptyState).textContent = "日程清空，享受留白";
      $("span:last-child", elements.emptyState).textContent = "从左侧添加第一条安排";
    } else if (!visible.length) {
      $("p", elements.emptyState).textContent = "此分类暂无内容";
      $("span:last-child", elements.emptyState).textContent = "切换筛选，或添加一条新安排";
    }
    updateAgendaSummary();
  }

  function setFilter(filter) {
    state.filter = filter;
    $$(".filter__button", elements.agendaFilter).forEach((button) => {
      const active = button.dataset.filter === filter;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    renderTasks();
  }

  function setType(type) {
    state.type = type;
    $$(".type-button", elements.taskForm).forEach((button) => {
      const active = button.dataset.type === type;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const label = $("span", elements.addTaskButton);
    if (label) label.textContent = type === "task" ? "添加任务" : "添加日程";
  }

  function addTask(event) {
    event.preventDefault();
    if (state.adding) return;

    const title = elements.taskTitle.value.trim();
    if (!title) {
      elements.taskTitle.setCustomValidity("请填写标题");
      elements.taskTitle.reportValidity();
      elements.taskTitle.setCustomValidity("");
      elements.taskTitle.focus();
      return;
    }

    if (!elements.taskDate.value) {
      elements.taskDate.value = localDateKey();
    }

    const task = normalizeTask({
      id: typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      title,
      type: state.type,
      date: elements.taskDate.value,
      time: elements.taskTime.value,
      createdAt: Date.now(),
    });
    if (!task) return;

    state.adding = true;
    state.tasks.push(task);
    saveTasks();

    if (state.filter !== "all" && state.filter !== task.type) setFilter("all");
    else renderTasks();

    elements.taskTitle.value = "";
    elements.taskTime.value = "";
    elements.taskDate.value = task.date;
    elements.taskTitle.focus();
    showToast(task.type === "task" ? "任务已添加" : "日程已添加");

    elements.addTaskButton.classList.add("is-success");
    window.setTimeout(() => elements.addTaskButton.classList.remove("is-success"), 420);
    state.adding = false;
  }

  function handleAgendaAction(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const item = button.closest(".entry");
    if (!item) return;
    const task = state.tasks.find((entry) => entry.id === item.dataset.id);
    if (!task) return;

    if (button.dataset.action === "toggle" && task.type === "task") {
      task.done = !task.done;
      saveTasks();
      renderTasks();
      showToast(task.done ? "任务已完成" : "已恢复为待办");
      return;
    }

    if (button.dataset.action === "delete") {
      state.tasks = state.tasks.filter((entry) => entry.id !== task.id);
      saveTasks();
      renderTasks();
      showToast(task.type === "task" ? "任务已删除" : "日程已删除");
    }
  }

  /* ----------------------------------------------------------------
     Event wiring
  ---------------------------------------------------------------- */

  function bindEvents() {
    elements.refreshWeather.addEventListener("click", () => loadWeather({ manual: true }));

    elements.keyForm.addEventListener("submit", saveKey);
    elements.refreshBalance.addEventListener("click", () => loadBalance({ manual: true }));
    elements.changeKey.addEventListener("click", beginKeyChange);
    elements.apiKey.addEventListener("input", () => elements.apiKey.setCustomValidity(""));

    elements.taskForm.addEventListener("submit", addTask);
    $$(".type-button", elements.taskForm).forEach((button) => {
      button.addEventListener("click", () => setType(button.dataset.type));
    });
    elements.agendaFilter.addEventListener("click", (event) => {
      const button = event.target.closest(".filter__button");
      if (button) setFilter(button.dataset.filter);
    });
    elements.taskList.addEventListener("click", handleAgendaAction);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        tickClock();
        tickCountdown();
      }
    });
  }

  function init() {
    state.tasks = loadTasks();
    elements.taskDate.value = localDateKey();
    setType("event");
    renderTasks();
    initializeBalance();
    bindEvents();

    tickClock();
    tickCountdown();
    window.setInterval(() => {
      tickClock();
      tickCountdown();
    }, 1000);

    loadWeather();

    // A tiny read-only debug surface for local smoke tests.
    window.__NOCTURNE__ = Object.freeze({
      targetISO: TARGET_ISO,
      storageKeys: STORAGE_KEYS,
      getTasks: () => state.tasks.map((task) => ({ ...task })),
      getFilter: () => state.filter,
      loadWeather,
      loadBalance,
    });
  }

  init();
})();
