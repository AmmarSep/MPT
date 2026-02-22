const STORAGE_KEY = "masjid-prayer-times";
const COOKIE_KEY = "masjid-prayer-times-cookie";
const IDB_DB_NAME = "mpt-storage";
const IDB_STORE_NAME = "kv";
const IDB_RECORD_KEY = "masjid-prayer-times";
const PRAYERS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
let lastSavedSnapshot = "";

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

function detectIosStandalone() {
  const userAgent = navigator.userAgent || "";
  const isiOSDevice =
    /iPad|iPhone|iPod/.test(userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standaloneMode = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
  return isiOSDevice && (standaloneMode || window.navigator.standalone === true);
}

const IS_IOS_STANDALONE = detectIosStandalone();

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

function normalizeData(saved) {
  if (!Array.isArray(saved)) {
    return cloneDefaultData();
  }

  return defaultData.map((masjid, index) => {
    const savedMasjid = saved[index] || {};
    const savedPrayers = savedMasjid.prayers || {};

    return {
      name: typeof savedMasjid.name === "string" ? savedMasjid.name : masjid.name,
      prayers: PRAYERS.reduce((result, prayer) => {
        const savedTime = savedPrayers[prayer];
        const parsed = parseTimeValue(savedTime);
        result[prayer] = parsed || masjid.prayers[prayer];
        return result;
      }, {})
    };
  });
}

function readCookie(name) {
  const prefix = `${name}=`;
  const parts = document.cookie.split(";").map((part) => part.trim());
  const matched = parts.find((part) => part.startsWith(prefix));
  if (!matched) {
    return null;
  }

  return decodeURIComponent(matched.slice(prefix.length));
}

function writeCookie(name, value, days) {
  const maxAge = days * 24 * 60 * 60;
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`;
}

function openIndexedDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB not supported"));
      return;
    }

    const request = indexedDB.open(IDB_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });
}

async function readIndexedDbData() {
  try {
    const db = await openIndexedDb();

    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE_NAME, "readonly");
      const request = tx.objectStore(IDB_STORE_NAME).get(IDB_RECORD_KEY);

      request.onsuccess = () => {
        resolve(typeof request.result === "string" ? request.result : null);
      };

      request.onerror = () => {
        resolve(null);
      };

      tx.oncomplete = () => db.close();
      tx.onabort = () => db.close();
      tx.onerror = () => db.close();
    });
  } catch {
    return null;
  }
}

async function writeIndexedDbData(serialized) {
  try {
    const db = await openIndexedDb();

    await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE_NAME, "readwrite");
      tx.objectStore(IDB_STORE_NAME).put(serialized, IDB_RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onabort = () => resolve();
      tx.onerror = () => resolve();
    });

    db.close();
  } catch {
    // Ignore IndexedDB failures.
  }
}

function readStoredData() {
  let localValue = null;

  try {
    localValue = localStorage.getItem(STORAGE_KEY);
  } catch {
    localValue = null;
  }

  if (typeof localValue === "string" && localValue.length > 0) {
    return localValue;
  }

  return readCookie(COOKIE_KEY);
}

function loadData() {
  try {
    const rawStored = readStoredData();
    const normalized = normalizeData(JSON.parse(rawStored));
    lastSavedSnapshot = JSON.stringify(normalized);
    return normalized;
  } catch {
    const fallback = cloneDefaultData();
    lastSavedSnapshot = JSON.stringify(fallback);
    return fallback;
  }
}

function saveData(data) {
  const serialized = JSON.stringify(data);
  if (serialized === lastSavedSnapshot) {
    return;
  }

  lastSavedSnapshot = serialized;

  try {
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // Ignore localStorage failures (private browsing / restrictive device settings).
  }

  writeCookie(COOKIE_KEY, serialized, 365);
  writeIndexedDbData(serialized);
}

function createPrayerField(masjidIndex, prayer, value, state) {
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
      if (parsed) {
        state[masjidIndex].prayers[prayer] = parsed;
        saveData(state);
      }
    });

    input.addEventListener("blur", (event) => {
      const fallback = state[masjidIndex].prayers[prayer] || defaultData[masjidIndex].prayers[prayer];
      const parsed = parseTimeValue(event.target.value) || fallback;
      state[masjidIndex].prayers[prayer] = parsed;
      event.target.value = parsed;
      saveData(state);
    });
  } else {
    input.type = "time";

    const persistTime = (event) => {
      const parsed = parseTimeValue(event.target.value);
      if (!parsed) {
        return;
      }

      state[masjidIndex].prayers[prayer] = parsed;
      saveData(state);
    };

    input.addEventListener("input", persistTime);
    input.addEventListener("change", persistTime);
    input.addEventListener("blur", persistTime);
  }

  field.append(label, input);
  return field;
}

function createMasjidNameField(masjidIndex, state) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "masjid-name-input";
  input.value = state[masjidIndex].name;
  input.dataset.masjidIndex = String(masjidIndex);
  input.setAttribute("aria-label", `Masjid ${masjidIndex + 1} name`);

  input.addEventListener("input", (event) => {
    state[masjidIndex].name = event.target.value;
    saveData(state);
  });

  input.addEventListener("blur", () => {
    state[masjidIndex].name = input.value.trim() || defaultData[masjidIndex].name;
    input.value = state[masjidIndex].name;
    saveData(state);
  });

  return input;
}

function persistAllFields(state) {
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

  saveData(state);
}

async function hydrateFromIndexedDb(state) {
  const rawIndexedData = await readIndexedDbData();
  if (typeof rawIndexedData !== "string" || rawIndexedData.length === 0) {
    return;
  }

  let indexedState = null;
  try {
    indexedState = normalizeData(JSON.parse(rawIndexedData));
  } catch {
    indexedState = null;
  }

  if (!Array.isArray(indexedState)) {
    return;
  }

  const existingState = JSON.stringify(state);
  const incomingState = JSON.stringify(indexedState);
  if (existingState === incomingState) {
    return;
  }

  state.splice(0, state.length, ...indexedState);
  renderMasjids(state);
  saveData(state);
}

function renderMasjids(state) {
  const container = document.getElementById("masjid-list");
  container.innerHTML = "";

  state.forEach((masjid, index) => {
    const card = document.createElement("article");
    card.className = "masjid-card";

    const title = createMasjidNameField(index, state);

    const grid = document.createElement("div");
    grid.className = "prayer-grid";

    PRAYERS.forEach((prayer) => {
      const field = createPrayerField(index, prayer, masjid.prayers[prayer], state);
      grid.append(field);
    });

    card.append(title, grid);
    container.append(card);
  });
}

const state = loadData();
renderMasjids(state);
hydrateFromIndexedDb(state);

window.setInterval(() => {
  persistAllFields(state);
}, 1000);

// iOS standalone/webview can skip late change events when app closes.
window.addEventListener("beforeunload", () => persistAllFields(state));
window.addEventListener("pagehide", () => persistAllFields(state));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    persistAllFields(state);
  }
});
