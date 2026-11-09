# Agistra Dev — Installation Guide

This is the free Agistra Dev hub: a set of Claude Code agent profiles (Architect, Builder,
Tester, Router), skills, and a local task queue that run from a directory on your machine.

## Prerequisites

- **Node.js 22 or later** — [nodejs.org](https://nodejs.org)
- **Claude Code** — the Anthropic CLI (`npm install -g @anthropic-ai/claude-code`)

## Quick start

1. Unzip this archive to a directory of your choice, for example:

   ```
   C:\Users\you\agistra-dev\
   ```

2. Open a terminal in that directory and run:

   ```
   npm run setup
   ```

   Setup writes your `workspace.config.json`, personalises the agent profiles, and runs
   readiness checks.

3. When prompted, enter your name and role. These personalise the agent profiles.

4. After setup completes, run the health check:

   ```
   npm run doctor
   ```

   All checks should be green. If any are amber or red, the doctor output explains the fix.

5. Launch Claude Code from the hub directory:

   ```
   claude
   ```

   Address Architect to begin: `Architect, morning briefing please.`

## What's inside

| Path | Description |
|---|---|
| `.claude/` | Claude Code agent profiles and settings |
| `.cursor/` | Cursor agent profiles (if you use Cursor) |
| `pipelines/deploy/` | Hub CLI: `setup`, `doctor`, `dispatch`, `scan` |
| `skills/` | Agent skill files |
| `projects/` | Local task queue and registered projects |
| `INSTALL.md` | This file |

## Updating

To update your hub:

1. Run `npm run version:check` to see whether a newer hub release is available.
2. Update: run `git pull` if you cloned the hub, or download the new release from [agistra.ai](https://agistra.ai) and copy it over your hub folder, keeping your own files (`workspace.config.json`, `.env`, `memory/`).
3. Run `npm run doctor`. If it reports missing hub hooks or settings, run `npm run setup` to restore them.

## Support

- GitHub: [Agistra/agistra.dev](https://github.com/Agistra/agistra.dev) — open an issue
- Run `npm run doctor` for a health overview of your hub configuration
