"use strict";

const fileInput = document.querySelector("#audio-file");
const openButton = document.querySelector("#open-audio");
const removeButton = document.querySelector("#remove-audio");
const analyzeButton = document.querySelector("#analyze");
const statusEl = document.querySelector("#status");
const audioInfo = document.querySelector("#audio-info");
const waveformPanel = document.querySelector("#waveform-panel");
const waveformCanvas = document.querySelector("#waveform-canvas");
const waveformEmpty = document.querySelector("#waveform-empty");
const candidateCountEl = document.querySelector("#candidate-count");

const DETECTION_CONFIG = Object.freeze({
  thresholdDb: -45,
  minSilenceSeconds: 0.35,
  windowSeconds: 0.02,
  edgeGuardSeconds: 2,
});

const fields = {
  name: document.querySelector("#file-name"),
  size: document.querySelector("#file-size"),
  duration: document.querySelector("#duration"),
  sampleRate: document.querySelector("#sample-rate"),
  channels: document.querySelector("#channels"),
};

let audioContext = null;
let decodedAudio = null;
let waveformPeaks = null;
let candidates = [];

openButton.addEventListener("click", () => fileInput.click());
removeButton.addEventListener("click", removeAudio);
analyzeButton.addEventListener("click", analyzeAudio);

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  setStatus("Reading local audio…");
  openButton.disabled = true;
  removeButton.disabled = true;
  analyzeButton.disabled = true;
  candidates = [];
  candidateCountEl.textContent = "Candidates: —";
  clearWaveform();

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

    setStatus("Generating waveform locally…");
    await nextFrame();

    waveformPeaks = buildWaveformPeaks(decodedAudio, 2400);
    waveformEmpty.hidden = true;
    renderWaveform();
    removeButton.disabled = false;
    analyzeButton.disabled = false;

    setStatus("Waveform ready · Local only · No upload · No API");
  } catch (error) {
    decodedAudio = null;
    waveformPeaks = null;
    audioInfo.hidden = true;
    clearWaveform();
    setStatus("Unable to decode this audio format");
    console.error("Audio decode failed:", error);
  } finally {
    openButton.disabled = false;
    fileInput.value = "";
  }
});

async function analyzeAudio() {
  if (!decodedAudio) return;

  openButton.disabled = true;
  removeButton.disabled = true;
  analyzeButton.disabled = true;
  candidates = [];
  candidateCountEl.textContent = "Candidates: analyzing…";
  renderWaveform();

  try {
    setStatus("Analyzing silence locally… 0%");
    candidates = await detectSilenceCandidates(decodedAudio, DETECTION_CONFIG, (progress) => {
      setStatus(`Analyzing silence locally… ${Math.round(progress * 100)}%`);
    });

    candidateCountEl.textContent = `Candidates: ${candidates.length}`;
    renderWaveform();
    setStatus(
      `Analyze complete · ${candidates.length} candidate(s) · ${DETECTION_CONFIG.thresholdDb} dBFS / ${DETECTION_CONFIG.minSilenceSeconds.toFixed(2)} s`,
    );
  } catch (error) {
    candidates = [];
    candidateCountEl.textContent = "Candidates: error";
    renderWaveform();
    setStatus("Analyze failed");
    console.error("Silence analysis failed:", error);
  } finally {
    openButton.disabled = false;
    removeButton.disabled = false;
    analyzeButton.disabled = false;
  }
}

async function detectSilenceCandidates(audioBuffer, config, onProgress) {
  const sampleRate = audioBuffer.sampleRate;
  const windowFrames = Math.max(1, Math.round(config.windowSeconds * sampleRate));
  const minSilentWindows = Math.max(
    1,
    Math.ceil(config.minSilenceSeconds / config.windowSeconds),
  );
  const totalWindows = Math.ceil(audioBuffer.length / windowFrames);
  const thresholdLinear = Math.pow(10, config.thresholdDb / 20);
  const channels = Array.from(
    { length: audioBuffer.numberOfChannels },
    (_, index) => audioBuffer.getChannelData(index),
  );

  const regions = [];
  let silenceStartWindow = null;
  const batchWindows = 1200;

  for (let windowIndex = 0; windowIndex < totalWindows; windowIndex += 1) {
    const start = windowIndex * windowFrames;
    const end = Math.min(audioBuffer.length, start + windowFrames);
    const span = Math.max(1, end - start);
    const stride = Math.max(1, Math.floor(span / 128));
    let sumSquares = 0;
    let sampleCount = 0;

    for (let sample = start; sample < end; sample += stride) {
      for (const channel of channels) {
        const value = channel[sample] ?? 0;
        sumSquares += value * value;
        sampleCount += 1;
      }
    }

    const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
    const isSilent = rms <= thresholdLinear;

    if (isSilent) {
      if (silenceStartWindow === null) silenceStartWindow = windowIndex;
    } else if (silenceStartWindow !== null) {
      const silentWindowCount = windowIndex - silenceStartWindow;
      if (silentWindowCount >= minSilentWindows) {
        regions.push({
          start: silenceStartWindow * config.windowSeconds,
          end: Math.min(windowIndex * config.windowSeconds, audioBuffer.duration),
        });
      }
      silenceStartWindow = null;
    }

    if (windowIndex % batchWindows === 0) {
      onProgress?.(windowIndex / totalWindows);
      await nextFrame();
    }
  }

  if (silenceStartWindow !== null) {
    const silentWindowCount = totalWindows - silenceStartWindow;
    if (silentWindowCount >= minSilentWindows) {
      regions.push({
        start: silenceStartWindow * config.windowSeconds,
        end: audioBuffer.duration,
      });
    }
  }

  onProgress?.(1);

  return regions
    .map((region) => ({
      time: (region.start + region.end) / 2,
      start: region.start,
      end: region.end,
      duration: region.end - region.start,
    }))
    .filter(
      (candidate) =>
        candidate.time >= config.edgeGuardSeconds &&
        candidate.time <= audioBuffer.duration - config.edgeGuardSeconds,
    );
}

