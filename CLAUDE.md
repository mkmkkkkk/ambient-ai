# Ambient AI

Silent personal assistant that listens, learns, and acts autonomously. Built on NanoClaw.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in containers. The ambient layer adds:
- Audio transcript ingestion (Whisper API)
- Three-phase trust model (Internship → Supervised → Full Autonomy)
- Event-driven communication (agent speaks only when it has something worth saying)
- Owner profile learning

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/ambient/transcript-ingest.ts` | Watches audio-inbox, transcribes, injects as messages |
| `src/ambient/morning-report.ts` | Analysis prompt for transcript processing |
| `src/config.ts` | Trigger pattern, paths, intervals, ambient config |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/global/CLAUDE.md` | SOUL — agent personality and behavior rules |
| `groups/main/CLAUDE.md` | Main channel config and workspace structure |
| `groups/main/owner-profile.md` | Evolving model of the owner |
| `groups/main/feedback.md` | Keep/undo decisions |
| `groups/main/mistakes.md` | Errors made, never to repeat |
| `groups/main/action-log.md` | Actions taken, with timestamps |
| `groups/main/transcripts/` | Raw audio transcripts |

## How It Works

1. Owner wears a microphone (any recorder)
2. Audio files drop into `data/audio-inbox/`
3. Whisper API transcribes → stored as messages in SQLite
4. Agent processes transcripts following SOUL.md rules
5. Phase 1: listen only. Phase 2: act then report. Phase 3: silent autonomy.

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

## Container Build Cache

Apple Container's buildkit caches aggressively. To force a clean rebuild:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```
