// ---------------------------------------------------------------------------
// WebCure -- Action recorder (logs actions for script generation)
// ---------------------------------------------------------------------------

import type { RecordedAction } from '../types';

let recording = false;
const actionLog: RecordedAction[] = [];
let persistFn: ((recording: boolean, actions: RecordedAction[]) => void) | undefined;

/**
 * Optionally wire up a persistence callback so recorded actions
 * survive extension-host restarts (e.g. when the browser is closed).
 */
export function initRecorder(
	persist?: (recording: boolean, actions: RecordedAction[]) => void,
): void {
	persistFn = persist;
}

export function startRecording(): void {
	actionLog.length = 0;
	recording = true;
	persistFn?.(true, []);
}

export function stopRecording(): RecordedAction[] {
	recording = false;
	const result = [...actionLog];
	persistFn?.(false, result);
	return result;
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
	persistFn?.(true, [...actionLog]);
}
