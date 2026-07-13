# wolgan/monika-bootstrap

author: wolgan (with Claude)
started: 2026-07-13

## Goal

One-file, zero-knowledge onboarding for Monika's studio.

## The idea

She makes an empty folder, drops in a single `CLAUDE.md`, runs `claude`,
says „cześć" — and her Claude becomes the installer, the guide, and the
introducer: tools, GitHub sign-in, pulling the repo into that folder
(the bootstrap file deletes itself and is replaced by the project's own
CLAUDE.md — the guide dissolves into the project brain), starting the
app, then a spoken introduction to what OCEAN is and how the two studios
flow together. The human never types a technical command; the hardest
thing she does is paste a login code into a browser.

## What it should feel like

Like a colleague who arrives before you, sets up the whole studio, and
greets you at the door with the tour.

## Log

- bootstrap/CLAUDE.md written (guide persona, tool checks + winget,
  gh auth walkthrough, clone-into-nonempty-folder sequence with the
  self-deletion handover, read-in order, dev server, project intro,
  phrase-book incl. provenance briefing phrase).
- SETUP_MONIKA.md simplified: the one-file path is now the recommended
  route; manual steps kept as fallback.
