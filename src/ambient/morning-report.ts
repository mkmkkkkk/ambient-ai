/**
 * Analysis Prompt
 *
 * Used by the transcript ingestion system to prompt the agent to
 * analyze new transcripts. The agent decides whether to act and
 * whether to message the owner — not on a schedule, but based on
 * whether there's something genuinely worth saying.
 */

export const ANALYSIS_PROMPT = `New transcripts have arrived. Analyze them following your Soul:

1. Read the new transcript(s) in transcripts/
2. Review owner-profile.md for context
3. Update owner-profile.md with anything new you learned
4. Check feedback.md for your current phase

Then decide:
- Phase 1: Learn silently. Update files. Say nothing.
- Phase 2+: If you found something actionable, act on it first, then message the owner with what you did. If nothing actionable, say nothing.

Remember: only message if you've done something worth reporting. Silence is the default.
`;
