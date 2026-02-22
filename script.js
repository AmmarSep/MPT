const STORAGE_KEY = "masjid-prayer-times";
const PRAYERS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
  recordId: String(APP_CONFIG.supabaseRecordId || "global")
};

const CLOUD_SYNC_ENABLED = Boolean(CLOUD.url && CLOUD.anonKey);
const IS_IOS_STANDALONE = detectIosStandalone();

let state = [];
let syncTimerId = null;
let syncInFlight = false;
let pendingSnapshot = null;
let lastRemoteSyncedSnapshot = "";

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

function normalizeData(candidate) {
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

function getSyncStatusElement() {
  return document.getElementById("sync-status");
}

function setSyncStatus(text, tone) {
  const element = getSyncStatusElement();
  if (!element) {
    return;
  }

  element.textContent = text;
  element.className = `sync-status ${tone || ""}`.trim();
}

function loadLocalData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizeData(JSON.parse(raw));
  } catch {
    return cloneDefaultData();
  }
}

function saveLocalData(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
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

  return normalizeData(rows[0].data);
}

async function pushCloudData(data, options = {}) {
  const payload = [
    {
      id: CLOUD.recordId,
      data
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

function replaceState(nextState) {
  state = normalizeData(nextState);
  renderMasjids();
  saveLocalData(state);
}

function scheduleCloudSync() {
  if (!CLOUD_SYNC_ENABLED) {
    return;
  }

  pendingSnapshot = JSON.stringify(state);
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

function persistEverywhere() {
  saveLocalData(state);
  scheduleCloudSync();
}

function createPrayerField(masjidIndex, prayer, value) {
  const field = document.createElement("div");
  field.className = "prayer-field";

  const label = document.createElement("label");
  label.textContent = prayer;

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

  field.append(label, input);
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

    const title = createMasjidNameField(index);

    const grid = document.createElement("div");
    grid.className = "prayer-grid";

    PRAYERS.forEach((prayer) => {
      grid.append(createPrayerField(index, prayer, masjid.prayers[prayer]));
    });

    card.append(title, grid);
    container.append(card);
  });
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
      lastRemoteSyncedSnapshot = JSON.stringify(state);
      setSyncStatus("Synced", "ok");
      return;
    }

    await pushCloudData(state);
    lastRemoteSyncedSnapshot = JSON.stringify(state);
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

    if (document.visibilityState === "visible" && pendingSnapshot && !syncInFlight) {
      void flushCloudSync();
    }
  });
}

async function initializeApp() {
  replaceState(loadLocalData());
  installLifecyclePersistence();
  await initializeCloudSync();
}

void initializeApp();
