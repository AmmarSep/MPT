const STORAGE_KEY = "masjid-prayer-times";
const PRAYERS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_SUNRISE_TIME = "06:00";
const UPCOMING_REFRESH_INTERVAL_MS = 30000;

const defaultData = [
  {
    name: "Thaqwa Masjid",
    prayers: {
      Fajr: "05:30",
      Dhuhr: "13:15",
      Asr: "16:45",
      Maghrib: "18:20",
      Isha: "19:45"
    }
  },
  {
    name: "Masjid B1",
    prayers: {
      Fajr: "05:40",
      Dhuhr: "13:10",
      Asr: "16:35",
      Maghrib: "18:15",
      Isha: "19:35"
    }
  },
  {
    name: "Masjid B2",
    prayers: {
      Fajr: "05:35",
      Dhuhr: "13:20",
      Asr: "16:50",
      Maghrib: "18:25",
      Isha: "19:50"
    }
  }
];

const APP_CONFIG = window.MPT_CONFIG || {};
const CLOUD = {
  url: String(APP_CONFIG.supabaseUrl || "").replace(/\/+$/, ""),
  anonKey: String(APP_CONFIG.supabaseAnonKey || ""),
  table: String(APP_CONFIG.supabaseTable || "prayer_timings"),
  recordId: String(APP_CONFIG.supabaseRecordId || "main")
};

const CLOUD_SYNC_ENABLED = Boolean(CLOUD.url && CLOUD.anonKey);
const IS_IOS_STANDALONE = detectIosStandalone();

let state = [];
let sunriseTime = DEFAULT_SUNRISE_TIME;
let syncTimerId = null;
let syncInFlight = false;
let pendingSnapshot = null;
let lastRemoteSyncedSnapshot = "";
let lastPersistedSnapshot = "";
let upcomingRefreshTimerId = null;

