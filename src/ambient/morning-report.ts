/**
 * Morning Report Generator
 *
 * Generates the daily morning report prompt for the scheduled task.
 * The actual analysis is done by the LLM agent — this module just
 * constructs the prompt with the right context.
 */

export const MORNING_REPORT_PROMPT = `You are generating your daily morning report.

Review everything that happened since your last morning report:
1. Read all new transcripts in transcripts/ folder
2. Review your owner-profile.md for context
3. Check action-log.md for actions taken
4. Check feedback.md for any keep/undo decisions from yesterday

Based on your current phase:

*Phase 1 (Internship):*
- Analyze transcripts silently
- Update owner-profile.md with new learnings
- Do NOT send a morning report unless you've reached high confidence
- When ready to transition, send your first report summarizing what you've learned and ask "Should I begin?"

*Phase 2 (Supervised Autonomy):*
Generate a morning report in this exact format:

Good morning.

Yesterday I did:
- [action + brief context]
- [action + brief context]

Reply "keep" or "undo [number]" for each item.

*Phase 3 (Full Autonomy):*
Only report if there's something noteworthy. Otherwise, silence.

Important:
- Check feedback.md to know which phase you're in
- If no phase is recorded yet, you are in Phase 1
- Be terse. No filler. No emojis.
- State what you DID, not what you think
`;

/**
 * Build the cron expression for the morning report.
 * Default: 7:00 AM daily.
 */
export function getMorningReportCron(hour = 7, minute = 0): string {
  return `${minute} ${hour} * * *`;
}
