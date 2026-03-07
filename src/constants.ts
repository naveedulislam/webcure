// ---------------------------------------------------------------------------
// WebCure -- Extension-wide constants
// ---------------------------------------------------------------------------

/** VS Code command ID prefix. */
export const COMMAND_PREFIX = 'webcure';

/** VS Code Output Channel name. */
export const OUTPUT_CHANNEL = 'WebCure Tools';

/** VS Code configuration section. */
export const CONFIG_SECTION = 'webcure';

/** File bridge directory name (created in workspace root). */
export const BRIDGE_DIR = '.webcure';

/** File bridge input filename (agent writes commands here). */
export const BRIDGE_INPUT = 'input.json';

/** File bridge output filename (extension writes results here). */
export const BRIDGE_OUTPUT = 'output.json';

/** File bridge CLI script filename. */
export const BRIDGE_CLI = 'cli.js';
