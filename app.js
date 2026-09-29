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
const diagnosticsSection = document.querySelector("#candidate-diagnostics");
const diagnosticsBody = document.querySelector("#candidate-diagnostics-body");
const refinementSection = document.querySelector("#refinement-diagnostics");
const refinementBody = document.querySelector("#refinement-diagnostics-body");

const DETECTION_CONFIG = Object.freeze({
  thresholdDb: -45,
  minSilenceSeconds: 0.35,
  windowSeconds: 0.02,
});

const CLEANUP_CONFIG = Object.freeze({
  edgeGuardSeconds: 20,
  clusterSeconds: 20,
});

const REFINEMENT_CONFIG = Object.freeze({
  shortTrackRatio: 0.86,
  longNextRatio: 1.22,
  searchRadiusSeconds: 35,
  minimumMoveSeconds: 20,
  envelopeWindowSeconds: 0.10,
  transitionLookSeconds: 5,
  transitionInnerGapSeconds: 1,
  transitionMinDb: 7,
  valleyMaxDb: -18,
  proximityPenaltyDb: 12,
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
let rawCandidates = [];
let selectedCandidates = [];
let finalCandidates = [];
let candidateDiagnostics = [];
let refinementDiagnostics = [];

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
  rawCandidates = [];
  selectedCandidates = [];
  finalCandidates = [];
  candidateDiagnostics = [];
  refinementDiagnostics = [];
  candidateCountEl.textContent = "Raw: — · Cleanup: — · Final: —";
  diagnosticsSection.hidden = true;
  diagnosticsBody.replaceChildren();
  refinementSection.hidden = true;
  refinementBody.replaceChildren();
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
  rawCandidates = [];
  selectedCandidates = [];
  finalCandidates = [];
  candidateDiagnostics = [];
  refinementDiagnostics = [];
  candidateCountEl.textContent = "Raw: analyzing… · Cleanup: — · Final: —";
  diagnosticsSection.hidden = true;
  diagnosticsBody.replaceChildren();
  refinementSection.hidden = true;
  refinementBody.replaceChildren();
  renderWaveform();

  try {
    setStatus("Analyzing silence locally… 0%");
    rawCandidates = await detectSilenceCandidates(
      decodedAudio,
      DETECTION_CONFIG,
      (progress) => {
        setStatus(`Analyzing silence locally… ${Math.round(progress * 100)}%`);
      },
    );

    const cleanup = cleanupCandidates(
      rawCandidates,
      decodedAudio.duration,
      CLEANUP_CONFIG,
    );
    selectedCandidates = cleanup.selected;
    candidateDiagnostics = cleanup.diagnostics;

    candidateCountEl.textContent =
      `Raw: ${rawCandidates.length} · Cleanup: ${selectedCandidates.length} · Final: refining…`;
    renderCandidateDiagnostics();
    renderWaveform();

    setStatus("Refining boundaries locally…");
    const refinement = await refineBoundaries(
      decodedAudio,
      selectedCandidates,
      REFINEMENT_CONFIG,
    );
    finalCandidates = refinement.final;
    refinementDiagnostics = refinement.diagnostics;

    candidateCountEl.textContent =
      `Raw: ${rawCandidates.length} · Cleanup: ${selectedCandidates.length} · Final: ${finalCandidates.length}`;
    renderRefinementDiagnostics();
    renderWaveform();

    const moved = refinementDiagnostics.filter(
      (item) => item.action === "fallback",
    ).length;
    setStatus(
      `Analyze complete · Raw ${rawCandidates.length} → Cleanup ${selectedCandidates.length} → Final ${finalCandidates.length} · Refined ${moved}`,
    );
  } catch (error) {
    rawCandidates = [];
    selectedCandidates = [];
    finalCandidates = [];
    candidateDiagnostics = [];
    refinementDiagnostics = [];
    candidateCountEl.textContent = "Raw: error · Cleanup: — · Final: —";
    diagnosticsSection.hidden = true;
    diagnosticsBody.replaceChildren();
    refinementSection.hidden = true;
    refinementBody.replaceChildren();
    renderWaveform();
    setStatus("Analyze failed");
    console.error("Boundary analysis failed:", error);
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

  return regions.map((region, index) => ({
    id: index + 1,
    time: (region.start + region.end) / 2,
    start: region.start,
    end: region.end,
    duration: region.end - region.start,
  }));
}

function cleanupCandidates(raw, audioDuration, config) {
  const diagnostics = raw.map((candidate) => ({
    ...candidate,
    decision: "pending",
    reason: "",
  }));

  const eligible = [];
  for (const item of diagnostics) {
    const fromStart = item.time;
    const fromEnd = audioDuration - item.time;

    if (
      fromStart < config.edgeGuardSeconds ||
      fromEnd < config.edgeGuardSeconds
    ) {
      item.decision = "rejected";
      item.reason = `Edge guard < ${config.edgeGuardSeconds}s`;
    } else {
      eligible.push(item);
    }
  }

  const clusters = [];
  for (const item of eligible) {
    const current = clusters.at(-1);
    if (
      current &&
      item.time - current.at(-1).time <= config.clusterSeconds
    ) {
      current.push(item);
    } else {
      clusters.push([item]);
    }
  }

  const selected = [];
  for (const cluster of clusters) {
    let best = cluster[0];
    for (const item of cluster.slice(1)) {
      if (
        item.duration > best.duration ||
        (item.duration === best.duration && item.time < best.time)
      ) {
        best = item;
      }
    }

    best.decision = "selected";
    best.reason =
      cluster.length === 1
        ? "Passed cleanup"
        : `Longest silence in ${cluster.length}-candidate cluster`;
    selected.push(best);

    for (const item of cluster) {
      if (item === best) continue;
      item.decision = "rejected";
      item.reason = `Clustered within ${config.clusterSeconds}s of #${best.id}`;
    }
  }

  return {
    selected: selected.map(({ id, time, start, end, duration }) => ({
      id,
      time,
      start,
      end,
      duration,
    })),
    diagnostics,
  };
}

async function refineBoundaries(audioBuffer, selected, config) {
  if (selected.length === 0) {
    return { final: [], diagnostics: [] };
  }

  const envelope = await buildEnergyEnvelope(
    audioBuffer,
    config.envelopeWindowSeconds,
  );
  const final = selected.map((candidate) => ({
    ...candidate,
    source: "silence",
  }));
  const diagnostics = [];
  const acceptedTrackDurations = [];

  for (let index = 0; index < final.length; index += 1) {
    const candidate = final[index];
    const previousTime = index === 0 ? 0 : final[index - 1].time;
    const currentTrack = candidate.time - previousTime;

    if (index < 2) {
      acceptedTrackDurations.push(currentTrack);
      diagnostics.push({
        id: candidate.id,
        originalTime: candidate.time,
        refinedTime: candidate.time,
        action: "keep",
        reason: "Insufficient history for spacing refinement",
      });
      continue;
    }

    const baseline = median(acceptedTrackDurations);
    const nextTime =
      index + 1 < final.length ? final[index + 1].time : audioBuffer.duration;
    const nextTrack = nextTime - candidate.time;
    const isEarly =
      currentTrack < baseline * config.shortTrackRatio &&
      nextTrack > baseline * config.longNextRatio;

    if (!isEarly) {
      acceptedTrackDurations.push(currentTrack);
      diagnostics.push({
        id: candidate.id,
        originalTime: candidate.time,
        refinedTime: candidate.time,
        action: "keep",
        reason: `Spacing plausible · track ${currentTrack.toFixed(1)}s / baseline ${baseline.toFixed(1)}s`,
      });
      continue;
    }

    const expectedTime = previousTime + baseline;
    const searchStart = Math.max(
      candidate.time + config.minimumMoveSeconds,
      expectedTime - config.searchRadiusSeconds,
    );
    const searchEnd = Math.min(
      nextTime - CLEANUP_CONFIG.edgeGuardSeconds,
      expectedTime + config.searchRadiusSeconds,
    );

    const transition = findFirstSustainedTransition(
      envelope,
      searchStart,
      searchEnd,
      config,
    );
    const valley = transition
      ? null
      : findBestEnergyValley(
          envelope,
          searchStart,
          searchEnd,
          expectedTime,
          config,
        );

    const fallbackPoint =
      transition ||
      (valley && valley.db <= config.valleyMaxDb ? {
        time: valley.time,
        method: "valley",
        evidenceDb: valley.db,
      } : null);

    if (
      fallbackPoint &&
      fallbackPoint.time - candidate.time >= config.minimumMoveSeconds
    ) {
      const originalTime = candidate.time;
      final[index] = {
        ...candidate,
        time: fallbackPoint.time,
        start: fallbackPoint.time,
        end: fallbackPoint.time,
        duration: 0,
        source: "fallback",
        replacesId: candidate.id,
        fallbackMethod: fallbackPoint.method,
        evidenceDb: fallbackPoint.evidenceDb,
      };

      const refinedTrack = fallbackPoint.time - previousTime;
      acceptedTrackDurations.push(refinedTrack);
      diagnostics.push({
        id: candidate.id,
        originalTime,
        refinedTime: fallbackPoint.time,
        action: "fallback",
        reason:
          fallbackPoint.method === "transition"
            ? `Early split ${currentTrack.toFixed(1)}s vs baseline ${baseline.toFixed(1)}s · sustained transition ${fallbackPoint.evidenceDb.toFixed(1)} dB`
            : `Early split ${currentTrack.toFixed(1)}s vs baseline ${baseline.toFixed(1)}s · energy valley ${fallbackPoint.evidenceDb.toFixed(1)} dBFS`,
      });
    } else {
      acceptedTrackDurations.push(currentTrack);
      diagnostics.push({
        id: candidate.id,
        originalTime: candidate.time,
        refinedTime: candidate.time,
        action: "keep",
        reason: "Fallback search found no qualified later transition or valley",
      });
    }
  }

  return { final, diagnostics };
}

async function buildEnergyEnvelope(audioBuffer, windowSeconds) {
  const sampleRate = audioBuffer.sampleRate;
  const windowFrames = Math.max(1, Math.round(windowSeconds * sampleRate));
  const totalWindows = Math.ceil(audioBuffer.length / windowFrames);
  const channels = Array.from(
    { length: audioBuffer.numberOfChannels },
    (_, index) => audioBuffer.getChannelData(index),
  );
  const envelope = new Array(totalWindows);

  for (let windowIndex = 0; windowIndex < totalWindows; windowIndex += 1) {
    const start = windowIndex * windowFrames;
    const end = Math.min(audioBuffer.length, start + windowFrames);
    const span = Math.max(1, end - start);
    const stride = Math.max(1, Math.floor(span / 256));
    let sumSquares = 0;
    let count = 0;

    for (let sample = start; sample < end; sample += stride) {
      for (const channel of channels) {
        const value = channel[sample] ?? 0;
        sumSquares += value * value;
        count += 1;
      }
    }

    const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0;
    const db = 20 * Math.log10(Math.max(rms, 1e-8));
    envelope[windowIndex] = {
      time: Math.min(
        audioBuffer.duration,
        (start + span / 2) / sampleRate,
      ),
      db,
    };

    if (windowIndex % 900 === 0) {
      await nextFrame();
    }
  }

  return smoothEnergyEnvelope(envelope, 2);
}

function smoothEnergyEnvelope(envelope, radius) {
  if (envelope.length === 0) return [];

  return envelope.map((point, index) => {
    let sum = 0;
    let count = 0;
    const from = Math.max(0, index - radius);
    const to = Math.min(envelope.length - 1, index + radius);

    for (let i = from; i <= to; i += 1) {
      sum += envelope[i].db;
      count += 1;
    }

    return {
      time: point.time,
      db: count > 0 ? sum / count : point.db,
    };
  });
}

function findFirstSustainedTransition(envelope, startTime, endTime, config) {
  if (!(endTime > startTime)) return null;

  const candidates = [];
  for (let index = 1; index < envelope.length - 1; index += 1) {
    const point = envelope[index];
    if (point.time < startTime || point.time > endTime) continue;

    const before = meanEnvelopeDb(
      envelope,
      point.time - config.transitionLookSeconds,
      point.time - config.transitionInnerGapSeconds,
    );
    const after = meanEnvelopeDb(
      envelope,
      point.time + config.transitionInnerGapSeconds,
      point.time + config.transitionLookSeconds,
    );

    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;

    const delta = after - before;
    const magnitude = Math.abs(delta);
    if (magnitude < config.transitionMinDb) continue;

    candidates.push({
      time: point.time,
      magnitude,
      delta,
    });
  }

  if (candidates.length === 0) return null;

  const peaks = candidates.filter((candidate, index) => {
    const previous = candidates[index - 1];
    const next = candidates[index + 1];
    const previousClose =
      previous && candidate.time - previous.time <= config.envelopeWindowSeconds * 2.5;
    const nextClose =
      next && next.time - candidate.time <= config.envelopeWindowSeconds * 2.5;

    const beatsPrevious =
      !previousClose || candidate.magnitude >= previous.magnitude;
    const beatsNext = !nextClose || candidate.magnitude >= next.magnitude;
    return beatsPrevious && beatsNext;
  });

  const chosen = (peaks.length > 0 ? peaks : candidates)[0];
  return {
    time: chosen.time,
    method: "transition",
    evidenceDb: chosen.delta,
  };
}

function meanEnvelopeDb(envelope, startTime, endTime) {
  let sum = 0;
  let count = 0;

  for (const point of envelope) {
    if (point.time < startTime) continue;
    if (point.time >= endTime) break;
    sum += point.db;
    count += 1;
  }

  return count > 0 ? sum / count : Number.NaN;
}

function findBestEnergyValley(envelope, startTime, endTime, expectedTime, config) {
  if (!(endTime > startTime)) return null;

  const inRange = envelope.filter(
    (point) => point.time >= startTime && point.time <= endTime,
  );
  if (inRange.length === 0) return null;

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let index = 1; index < inRange.length - 1; index += 1) {
    const point = inRange[index];
    const previous = inRange[index - 1];
    const next = inRange[index + 1];
    if (point.db > previous.db || point.db > next.db) continue;

    const distanceRatio = Math.min(
      1,
      Math.abs(point.time - expectedTime) / config.searchRadiusSeconds,
    );
    const score = point.db + distanceRatio * config.proximityPenaltyDb;

    if (score < bestScore) {
      best = point;
      bestScore = score;
    }
  }

  if (best) return best;

  return inRange.reduce(
    (lowest, point) => (!lowest || point.db < lowest.db ? point : lowest),
    null,
  );
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function renderCandidateDiagnostics() {
  diagnosticsBody.replaceChildren();

  for (const item of candidateDiagnostics) {
    const row = document.createElement("tr");
    row.className = item.decision;

    appendDiagnosticCell(row, String(item.id));
    appendDiagnosticCell(row, formatTimePrecise(item.time));
    appendDiagnosticCell(row, `${item.duration.toFixed(2)} s`);

    const decisionCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `decision-badge ${item.decision}`;
    badge.textContent =
      item.decision === "selected" ? "SELECTED" : "REJECTED";
    decisionCell.appendChild(badge);
    row.appendChild(decisionCell);

    appendDiagnosticCell(row, item.reason);
    diagnosticsBody.appendChild(row);
  }

  diagnosticsSection.hidden = candidateDiagnostics.length === 0;
}

function renderRefinementDiagnostics() {
  refinementBody.replaceChildren();

  for (const item of refinementDiagnostics) {
    const row = document.createElement("tr");
    row.className = item.action === "fallback" ? "refined" : "kept";

    appendDiagnosticCell(row, `#${item.id}`);
    appendDiagnosticCell(row, formatTimePrecise(item.originalTime));
    appendDiagnosticCell(row, formatTimePrecise(item.refinedTime));

    const actionCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `decision-badge ${item.action}`;
    badge.textContent = item.action === "fallback" ? "FALLBACK" : "KEEP";
    actionCell.appendChild(badge);
    row.appendChild(actionCell);

    appendDiagnosticCell(row, item.reason);
    refinementBody.appendChild(row);
  }

  refinementSection.hidden = refinementDiagnostics.length === 0;
}

function appendDiagnosticCell(row, text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  row.appendChild(cell);
}

function removeAudio() {
  decodedAudio = null;
  waveformPeaks = null;
  rawCandidates = [];
  selectedCandidates = [];
  finalCandidates = [];
  candidateDiagnostics = [];
  refinementDiagnostics = [];
  fileInput.value = "";
  analyzeButton.disabled = true;
  removeButton.disabled = true;
  candidateCountEl.textContent = "Raw: — · Cleanup: — · Final: —";
  diagnosticsSection.hidden = true;
  diagnosticsBody.replaceChildren();
  refinementSection.hidden = true;
  refinementBody.replaceChildren();

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
  if (!duration || rawCandidates.length === 0) return;

  const selectedIds = new Set(selectedCandidates.map((candidate) => candidate.id));
  const displayFinal =
    finalCandidates.length > 0
      ? finalCandidates
      : selectedCandidates.map((candidate) => ({
          ...candidate,
          source: "silence",
        }));
  const finalById = new Map(displayFinal.map((candidate) => [candidate.id, candidate]));

  ctx.save();
  ctx.strokeStyle = "#76552f";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.globalAlpha = 0.65;

  for (const candidate of rawCandidates) {
    if (selectedIds.has(candidate.id)) continue;
    const x = Math.max(0, Math.min(width, (candidate.time / duration) * width));

    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, drawHeight);
    ctx.stroke();
  }

  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "#b87535";
  ctx.lineWidth = 1.2;
  ctx.setLineDash([5, 4]);
  ctx.globalAlpha = 0.8;

  for (const candidate of selectedCandidates) {
    const finalCandidate = finalById.get(candidate.id);
    if (
      !finalCandidate ||
      Math.abs(finalCandidate.time - candidate.time) < 0.05
    ) {
      continue;
    }

    const x = Math.max(0, Math.min(width, (candidate.time / duration) * width));
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, drawHeight);
    ctx.stroke();
  }

  ctx.restore();

  for (const candidate of displayFinal) {
    const isFallback = candidate.source === "fallback";
    const color = isFallback ? "#ff7aa8" : "#f0a44b";
    const x = Math.max(0, Math.min(width, (candidate.time / duration) * width));

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = isFallback ? 2 : 1.6;

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
    ctx.restore();
  }
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

function formatTimePrecise(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const minutes = Math.floor(seconds / 60);
  const secs = seconds - minutes * 60;
  return `${minutes}:${secs.toFixed(2).padStart(5, "0")}`;
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
