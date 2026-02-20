# Ambient AI

A silent personal assistant that wears a microphone, listens to your entire day, and acts autonomously — without being asked.

Built on [NanoClaw](https://github.com/qwibitai/nanoclaw) (~3,700 lines TypeScript). MIT license.

## What It Does

You clip a recorder to your collar. Go about your day. Talk to people, make promises, complain about things, have ideas.

Ambient AI listens to all of it. Then it acts:

- You told a colleague "I'll send you the deck by Friday" → it drafts the email
- You complained about a leaking faucet three times → it books a plumber
- You promised your mom you'd call this weekend → it surfaces a reminder Saturday
- You forgot to reply to an important email → it drafts the response
- Your car registration expires next month → it starts the renewal

No commands. No "Hey Siri." No interaction required. It just handles things.

## The Three Phases

**Phase 1: Internship** (~60 days)
Listen only. Learn who you are — habits, relationships, frustrations, values. Never act. Never suggest.

**Phase 2: Supervised Autonomy**
Start acting. Report what was done:
```
I booked a plumber for Thursday 2pm because you mentioned the leak three times.

Keep or undo?
```

**Phase 3: Full Autonomy**
Stop asking. Just run. Only confirm for high-stakes actions (money, legal, new contacts).

## Architecture

```
Recorder (clip-on mic)
    ↓ USB copy
data/audio-inbox/
    ↓ File watcher (polls every 5s)
WAV splitter (chunks >24MB files)
    ↓
Whisper API (speech-to-text, ~$0.006/min)
    ↓ Inject as messages
NanoClaw (Claude Agent SDK in containers)
    ↓ Acts per SOUL.md rules
WhatsApp (owner communication)
```

Single Node.js process. Container-isolated agent execution. SQLite storage.

### Key Files

| File | Purpose |
|------|---------|
| `groups/global/CLAUDE.md` | **Soul** — agent personality and behavior rules |
| `src/ambient/transcript-ingest.ts` | Watches inbox, transcribes, injects into agent |
| `src/ambient/wav-splitter.ts` | Splits large WAV files (pure Node.js, no ffmpeg) |
| `scripts/import-recordings.sh` | Copies recordings from USB to inbox |
| `groups/main/owner-profile.md` | Evolving model of the owner |
| `groups/main/feedback.md` | Keep/undo decisions — learning signal |
| `groups/main/mistakes.md` | Errors made, never to repeat |

## Hardware

Any recorder that saves standard audio files (.wav, .mp3, etc).

| Device | Price | Battery | Notes |
|--------|-------|---------|-------|
| USB voice recorder | $5-15 | 10-20hr | Cheapest. USB copy. |
| DJI Mic 2 (TX only) | $89 | 6hr | Best audio. 32-bit WAV. |
| Omi DevKit 2 | $89 | 10-14hr | Open source. BLE stream. |

Whisper handles low-quality audio fine. Buy the cheapest thing that clips to your collar.

## Setup

```bash
git clone https://github.com/mkmkkkkk/ambient-ai.git
cd ambient-ai
npm install
cp .env.example .env     # Add your OpenAI API key
npm run build
./container/build.sh      # Build agent container
npm run auth              # Scan WhatsApp QR code
npm start
```

Requirements: Node.js 20+, [Apple Container](https://github.com/apple/container) or Docker, OpenAI API key.

## Daily Workflow

```bash
# Plug in USB recorder, then:
./scripts/import-recordings.sh /Volumes/RECORDER

# Done. The system handles the rest automatically.
```

The import script finds all `.wav` files on the drive, copies new ones to `data/audio-inbox/`, and skips already-imported files. The transcript ingest watcher picks them up, transcribes via Whisper, and feeds to the agent.

### How Large Files Work

A 10-hour recording at 1MB/min = ~600MB. Whisper API has a 25MB limit. The system automatically splits large WAV files into <24MB chunks, transcribes each with context from the previous chunk for continuity. Pure Node.js — no ffmpeg required.

**Cost:** ~$3.60 for 10 hours of audio.

## Configuration

```bash
# .env
OPENAI_API_KEY=sk-proj-...      # For Whisper
AMBIENT_INBOX_DIR=data/audio-inbox
ASSISTANT_NAME=Ambient
TZ=America/Los_Angeles
```

## Development

```bash
npm run dev          # Hot reload
npm run build        # Compile TypeScript
npm run typecheck    # Type check
npm test             # Tests
```

## Philosophy

> The owner should forget you exist. Their life just... works better. Small annoyances disappear. Things get done before they become urgent. Nothing falls through the cracks.
>
> They don't know how. They don't care how. It just works.

The $80,000/year executive assistant that costs $20/month and never sleeps.

## Credits

Built on [NanoClaw](https://github.com/qwibitai/nanoclaw) by [@gavrielc](https://github.com/gavrielc).

## License

MIT