function detectIosStandalone() {
  const userAgent = navigator.userAgent || "";
  const isiOSDevice =
    /iPad|iPhone|iPod/.test(userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standaloneMode = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
  return isiOSDevice && (standaloneMode || window.navigator.standalone === true);
}

function parseTimeValue(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  const normalizedAmPm = trimmed.toUpperCase();

  const amPmMatch = normalizedAmPm.match(/^(\d{1,2}):(\d{2})(?:\s)?(AM|PM)$/);
  if (amPmMatch) {
    let hours = Number(amPmMatch[1]);
    const minutes = Number(amPmMatch[2]);
    const suffix = amPmMatch[3];

    if (hours >= 1 && hours <= 12 && minutes >= 0 && minutes <= 59) {
      if (suffix === "AM" && hours === 12) {
        hours = 0;
      } else if (suffix === "PM" && hours !== 12) {
        hours += 12;
      }

      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    }
  }

  const withSecondsMatch = trimmed.match(/^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/);
  if (withSecondsMatch) {
    return `${withSecondsMatch[1]}:${withSecondsMatch[2]}`;
  }

  if (TIME_PATTERN.test(trimmed)) {
    return trimmed;
  }

  const digits = trimmed.replace(/\D/g, "").slice(0, 4);
  let candidate = null;

  if (digits.length === 3) {
    candidate = `0${digits[0]}:${digits.slice(1)}`;
  } else if (digits.length === 4) {
    candidate = `${digits.slice(0, 2)}:${digits.slice(2)}`;
  }

  return candidate && TIME_PATTERN.test(candidate) ? candidate : null;
}

function normalizeSunriseValue(value) {
  const parsed = parseTimeValue(value);
  return parsed || DEFAULT_SUNRISE_TIME;
}

function formatTimeForTyping(value) {
  const digits = String(value || "")
    .replace(/\D/g, "")
    .slice(0, 4);

  if (digits.length <= 2) {
    return digits;
  }

  if (digits.length === 3) {
    return `${digits[0]}:${digits.slice(1)}`;
  }

  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

function cloneDefaultData() {
  return defaultData.map((masjid) => ({
    name: masjid.name,
    prayers: { ...masjid.prayers }
  }));
}

function normalizeMasjidData(candidate) {
  if (!Array.isArray(candidate)) {
    return cloneDefaultData();
  }

  return defaultData.map((masjid, index) => {
    const remoteMasjid = candidate[index] || {};
    const remotePrayers = remoteMasjid.prayers || {};

    return {
      name: typeof remoteMasjid.name === "string" && remoteMasjid.name.trim() ? remoteMasjid.name : masjid.name,
      prayers: PRAYERS.reduce((result, prayer) => {
        const parsed = parseTimeValue(remotePrayers[prayer]);
        result[prayer] = parsed || masjid.prayers[prayer];
        return result;
      }, {})
    };
  });
}

function normalizeStoredPayload(candidate) {
  if (Array.isArray(candidate)) {
    return {
      masjids: normalizeMasjidData(candidate),
      sunrise: DEFAULT_SUNRISE_TIME
    };
  }

  if (candidate && typeof candidate === "object") {
    const masjidSource = Array.isArray(candidate.masjids)
      ? candidate.masjids
      : Array.isArray(candidate.data)
        ? candidate.data
        : null;

    const sunriseSource =
      typeof candidate.sunrise === "string"
        ? candidate.sunrise
        : typeof candidate.sunriseTime === "string"
          ? candidate.sunriseTime
          : DEFAULT_SUNRISE_TIME;

    return {
      masjids: normalizeMasjidData(masjidSource),
      sunrise: normalizeSunriseValue(sunriseSource)
    };
  }

  return {
    masjids: cloneDefaultData(),
    sunrise: DEFAULT_SUNRISE_TIME
  };
}

function buildPersistedPayload() {
  return {
    masjids: state,
    sunrise: sunriseTime
  };
}

function getPersistedSnapshot() {
  return JSON.stringify(buildPersistedPayload());
}

function getSyncStatusElement() {
  return document.getElementById("sync-status");
}

function getSunriseInputElement() {
  return document.getElementById("sunrise-time-input");
}

function setSyncStatus(text, tone) {
  const element = getSyncStatusElement();
  if (!element) {
    return;
  }

  element.textContent = text;
  element.className = `sync-status ${tone || ""}`.trim();
}

function toMinutes(timeValue) {
  const parsed = parseTimeValue(timeValue);
  if (!parsed) {
    return null;
  }

  const [hours, minutes] = parsed.split(":").map((chunk) => Number(chunk));
  return hours * 60 + minutes;
}

function getNextPrayerInfo(prayers, now = new Date()) {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  let nextPrayer = null;

  PRAYERS.forEach((prayer) => {
    const prayerTime = prayers[prayer];
    const prayerMinutes = toMinutes(prayerTime);
    if (prayerMinutes === null) {
      return;
    }

    let deltaMinutes = prayerMinutes - nowMinutes;
    if (deltaMinutes < 0) {
      deltaMinutes += 24 * 60;
    }

    if (!nextPrayer || deltaMinutes < nextPrayer.deltaMinutes) {
      nextPrayer = {
        prayer,
        time: parseTimeValue(prayerTime),
        deltaMinutes
      };
    }
  });

  return nextPrayer;
}

function formatCountdown(deltaMinutes) {
  if (deltaMinutes === 0) {
    return "now";
  }

  const hours = Math.floor(deltaMinutes / 60);
  const minutes = deltaMinutes % 60;

  if (hours === 0) {
    return `in ${minutes}m`;
  }

  if (minutes === 0) {
    return `in ${hours}h`;
  }

  return `in ${hours}h ${minutes}m`;
}

function refreshUpcomingPrayerHighlights() {
  state.forEach((masjid, index) => {
    const card = document.querySelector(`.masjid-card[data-masjid-index="${index}"]`);
    if (!card) {
      return;
    }

    const nextInfo = getNextPrayerInfo(masjid.prayers);
    const summary = card.querySelector(".next-prayer-summary");

    const prayerFields = card.querySelectorAll(".prayer-field[data-prayer]");
    prayerFields.forEach((field) => {
      const isNext = Boolean(nextInfo && field.dataset.prayer === nextInfo.prayer);
      field.classList.toggle("is-next-prayer", isNext);

      const badge = field.querySelector(".next-pill");
      if (badge) {
        badge.hidden = !isNext;
      }
    });

    if (summary) {
      if (nextInfo) {
        summary.textContent = `Next: ${nextInfo.prayer} at ${nextInfo.time} (${formatCountdown(nextInfo.deltaMinutes)})`;
      } else {
        summary.textContent = "Next prayer unavailable";
      }
    }
  });
}

function renderSunriseInputValue() {
  const input = getSunriseInputElement();
  if (!input) {
    return;
  }

  input.value = sunriseTime;
}

function setupSunriseInput() {
  const input = getSunriseInputElement();
  if (!input || input.dataset.bound === "true") {
    renderSunriseInputValue();
    return;
  }

  input.dataset.bound = "true";

  if (IS_IOS_STANDALONE) {
    input.type = "text";
    input.inputMode = "numeric";
    input.placeholder = "HH:MM";
    input.maxLength = 5;

    input.addEventListener("input", (event) => {
      const formatted = formatTimeForTyping(event.target.value);
      event.target.value = formatted;

      const parsed = parseTimeValue(formatted);
      if (!parsed) {
        return;
      }

      sunriseTime = parsed;
      persistEverywhere();
    });

    input.addEventListener("blur", (event) => {
      const parsed = parseTimeValue(event.target.value) || sunriseTime || DEFAULT_SUNRISE_TIME;
      sunriseTime = parsed;
      event.target.value = parsed;
      persistEverywhere();
    });
  } else {
    input.type = "time";

    const persistSunrise = (event) => {
      const parsed = parseTimeValue(event.target.value);
      if (!parsed) {
        return;
      }

      sunriseTime = parsed;
      persistEverywhere();
    };

    input.addEventListener("input", persistSunrise);
    input.addEventListener("change", persistSunrise);
    input.addEventListener("blur", persistSunrise);
  }

  renderSunriseInputValue();
}

function loadLocalData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizeStoredPayload(JSON.parse(raw));
  } catch {
    return normalizeStoredPayload(null);
  }
}

