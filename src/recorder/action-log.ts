// ---------------------------------------------------------------------------
// WebCure -- Action recorder (logs actions for script generation)
// ---------------------------------------------------------------------------

import type { RecordedAction } from '../types';

let recording = false;
const actionLog: RecordedAction[] = [];

export function startRecording(): void {
    actionLog.length = 0;
    recording = true;
}

export function stopRecording(): RecordedAction[] {
    recording = false;
    return [...actionLog];
}

export function isRecording(): boolean {
    return recording;
}

export function recordAction(
    command: string,
    args: Record<string, unknown>,
    source: 'agent' | 'user' = 'user',
): void {
    if (!recording) {
        return;
    }
    actionLog.push({
        timestamp: Date.now(),
        command,
        args,
        source,
        approved: true,
    });
}

export function getActionLog(): readonly RecordedAction[] {
    return actionLog;
}
