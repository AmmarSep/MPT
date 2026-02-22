const STORAGE_KEY = "masjid-prayer-times";
const PRAYERS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];

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

function loadData() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!Array.isArray(saved)) {
      return defaultData;
    }

    return defaultData.map((masjid, index) => {
      const savedMasjid = saved[index] || {};
      const savedPrayers = savedMasjid.prayers || {};

      return {
        name: typeof savedMasjid.name === "string" ? savedMasjid.name : masjid.name,
        prayers: PRAYERS.reduce((result, prayer) => {
          const savedTime = savedPrayers[prayer];
          result[prayer] = typeof savedTime === "string" ? savedTime : masjid.prayers[prayer];
          return result;
        }, {})
      };
    });
  } catch {
    return defaultData;
  }
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function createPrayerField(masjidIndex, prayer, value, state) {
  const field = document.createElement("div");
  field.className = "prayer-field";

  const label = document.createElement("label");
  label.textContent = prayer;

  const input = document.createElement("input");
  input.type = "time";
  input.value = value;
  input.setAttribute("aria-label", `${state[masjidIndex].name} ${prayer}`);

  const persistTime = (event) => {
    state[masjidIndex].prayers[prayer] = event.target.value;
    saveData(state);
  };

  input.addEventListener("input", persistTime);
  input.addEventListener("change", persistTime);

  field.append(label, input);
  return field;
}

function createMasjidNameField(masjidIndex, state) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "masjid-name-input";
  input.value = state[masjidIndex].name;
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