function saveLocalData(payload) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore localStorage failures.
  }
}

function cloudHeaders(includeContentType) {
  const headers = {
    apikey: CLOUD.anonKey,
    Authorization: `Bearer ${CLOUD.anonKey}`
  };

  if (includeContentType) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

async function fetchCloudData() {
  const params = new URLSearchParams({
    id: `eq.${CLOUD.recordId}`,
    select: "data"
  });

  const url = `${CLOUD.url}/rest/v1/${CLOUD.table}?${params.toString()}`;
  const response = await fetch(url, {
    method: "GET",
    headers: cloudHeaders(false)
  });

  if (!response.ok) {
    throw new Error(`Cloud load failed (${response.status})`);
  }

  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return normalizeStoredPayload(rows[0].data);
}

async function pushCloudData(appPayload, options = {}) {
  const payload = [
    {
      id: CLOUD.recordId,
      data: appPayload
    }
  ];

  const url = `${CLOUD.url}/rest/v1/${CLOUD.table}?on_conflict=id`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...cloudHeaders(true),
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    keepalive: Boolean(options.keepalive),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Cloud save failed (${response.status}): ${errorText}`);
  }
}

function replaceState(nextPayload) {
  const normalized = normalizeStoredPayload(nextPayload);
  state = normalized.masjids;
  sunriseTime = normalized.sunrise;

  renderSunriseInputValue();
  renderMasjids();

  const snapshot = getPersistedSnapshot();
  lastPersistedSnapshot = snapshot;
  saveLocalData(buildPersistedPayload());

  refreshUpcomingPrayerHighlights();
}

function scheduleCloudSync(snapshot) {
  if (!CLOUD_SYNC_ENABLED) {
    return;
  }

  if (snapshot === lastRemoteSyncedSnapshot) {
    pendingSnapshot = null;
    setSyncStatus("Synced", "ok");
    return;
  }

  pendingSnapshot = snapshot;
  setSyncStatus("Syncing...", "syncing");

  if (syncTimerId) {
    clearTimeout(syncTimerId);
  }

  syncTimerId = window.setTimeout(() => {
    void flushCloudSync();
  }, 400);
}

async function flushCloudSync(options = {}) {
  if (!CLOUD_SYNC_ENABLED || !pendingSnapshot) {
    return;
  }

  if (syncInFlight) {
    return;
  }

  const snapshot = pendingSnapshot;
  pendingSnapshot = null;

  if (snapshot === lastRemoteSyncedSnapshot) {
    setSyncStatus("Synced", "ok");
    return;
  }

  syncInFlight = true;

  try {
    await pushCloudData(JSON.parse(snapshot), options);
    lastRemoteSyncedSnapshot = snapshot;
    setSyncStatus("Synced", "ok");
  } catch (error) {
    console.error(error);
    pendingSnapshot = snapshot;
    setSyncStatus("Cloud unavailable (local cache active)", "warn");
  } finally {
    syncInFlight = false;

    if (pendingSnapshot && pendingSnapshot !== snapshot) {
      void flushCloudSync();
    }
  }
}

function persistEverywhere(options = {}) {
  const force = Boolean(options.force);
  const snapshot = getPersistedSnapshot();

  if (!force && snapshot === lastPersistedSnapshot) {
    refreshUpcomingPrayerHighlights();
    return;
  }

  lastPersistedSnapshot = snapshot;
  saveLocalData(buildPersistedPayload());
  scheduleCloudSync(snapshot);
  refreshUpcomingPrayerHighlights();
}

function createPrayerField(masjidIndex, prayer, value) {
  const field = document.createElement("div");
  field.className = "prayer-field";
  field.dataset.prayer = prayer;

  const labelRow = document.createElement("div");
  labelRow.className = "prayer-label-row";

  const label = document.createElement("label");
  label.textContent = prayer;

  const nextPill = document.createElement("span");
  nextPill.className = "next-pill";
  nextPill.textContent = "Next";
  nextPill.hidden = true;

  labelRow.append(label, nextPill);

  const input = document.createElement("input");
  input.className = "prayer-time-input";
  input.value = value;
  input.dataset.masjidIndex = String(masjidIndex);
  input.dataset.prayer = prayer;
  input.setAttribute("aria-label", `${state[masjidIndex].name} ${prayer}`);

  if (IS_IOS_STANDALONE) {
    input.type = "text";
    input.inputMode = "numeric";
    input.placeholder = "HH:MM";
    input.maxLength = 5;

    input.addEventListener("input", (event) => {
      const formatted = formatTimeForTyping(event.target.value);
      event.target.value = formatted;

      const parsed = parseTimeValue(formatted);
      if (!parsed) {
        return;
      }

      state[masjidIndex].prayers[prayer] = parsed;
      persistEverywhere();
    });

    input.addEventListener("blur", (event) => {
      const fallback = state[masjidIndex].prayers[prayer] || defaultData[masjidIndex].prayers[prayer];
      const parsed = parseTimeValue(event.target.value) || fallback;
      state[masjidIndex].prayers[prayer] = parsed;
      event.target.value = parsed;
      persistEverywhere();
    });
  } else {
    input.type = "time";

    const persistTime = (event) => {
      const parsed = parseTimeValue(event.target.value);
      if (!parsed) {
        return;
      }

      state[masjidIndex].prayers[prayer] = parsed;
      persistEverywhere();
    };

    input.addEventListener("input", persistTime);
    input.addEventListener("change", persistTime);
    input.addEventListener("blur", persistTime);
  }

  field.append(labelRow, input);
  return field;
}

function createMasjidNameField(masjidIndex) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "masjid-name-input";
  input.value = state[masjidIndex].name;
  input.dataset.masjidIndex = String(masjidIndex);
  input.setAttribute("aria-label", `Masjid ${masjidIndex + 1} name`);

  input.addEventListener("input", (event) => {
    state[masjidIndex].name = event.target.value;
    persistEverywhere();
  });

  input.addEventListener("blur", () => {
    state[masjidIndex].name = input.value.trim() || defaultData[masjidIndex].name;
    input.value = state[masjidIndex].name;
    persistEverywhere();
  });

  return input;
}

function persistAllFieldsFromDOM() {
  const sunriseInput = getSunriseInputElement();
  if (sunriseInput) {
    const parsedSunrise = parseTimeValue(sunriseInput.value);
    if (parsedSunrise) {
      sunriseTime = parsedSunrise;
    }
  }

  const nameInputs = document.querySelectorAll(".masjid-name-input[data-masjid-index]");
  nameInputs.forEach((input) => {
    const masjidIndex = Number(input.dataset.masjidIndex);
    if (Number.isInteger(masjidIndex) && state[masjidIndex]) {
      state[masjidIndex].name = input.value.trim() || defaultData[masjidIndex].name;
    }
  });

  const timeInputs = document.querySelectorAll(".prayer-time-input[data-masjid-index][data-prayer]");
  timeInputs.forEach((input) => {
    const masjidIndex = Number(input.dataset.masjidIndex);
    const prayer = input.dataset.prayer;

    if (Number.isInteger(masjidIndex) && state[masjidIndex] && PRAYERS.includes(prayer)) {
      const parsed = parseTimeValue(input.value);
      if (parsed) {
        state[masjidIndex].prayers[prayer] = parsed;
      }
    }
  });

  persistEverywhere();
}

function renderMasjids() {
  const container = document.getElementById("masjid-list");
  container.innerHTML = "";

  state.forEach((masjid, index) => {
    const card = document.createElement("article");
    card.className = "masjid-card";
    card.dataset.masjidIndex = String(index);
    card.style.setProperty("--card-index", String(index));

    const cardHead = document.createElement("div");
    cardHead.className = "masjid-card-head";

    const title = createMasjidNameField(index);

    const summary = document.createElement("p");
    summary.className = "next-prayer-summary";
    summary.textContent = "Calculating next prayer...";

    cardHead.append(title, summary);

    const grid = document.createElement("div");
    grid.className = "prayer-grid";

    PRAYERS.forEach((prayer) => {
      grid.append(createPrayerField(index, prayer, masjid.prayers[prayer]));
    });

    card.append(cardHead, grid);
    container.append(card);
  });

  refreshUpcomingPrayerHighlights();
}

async function initializeCloudSync() {
  if (!CLOUD_SYNC_ENABLED) {
    setSyncStatus("Cloud sync disabled (configure config.js)", "warn");
    return;
  }

  setSyncStatus("Connecting to cloud...", "syncing");

  try {
    const cloudData = await fetchCloudData();

    if (cloudData) {
      replaceState(cloudData);
      lastRemoteSyncedSnapshot = getPersistedSnapshot();
      setSyncStatus("Synced", "ok");
      return;
    }

    await pushCloudData(buildPersistedPayload());
    lastRemoteSyncedSnapshot = getPersistedSnapshot();
    setSyncStatus("Synced", "ok");
  } catch (error) {
    console.error(error);
    setSyncStatus("Cloud unavailable (local cache active)", "warn");
  }
}

function installLifecyclePersistence() {
  window.setInterval(() => {
    persistAllFieldsFromDOM();

    if (pendingSnapshot && !syncInFlight) {
      void flushCloudSync();
    }
  }, 5000);

  if (upcomingRefreshTimerId) {
    clearInterval(upcomingRefreshTimerId);
  }

  upcomingRefreshTimerId = window.setInterval(() => {
    refreshUpcomingPrayerHighlights();
  }, UPCOMING_REFRESH_INTERVAL_MS);

  function persistAndFlushNow() {
    persistAllFieldsFromDOM();

    if (pendingSnapshot && !syncInFlight) {
      void flushCloudSync({ keepalive: true });
    }
  }

  window.addEventListener("beforeunload", persistAndFlushNow);
  window.addEventListener("pagehide", persistAndFlushNow);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      persistAndFlushNow();
    }

    if (document.visibilityState === "visible") {
      refreshUpcomingPrayerHighlights();

      if (pendingSnapshot && !syncInFlight) {
        void flushCloudSync();
      }
    }
  });
}

async function initializeApp() {
  setupSunriseInput();
  replaceState(loadLocalData());
  await initializeCloudSync();
  installLifecyclePersistence();
}

void initializeApp();
