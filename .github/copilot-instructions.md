# Copilot Instructions for Pomodoro Task (Obsidian Plugin)

## Project Overview
This is an Obsidian plugin ("Pomodoro Task") that integrates a Pomodoro timer with Markdown tasks. It tracks time spent on specific tasks identified by a tag (default `#pomodoro`) and logs completion counts directly into the Markdown file.

## Architecture & Code Structure
- **Monolithic `main.ts`**: The core logic resides in a single file `main.ts` (~1000 lines). It contains:
  - `PomodoroTaskPlugin` (Main entry)
  - `TimerService` (State machine & Business logic)
  - `PomodoroView` (UI implementation)
  - `PomodoroSettingTab` (Settings UI)
  - Data interfaces (`PomodoroSession`, `PomodoroStats`)
- **State Management**:
  - `TimerService` holds the runtime state.
  - State is persisted to `data.json` via `plugin.saveAllData()`, which merges settings, stats, and active timer state.

## Critical Developer Workflows
- **Build & Hot Reload**:
  - The project uses `esbuild`.
  - configuration: [esbuild.config.mjs](esbuild.config.mjs).
  - **IMPORTANT**: The build script contains a **custom copy plugin** that modifies local vault files.
  - `VAULT_PLUGIN_DIR` constant in `esbuild.config.mjs` points to a specific local path (`C:\Obsidian Vault\Estudo...`). This IS the deployment mechanism.
- **Commands**:
  - `npm run dev`: Watches for changes and updates the local vault.
  - `npm run build`: Production build (minified, no sourcemaps).

## Key Patterns & Conventions
- **Task Logging (Regex)**:
  - The plugin parses task lines using regex like `/\[🍅::\s*(\d+)(?:\s*\/\s*(\d+))?\]/`.
  - It modifies files directly using `app.vault.modify(file, content)`.
  - Logic is centralized in `TimerService.logCompletion`.
- **UI Updates**:
  - **Hybrid Rendering**:
    - `render()`: Builds the entire DOM structure. Used for state changes (Idle -> Work).
    - `updateTimerUI()`: Updates *only* the text content of the timer display every second to avoid flickering/performance cost.
- **Subtask Handling**:
  - Subtasks are identified by indentation below the main task.
  - They are rendered in the Timer View and interactively toggled, syncing state back to the markdown file immediately.

## Integration Details
- **Obsidian API**: Heavy usage of `TFile`, `ItemView`, `WorkspaceLeaf`.
- **Icons**: Use `setIcon(element, 'icon-name')` from the `obsidian` package.
- **Styles**: All styles in [styles.css](styles.css). Class names prefixed with `pomodoro-`.

## Common Pitfalls
- **File Edits**: When the plugin edits a file (to log a tomato), it must read the *latest* content from disk (`vault.read(file)`) to avoid race conditions or overwriting user edits.
- **Line Tracking**: The plugin relies on line numbers but attempts to verify content via string matching (`line.includes(...)`) before editing, to handle lines moving around.
