"use strict";

const fileInput = document.querySelector("#audio-file");
const openButton = document.querySelector("#open-audio");
const analyzeButton = document.querySelector("#analyze");
const statusEl = document.querySelector("#status");
const audioInfo = document.querySelector("#audio-info");

const fields = {
  name: document.querySelector("#file-name"),
  size: document.querySelector("#file-size"),
  duration: document.querySelector("#duration"),
  sampleRate: document.querySelector("#sample-rate"),
  channels: document.querySelector("#channels"),
};

let audioContext = null;
let decodedAudio = null;

openButton.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  setStatus("Reading local audio…");
  openButton.disabled = true;
  analyzeButton.disabled = true;
  try {
    audioContext ??= new AudioContext();
    const bytes = await file.arrayBuffer();
    decodedAudio = await audioContext.decodeAudioData(bytes.slice(0));

    fields.name.textContent = file.name;
    fields.size.textContent = formatBytes(file.size);
    fields.duration.textContent = formatDuration(decodedAudio.duration);
    fields.sampleRate.textContent = `${decodedAudio.sampleRate.toLocaleString()} Hz`;
    fields.channels.textContent = String(decodedAudio.numberOfChannels);

    audioInfo.hidden = false;
    setStatus("Local audio decoded · No upload · No API");
  } catch (error) {
    decodedAudio = null;
    audioInfo.hidden = true;
    setStatus("Unable to decode this audio format");
    console.error("Audio decode failed:", error);
  } finally {
    openButton.disabled = false;
    fileInput.value = "";
  }
});

function setStatus(message) {
  statusEl.textContent = message;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${minutes}:${String(secs).padStart(2, "0")}`;
}
