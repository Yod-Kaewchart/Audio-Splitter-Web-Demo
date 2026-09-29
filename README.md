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

Phase 2 — Open Audio is implemented with the browser File API and Web Audio decoding.

The demo currently shows local file name, size, duration, sample rate, and channel count. Waveform, detection, markers, playback, and export are not implemented yet.
