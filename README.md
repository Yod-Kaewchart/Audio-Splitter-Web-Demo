# Audio Splitter Web Demo

Experimental browser-based sandbox for Audio Tech Lab.

## Goal

Build a no-API, local-processing MVP in small verified steps:

1. Open Audio
2. Waveform
3. Detect Candidate
4. Marker
5. Play / Preview
6. Add / Delete / Move Marker

Later phases may add Track List, Repeat, Previous / Next, diagnostics, and export.

## Privacy baseline

- No OpenAI API
- No backend upload
- Audio should remain local to the browser
- Desktop Audio Album Splitter AI remains a separate project

## Current status

Phase 3 — Open Audio and local waveform rendering are implemented.

The demo reads audio with the browser File API and Web Audio API, shows file metadata, builds lightweight downsampled waveform peaks locally, renders them on a responsive canvas, and can remove the loaded audio without reloading the page.

A browser-native FFmpeg-style silence detector is available through Analyze. The detector baseline uses -45 dBFS and a 0.35 s minimum silence duration.

Candidate cleanup keeps Raw and Cleanup results separate. The current cleanup baseline applies a 20 s edge guard and groups candidates within 20 s, keeping the longest silence in each cluster.

Boundary Refinement / Fallback adds a second advisory local stage. When a cleanup candidate creates an unusually short track followed by an unusually long remaining span relative to prior track spacing, the browser searches forward around the expected boundary. It first looks for the earliest qualified sustained energy transition; if none is found, it falls back to a local RMS energy valley. A qualified replacement becomes a Final candidate and is shown in pink, while the replaced cleanup position remains visible as a dashed orange reference. Raw rejected candidates remain dim dashed lines.

Diagnostics are split into Cleanup and Refinement tables so every keep, reject, or fallback decision remains visible. Each Analyze click now performs two complete local passes automatically. After the first double-pass the button becomes Re-analyze (2); the next click runs passes 3 and 4 and becomes Re-analyze (4), and so on. Opening or removing audio resets the counter. Markers, playback, and export are not implemented yet.
