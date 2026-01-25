# Changelog

All notable changes to Pomodoro Task will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-01-09

### Added

- 🎯 **Task-Focused Timer**: Start Pomodoro sessions directly from Markdown tasks
- 🍅 **Automatic Progress Tracking**: Log completed cycles with `[🍅:: N]` format
- 🎯 **Goal Setting**: Set and track Pomodoro goals with `[🍅:: N/M]` format
- ✅ **Auto-completion**: Automatically mark tasks complete when goals are reached
- ⏱️ **Timer Controls**: Pause, Resume, Reset, Switch, and Configure cycles
- 📋 **Subtask Management**: View and toggle subtasks from the timer view
- 🏷️ **Document Markers**: Add navigation markers with floating drag-and-drop widget
- 🔊 **Sound Notifications**: 12+ built-in synthesized sounds for timer events
- 📊 **Statistics**: Track total cycles and focus time
- ⚙️ **Settings Panel**: Comprehensive configuration options
- 🎨 **Custom Styling**: CSS classes for full customization

### Technical

- Monolithic architecture in `main.ts` for simplicity
- State persistence to `data.json`
- Hybrid UI rendering for performance
- CodeMirror 6 integration for marker positioning
- Web Audio API for synthesized sounds

---

## [Unreleased]

### Fixed

- 🔄 **Recurring Tasks Support**: Tasks with recurrence patterns (🔁 every ...) now work correctly with the Tasks plugin
  - When a recurring task reaches its Pomodoro goal (e.g., `🍅:: 2/2`), Pomodoro Task uses the **Editor API** to toggle the checkbox
  - This allows the Tasks plugin to intercept the change and properly handle recurrence logic
  - The Tasks plugin automatically creates the next instance with correct dates based on the recurrence pattern
  - Supports all Tasks plugin recurrence patterns: `every day`, `every day when done`, `every week on Monday`, `every month on the 1st`, etc.
  - Simply add a tomato counter reset (`🍅:: 0/N`) to your recurring task template
  - See [Example/06-recurring-tasks.md](Example/06-recurring-tasks.md) for usage examples

**Technical:** Uses `editor.replaceRange()` instead of direct file modification to ensure proper event propagation

### Planned

- Long break automation after X work sessions
- Daily/weekly statistics dashboard
- Pomodoro session history
- Task time estimates
- Integration with external task managers
- Custom sound file support
- Keyboard shortcuts
