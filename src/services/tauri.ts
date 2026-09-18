// Tauri invoke wrapper — public command surface.
//
// Commands are now defined in domain modules so each interaction mode owns its
// own surface and the two modes never share a command file:
//   - `chatCommands.ts`   — single-user ↔ agent (chat) mode
//   - `groupCommands.ts`  — multi-agent roundtable (group) mode
//   - `calendarCommands.ts` — schedule mode
//
// This file only re-exports them for backward compatibility. New mode code
// should import the specific domain module directly (e.g. group components
// `import * as groupCommands from "./groupCommands"`) to keep the modes
// independent.
export * from "./chatCommands";
export * from "./groupCommands";
export * from "./calendarCommands";
