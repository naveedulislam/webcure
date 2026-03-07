// ---------------------------------------------------------------------------
// WebCure -- Shared TypeScript types
// ---------------------------------------------------------------------------

/** A single recorded automation action. */
export interface RecordedAction {
    /** Unix timestamp (milliseconds). */
    timestamp: number;
    /** Command name, e.g. "click", "navigate". */
    command: string;
    /** Arguments passed to the command. */
    args: Record<string, unknown>;
    /** Who initiated the action. */
    source: 'agent' | 'user';
    /** Whether the action was approved (always true if it executed). */
    approved: boolean;
}
