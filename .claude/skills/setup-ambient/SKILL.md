---
name: setup-ambient
description: Set up the Ambient AI morning report scheduled task after the main group is connected.
---

# Setup Ambient Morning Report

After the user has connected WhatsApp and registered the main group, this skill sets up the daily morning report as a scheduled task.

## Prerequisites

- WhatsApp must be connected
- Main group must be registered
- The main group CLAUDE.md should contain the Soul personality

## Implementation

### Step 1: Check Current State

Read the database to see if a morning report task already exists:

```bash
sqlite3 store/messages.db "SELECT id, prompt, schedule_value, status FROM scheduled_tasks WHERE prompt LIKE '%morning report%'"
```

If a task already exists, inform the user and ask if they want to update it.

### Step 2: Find Main Group JID

```bash
sqlite3 store/messages.db "SELECT jid FROM registered_groups WHERE folder = 'main' LIMIT 1"
```

### Step 3: Create the Morning Report Task

The morning report prompt should be:

```
You are generating your daily morning report.

Review everything that happened since your last morning report:
1. Read all new transcripts in transcripts/ folder
2. Review your owner-profile.md for context
3. Check action-log.md for actions taken
4. Check feedback.md for any keep/undo decisions from yesterday

Based on your current phase:

Phase 1 (Internship):
- Analyze transcripts silently
- Update owner-profile.md with new learnings
- Do NOT send a morning report unless you've reached high confidence
- When ready to transition, send your first report summarizing what you've learned

Phase 2 (Supervised Autonomy):
Generate a brief morning report of actions taken. Keep it terse.

Phase 3 (Full Autonomy):
Only report if there's something noteworthy. Otherwise, silence.
```

Use the `schedule_task` MCP tool (from within the container) or insert directly into the database:

```bash
MAIN_JID=$(sqlite3 store/messages.db "SELECT jid FROM registered_groups WHERE folder = 'main' LIMIT 1")
TASK_ID="morning-report-$(date +%s)"

sqlite3 store/messages.db "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at) VALUES ('$TASK_ID', 'main', '$MAIN_JID', 'Generate your daily morning report. Review transcripts/, owner-profile.md, action-log.md, and feedback.md. Follow the phase-appropriate behavior from your CLAUDE.md.', 'cron', '0 7 * * *', 'group', datetime(''now'', ''+1 day'', ''start of day'', ''+7 hours''), 'active', datetime(''now''))"
```

### Step 4: Confirm

Use the AskUserQuestion tool:

> Morning report scheduled for 7:00 AM daily.
>
> To change the time, update the cron expression in the database or tell me your preferred time.
>
> The assistant is now in Phase 1 (Internship) — it will listen and learn for the first ~60 days before taking any autonomous actions.

### Step 5: Create Audio Inbox

Ensure the audio inbox directory exists:

```bash
mkdir -p data/audio-inbox
```

Tell the user:

> Drop audio files (.wav, .mp3, .m4a, .txt) into `data/audio-inbox/`.
> They'll be automatically transcribed and ingested.
>
> For continuous recording, connect your phone or wearable recorder to sync files to this directory.
