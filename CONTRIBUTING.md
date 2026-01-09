# Contributing to Pomodoro Task

First off, thank you for considering contributing to Pomodoro Task! 🍅

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the existing issues to see if the problem has already been reported. When you create a bug report, include as many details as possible:

- **Use a clear and descriptive title**
- **Describe the exact steps to reproduce the problem**
- **Describe the behavior you observed and what you expected**
- **Include screenshots if possible**
- **Include your Obsidian version and OS**

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion:

- **Use a clear and descriptive title**
- **Provide a detailed description of the suggested enhancement**
- **Explain why this enhancement would be useful**

### Pull Requests

1. Fork the repository
2. Create a new branch: `git checkout -b feature/amazing-feature`
3. Make your changes
4. Build the project: `npm run build`
5. Test your changes in Obsidian
6. Commit your changes: `git commit -m 'Add amazing feature'`
7. Push to the branch: `git push origin feature/amazing-feature`
8. Open a Pull Request

## Development Setup

### Prerequisites

- Node.js (v16 or higher)
- npm

### Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/pomodoro-task.git

# Navigate to the project
cd pomodoro-task

# Install dependencies
npm install

# Build for development (watch mode)
npm run dev

# Build for production
npm run build
```

### Project Structure

```
pomodoro-task/
├── main.ts          # Main plugin code (monolithic architecture)
├── styles.css       # All CSS styles
├── manifest.json    # Plugin metadata
├── package.json     # Project configuration
├── esbuild.config.mjs  # Build configuration
└── README.md        # Documentation
```

### Architecture Notes

- **Monolithic `main.ts`**: The core logic resides in a single file containing:
  - `PomodoroTaskPlugin` (Main entry)
  - `TimerService` (State machine & Business logic)
  - `PomodoroView` (UI implementation)
  - `PomodoroSettingTab` (Settings UI)
  - Data interfaces

- **State Management**: `TimerService` holds the runtime state, persisted to `data.json` via `plugin.saveAllData()`

- **Task Logging**: Uses regex to parse and update task lines with the Pomodoro counter format `[🍅:: N]` or `[🍅:: N/M]`

## Code Style

- Use TypeScript
- Follow existing code patterns
- Add comments for complex logic
- Test thoroughly before submitting PR

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
