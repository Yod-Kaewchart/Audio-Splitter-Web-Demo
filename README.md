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

Candidate cleanup now keeps Raw and Selected results separate. The current cleanup baseline applies a 20 s edge guard and groups candidates within 20 s, keeping the longest silence in each cluster. Selected candidates are drawn as solid orange lines while rejected raw candidates remain visible as dim dashed lines. A diagnostics table records each raw candidate time, silence duration, cleanup decision, and reason. Markers, playback, and export are not implemented yet.