function removeAudio() {
  decodedAudio = null;
  waveformPeaks = null;
  candidates = [];
  fileInput.value = "";
  analyzeButton.disabled = true;
  removeButton.disabled = true;
  candidateCountEl.textContent = "Candidates: —";

  fields.name.textContent = "—";
  fields.size.textContent = "—";
  fields.duration.textContent = "—";
  fields.sampleRate.textContent = "—";
  fields.channels.textContent = "—";
  audioInfo.hidden = true;

  clearWaveform();
  setStatus("Audio removed · Ready to open another file");
}

const resizeObserver = new ResizeObserver(() => {
  if (waveformPeaks) renderWaveform();
});
resizeObserver.observe(waveformPanel);

function buildWaveformPeaks(audioBuffer, targetBins) {
  const bins = Math.max(1, Math.min(targetBins, audioBuffer.length));
  const mins = new Float32Array(bins);
  const maxs = new Float32Array(bins);
  const samplesPerBin = audioBuffer.length / bins;
  const channels = Array.from(
    { length: audioBuffer.numberOfChannels },
    (_, index) => audioBuffer.getChannelData(index),
  );

  for (let bin = 0; bin < bins; bin += 1) {
    const start = Math.floor(bin * samplesPerBin);
    const end = Math.max(start + 1, Math.floor((bin + 1) * samplesPerBin));
    const span = end - start;
    const stride = Math.max(1, Math.floor(span / 192));
    let min = 1;
    let max = -1;

    for (let sample = start; sample < end; sample += stride) {
      for (const channel of channels) {
        const value = channel[sample] ?? 0;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }

    mins[bin] = min === 1 ? 0 : min;
    maxs[bin] = max === -1 ? 0 : max;
  }

  return { mins, maxs, duration: audioBuffer.duration };
}

function renderWaveform() {
  if (!waveformPeaks) return;

  const rect = waveformPanel.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.floor(rect.width));
  const cssHeight = Math.max(240, Math.floor(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const ctx = waveformCanvas.getContext("2d");

  waveformCanvas.width = Math.floor(cssWidth * dpr);
  waveformCanvas.height = Math.floor(cssHeight * dpr);
  waveformCanvas.style.width = `${cssWidth}px`;
  waveformCanvas.style.height = `${cssHeight}px`;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const labelHeight = 28;
  const drawHeight = cssHeight - labelHeight;
  const centerY = drawHeight / 2;
  const amplitude = Math.max(1, centerY - 12);

  ctx.strokeStyle = "#1b2529";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i += 1) {
    const x = Math.round((i / 10) * cssWidth) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, drawHeight);
    ctx.stroke();
  }

  ctx.strokeStyle = "#405159";
  ctx.beginPath();
  ctx.moveTo(0, centerY + 0.5);
  ctx.lineTo(cssWidth, centerY + 0.5);
  ctx.stroke();

  const { mins, maxs } = waveformPeaks;
  ctx.strokeStyle = "#79d7f2";
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let x = 0; x < cssWidth; x += 1) {
    const startBin = Math.floor((x / cssWidth) * mins.length);
    const endBin = Math.max(
      startBin + 1,
      Math.floor(((x + 1) / cssWidth) * mins.length),
    );

    let min = 0;
    let max = 0;
    for (let bin = startBin; bin < endBin && bin < mins.length; bin += 1) {
      if (mins[bin] < min) min = mins[bin];
      if (maxs[bin] > max) max = maxs[bin];
    }

    const top = centerY - max * amplitude;
    const bottom = centerY - min * amplitude;
    ctx.moveTo(x + 0.5, top);
    ctx.lineTo(x + 0.5, bottom);
  }

  ctx.stroke();

  drawCandidates(ctx, cssWidth, drawHeight, waveformPeaks.duration);
  drawTimeAxis(ctx, cssWidth, cssHeight, waveformPeaks.duration);
}

function drawCandidates(ctx, width, drawHeight, duration) {
  if (!duration || candidates.length === 0) return;

  ctx.save();
  ctx.strokeStyle = "#f0a44b";
  ctx.fillStyle = "#f0a44b";
  ctx.lineWidth = 1.5;

  for (const candidate of candidates) {
    const x = Math.max(0, Math.min(width, (candidate.time / duration) * width));

    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, drawHeight);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 8);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

function drawTimeAxis(ctx, width, height, duration) {
  ctx.fillStyle = "#89918f";
  ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = "middle";

  const y = height - 12;
  const labels = [
    { x: 8, align: "left", time: 0 },
    { x: width / 2, align: "center", time: duration / 2 },
    { x: width - 8, align: "right", time: duration },
  ];

  for (const label of labels) {
    ctx.textAlign = label.align;
    ctx.fillText(formatDuration(label.time), label.x, y);
  }
}

function clearWaveform() {
  waveformPeaks = null;
  waveformEmpty.hidden = false;
  const ctx = waveformCanvas.getContext("2d");
  ctx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

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
