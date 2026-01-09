import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, TFile, setIcon, moment } from 'obsidian';

// --- DATA MODELS ---

interface PomodoroTaskSettings {
    tag: string;
    workDuration: number; // minutes
    shortBreakDuration: number;
    longBreakDuration: number;
    subtaskCount: number;
    enableSubtaskLimit: boolean;
    defaultSubtasksExpanded: boolean;
    showCompletedSubtasks: boolean;
    showCompletedToday: boolean;
}

const DEFAULT_SETTINGS: PomodoroTaskSettings = {
    tag: '#pomodoro',
    workDuration: 25,
    shortBreakDuration: 5,
    longBreakDuration: 15,
    subtaskCount: 3,
    enableSubtaskLimit: true,
    defaultSubtasksExpanded: true,
    showCompletedSubtasks: false,
    showCompletedToday: false
}

interface PomodoroSession {
    state: 'IDLE' | 'WORK' | 'BREAK';
    startTime: number | null; // Timestamp
    duration: number; // Minutes
    taskId: string | null; // Unique ID for the task (file path + line number approximately)
    taskLine: number;
    taskFile: string;
    taskText: string;
    completedSubtasks: string[]; // List of subtask texts completed in this session
    pausedTime?: number | null; // Timestamp when paused
}

interface PomodoroStats {
    completedSessions: number;
    totalWorkDuration: number; // in minutes
}

const DEFAULT_STATS: PomodoroStats = {
    completedSessions: 0,
    totalWorkDuration: 0
}

// --- TIMER SERVICE ---

class TimerService {
    plugin: PomodoroTaskPlugin;
    state: PomodoroSession = {
        state: 'IDLE',
        startTime: null,
        duration: 0,
        taskId: null,
        taskLine: -1,
        taskFile: '',
        taskText: '',
        completedSubtasks: []
    };
    intervalId: any;

    constructor(plugin: PomodoroTaskPlugin) {
        this.plugin = plugin;
    }

    async loadState() {
        const saved = await this.plugin.loadData();
        if (saved && saved.timerState) {
            this.state = saved.timerState;
            // If we were running, resume the interval
            if (this.state.state !== 'IDLE') {
                this.startTick();
            }
        }
    }

    async saveState() {
        // We save the timer state. Settings and Stats are saved via plugin.saveData in general
        await this.plugin.saveAllData();
    }

    startSession(task: { file: TFile, line: number, text: string }, type: 'WORK' | 'BREAK') {
        const duration = type === 'WORK'
            ? this.plugin.settings.workDuration
            : this.plugin.settings.shortBreakDuration;

        this.state = {
            state: type,
            startTime: Date.now(),
            duration: duration,
            taskId: task.file.path + ':' + task.line,
            taskLine: task.line,
            taskFile: task.file.path,
            taskText: task.text,
            completedSubtasks: []
        };
        this.saveState();
        this.startTick();
        this.plugin.refreshView();
    }

    stopSession() {
        this.clearInterval();
        this.state = {
            state: 'IDLE',
            startTime: null,
            duration: 0,
            taskId: null,
            taskLine: -1,
            taskFile: '',
            completedSubtasks: [],
            taskText: '',
            pausedTime: null
        };
        this.saveState();
        this.plugin.refreshView();
    }

    pauseSession() {
        if (this.state.state !== 'IDLE' && !this.state.pausedTime) {
            this.state.pausedTime = Date.now();
            this.clearInterval();
            this.saveState();
            this.plugin.refreshView();
        }
    }

    resumeSession() {
        if (this.state.state !== 'IDLE' && this.state.pausedTime && this.state.startTime) {
            const pauseDuration = Date.now() - this.state.pausedTime;
            this.state.startTime += pauseDuration;
            this.state.pausedTime = null;
            this.saveState();
            this.startTick();
            this.plugin.refreshView();
        }
    }

    startTick() {
        this.clearInterval();
        if (this.state.pausedTime) return; // Don't tick if paused

        this.intervalId = setInterval(() => {
            const timeLeft = this.getTimeLeft();
            if (timeLeft <= 0) {
                this.completeSession();
            }
            // Update UI every second
            this.plugin.updateTimerUI();
        }, 1000);
    }

    clearInterval() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    getTimeLeft(): number { // in seconds
        if (!this.state.startTime) return 0;

        const now = this.state.pausedTime || Date.now();
        const elapsedSec = (now - this.state.startTime) / 1000;
        const totalSec = this.state.duration * 60;
        return Math.max(0, totalSec - elapsedSec);
    }

    async completeSession() {
        this.clearInterval();

        // Log to file if it was a WORK session
        if (this.state.state === 'WORK') {
            await this.logCompletion();
            // Update Stats
            this.plugin.stats.completedSessions += 1;
            this.plugin.stats.totalWorkDuration += this.state.duration;
            await this.plugin.saveAllData();

            new Notice("Pomodoro Finished! Time for a break.");

            this.stopSession();

        } else {
            new Notice("Break Finished! Ready to work?");
            this.stopSession();
        }
    }

    async logCompletion() {
        // Reload file content to get fresh state
        const file = this.plugin.app.vault.getAbstractFileByPath(this.state.taskFile);
        if (file instanceof TFile) {
            const content = await this.plugin.app.vault.read(file);
            const lines = content.split('\n');
            const lineIdx = this.state.taskLine;

            // Check boundaries
            if (lineIdx < lines.length) {
                let line = lines[lineIdx];

                // Check if line looks like our task (basic check)
                if (line.includes(this.state.taskText.substring(0, 5))) {

                    // Regex to find [🍅:: N] or [🍅:: N/M]
                    const tomatoRegex = /\[🍅::\s*(\d+)(?:\s*\/\s*(\d+))?\]/;
                    const match = line.match(tomatoRegex);

                    let newLine = line;

                    if (match) {
                        // Increment existing counter
                        const currentCount = parseInt(match[1]);
                        const goalStr = match[2]; // undefined if no goal
                        let goal: number | null = null;

                        const newCount = currentCount + 1;
                        let newLabel = `[🍅:: ${newCount}`;

                        if (goalStr) {
                            newLabel += `/${goalStr}`;
                            goal = parseInt(goalStr);
                        }
                        newLabel += `]`;

                        // Replace the old tag with the new one
                        newLine = line.replace(match[0], newLabel);

                        // Completion Logic: If goal met, mark task as checked
                        if (goal !== null && newCount >= goal) {
                            // Regex for standard markdown task: "- [ ]" or "* [ ]"
                            const checkboxRegex = /^(\s*[-*+]\s*)\[ \]/;
                            if (checkboxRegex.test(newLine)) {
                                newLine = newLine.replace(checkboxRegex, '$1[x]');
                            }
                        }

                    } else {
                        // No counter found, start a new one
                        newLine = `${line} [🍅:: 1]`;
                    }

                    // Save changes
                    lines[lineIdx] = newLine;
                    await this.plugin.app.vault.modify(file, lines.join('\n'));
                } else {
                    new Notice("Task line changed? Could not log time to the exact line.");
                }
            }
        }
    }
}

// --- VIEW ---

export const POMODORO_VIEW_TYPE = "pomodoro-view";

export class PomodoroView extends ItemView {
    plugin: PomodoroTaskPlugin;
    showSubtasks: boolean;

    constructor(leaf: WorkspaceLeaf, plugin: PomodoroTaskPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.showSubtasks = this.plugin.settings.defaultSubtasksExpanded;
    }

    getViewType() { return POMODORO_VIEW_TYPE; }
    getDisplayText() { return "Pomodoro Task"; }

    async onOpen() {
        this.render();
    }

    async onClose() { }

    cleanTaskText(text: string): string {
        if (!text) return "";
        let clean = text;

        // 1. Remove Pomodoro Counter
        clean = clean.replace(/\[🍅::\s*(\d+)(?:\s*\/\s*(\d+))?\]/g, '');

        // 2. Remove Tags (#tag, #tag/subtag)
        clean = clean.replace(/#[\w\/-]+/g, '');

        // 3. Remove Dataview fields
        clean = clean.replace(/\[[^\]]+::.*?\]/g, '');

        // 4. Aggressive Cut: Remove everything including and to the right of any Obsidian Tasks symbol
        // Symbols: 🔁 (recurrence), 🏁 (flag), 📅 (due), ⏳ (scheduled), 🛫 (start), ✅ (done), ➕ (created)
        // Priorities: 🔺, ⏫, 🔽
        const splitRegex = /[🔁🏁📅⏳🛫✅➕🔺⏫🔽]/;
        const index = clean.search(splitRegex);
        if (index !== -1) {
            clean = clean.substring(0, index);
        }

        // 5. Cleanup extra spaces
        return clean.replace(/\s+/g, ' ').trim();
    }

    render() {
        if (!this.containerEl) return;
        const container = this.containerEl.children[1];
        if (!container) return;

        const { state } = this.plugin.timerService;
        const hasTimerView = container.querySelector('.pomodoro-timer-view');

        // Check if we can just update the existing timer view
        if (state.state !== 'IDLE' && hasTimerView) {
            this.updateTimer(container);
        } else {
            container.empty();
            container.addClass('pomodoro-view-container');

            if (state.state !== 'IDLE') {
                this.renderTimer(container);
            } else {
                this.renderTaskList(container);
                this.renderStats(container);
            }
        }
    }

    updateTimer(container: Element) {
        const { state } = this.plugin.timerService;

        // Update Label and Styles based on state
        const label = container.querySelector('.pomodoro-active-task-label') as HTMLElement;
        if (label) {
            if (state.pausedTime) {
                label.innerText = '⏸️ PAUSED';
                label.style.opacity = '1.0';
                label.style.color = 'var(--text-warning)';
            } else {
                label.innerText = state.state === 'WORK' ? '⚠️ FOCUSING ON' : '☕ TAKING A BREAK';
                label.style.opacity = '';
                label.style.color = '';
            }
        }

        // Update Toggle Icon
        const toggle = container.querySelector('.pomodoro-subtask-toggle');
        if (toggle && state.state === 'WORK') {
            toggle.textContent = this.showSubtasks ? '▼' : '▶';
        }

        // Update Controls
        const controls = container.querySelector('.pomodoro-controls');
        if (controls) {
            controls.empty();
            // Pause/Resume Button
            if (state.pausedTime) {
                const resumeBtn = controls.createEl('button', { cls: 'pomodoro-btn pomodoro-btn-resume', text: '▶ Resume' });
                resumeBtn.onclick = () => this.plugin.timerService.resumeSession();
            } else {
                const pauseBtn = controls.createEl('button', { cls: 'pomodoro-btn pomodoro-btn-pause', text: '⏸ Pause' });
                pauseBtn.onclick = () => this.plugin.timerService.pauseSession();
            }

            const stopBtn = controls.createEl('button', { cls: 'pomodoro-btn pomodoro-btn-stop', text: 'Stop / Cancel' });
            stopBtn.onclick = () => this.plugin.timerService.stopSession();
        }

        // Update Subtasks Logic
        const view = container.querySelector('.pomodoro-timer-view');
        const existingList = container.querySelector('.pomodoro-subtask-list');
        const existingMsg = container.querySelector('.pomodoro-no-subtasks');

        if (state.state === 'WORK' && this.showSubtasks) {
            // If list is missing, render it.
            // If list exists, we call renderSubtasks which will now be smart enough to replace it (see next edit) 
            // OR we can just assume for Pause/Resume validation that we don't need to refresh.
            // However, to be fully correct, let's allow refresh but in a non-flickering way.
            this.renderSubtasks(view);
        } else {
            // Remove if they exist and shouldn't
            if (existingList) existingList.remove();
            if (existingMsg) existingMsg.remove();
        }
    }

    renderTimer(container: Element) {
        const { state } = this.plugin.timerService;
        const view = container.createDiv({ cls: 'pomodoro-timer-view' });

        // Active Task Card
        const taskCard = view.createDiv({ cls: 'pomodoro-active-task-card' });

        // Header (Clickable for subtasks)
        const header = taskCard.createDiv({ cls: 'pomodoro-active-task-header' });
        header.style.cursor = 'pointer';
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';

        const label = header.createDiv({ cls: 'pomodoro-active-task-label' });

        if (state.pausedTime) {
            label.innerText = '⏸️ PAUSED';
            label.style.opacity = '1.0';
            label.style.color = 'var(--text-warning)';
        } else {
            label.innerText = state.state === 'WORK' ? '⚠️ FOCUSING ON' : '☕ TAKING A BREAK';
        }

        // Right side container for Settings + Toggle
        const headerControls = header.createDiv({ attr: { style: 'display: flex; align-items: center;' } });

        // Settings Button
        const settingsBtn = headerControls.createEl('button');
        setIcon(settingsBtn, 'settings');
        settingsBtn.addClass('clickable-icon');
        settingsBtn.ariaLabel = 'Settings';
        settingsBtn.style.background = 'transparent';
        settingsBtn.style.border = 'none';
        settingsBtn.style.boxShadow = 'none';
        settingsBtn.style.color = 'var(--text-on-accent)';
        settingsBtn.style.opacity = '0.7';
        settingsBtn.style.cursor = 'pointer';
        settingsBtn.style.padding = '0';
        settingsBtn.style.display = 'flex'; // Fix vertical alignment
        settingsBtn.style.transform = 'scale(0.85)';
        settingsBtn.style.marginRight = '12px'; // Explicit margin to separate from toggle

        settingsBtn.onclick = (e) => {
            e.stopPropagation();
            // @ts-ignore
            this.plugin.app.setting.open();
            // @ts-ignore
            this.plugin.app.setting.openTabById(this.plugin.manifest.id);
        };

        // Toggle indicator
        if (state.state === 'WORK') {
            const toggleIcon = headerControls.createDiv({ text: this.showSubtasks ? '▼' : '▶', cls: 'pomodoro-subtask-toggle' });
            toggleIcon.style.fontSize = '0.8em';
            toggleIcon.style.opacity = '0.7';
        }

        header.onclick = () => {
            if (state.state === 'WORK') {
                this.showSubtasks = !this.showSubtasks;
                this.render();
            }
        };

        // Text Container
        const textContainer = taskCard.createDiv({ cls: 'pomodoro-active-task-text-container' });
        textContainer.style.display = 'flex';
        textContainer.style.justifyContent = 'space-between';
        textContainer.style.alignItems = 'center';

        // Clean and Truncate task text
        const cleanedText = this.cleanTaskText(state.taskText);
        const displayText = cleanedText.length > 60 ? cleanedText.substring(0, 60) + '...' : cleanedText;

        textContainer.createDiv({ text: displayText, cls: 'pomodoro-active-task-text' });

        // Link Icon
        const linkBtn = textContainer.createEl('button', { cls: 'pomodoro-link-btn', text: '🔗' });
        linkBtn.classList.add('clickable-icon');
        linkBtn.style.background = 'none';
        linkBtn.style.border = 'none';
        linkBtn.style.padding = '0 5px';
        linkBtn.style.cursor = 'pointer';
        linkBtn.title = "Go to task";
        linkBtn.onclick = (e) => {
            e.stopPropagation();
            this.jumpToTask(state.taskFile, state.taskLine);
        };

        // Timer Display
        const timeLeft = this.plugin.timerService.getTimeLeft();
        const minutes = Math.floor(timeLeft / 60);
        const seconds = Math.floor(timeLeft % 60);
        const timeStr = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

        view.createDiv({ cls: 'pomodoro-timer-display', text: timeStr });

        // Cycle Info container - create synchronously, populate async
        const cycleInfoContainer = view.createDiv({ cls: 'pomodoro-cycle-info' });
        this.populateCycleInfo(cycleInfoContainer);

        // Controls
        const controls = view.createDiv({ cls: 'pomodoro-controls' });

        // Pause/Resume Button
        if (state.pausedTime) {
            const resumeBtn = controls.createEl('button', { cls: 'pomodoro-btn pomodoro-btn-resume', text: '▶ Resume' });
            resumeBtn.onclick = () => this.plugin.timerService.resumeSession();
        } else {
            const pauseBtn = controls.createEl('button', { cls: 'pomodoro-btn pomodoro-btn-pause', text: '⏸ Pause' });
            pauseBtn.onclick = () => this.plugin.timerService.pauseSession();
        }

        const stopBtn = controls.createEl('button', { cls: 'pomodoro-btn pomodoro-btn-stop', text: 'Stop / Cancel' });
        stopBtn.onclick = () => this.plugin.timerService.stopSession();

        // Subtasks Section
        if (state.state === 'WORK' && this.showSubtasks) {
            this.renderSubtasks(view);
        }
    }

    async populateCycleInfo(cycleDiv: Element) {
        const { state } = this.plugin.timerService;
        // Minimalist first cycle state
        const firstCycleHtml = `<span>🍅</span><span class="pomodoro-cycle-value">--</span>`;

        if (!state.taskFile) {
            cycleDiv.innerHTML = firstCycleHtml;
            return;
        }

        const file = this.plugin.app.vault.getAbstractFileByPath(state.taskFile);
        if (!(file instanceof TFile)) {
            cycleDiv.innerHTML = firstCycleHtml;
            return;
        }

        const content = await this.plugin.app.vault.read(file);
        const lines = content.split('\n');
        const lineIdx = state.taskLine;

        if (lineIdx >= lines.length) {
            cycleDiv.innerHTML = firstCycleHtml;
            return;
        }

        const line = lines[lineIdx];
        const tomatoRegex = /\[🍅::\s*(\d+)(?:\s*\/\s*(\d+))?\]/;
        const match = line.match(tomatoRegex);

        if (match) {
            const currentCount = parseInt(match[1]);
            const goalStr = match[2];

            if (goalStr) {
                const goal = parseInt(goalStr);
                // 🍅 1/4
                cycleDiv.innerHTML = `<span>🍅</span><span class="pomodoro-cycle-value">${currentCount}/${goal}</span>`;
            } else {
                // 🍅 1
                cycleDiv.innerHTML = `<span>🍅</span><span class="pomodoro-cycle-value">${currentCount}</span>`;
            }
        } else {
            // No counter yet
            cycleDiv.innerHTML = firstCycleHtml;
        }
    }

    async renderTaskList(container: Element) {
        const header = container.createDiv({ cls: 'pomodoro-header' });
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';

        header.createEl('h4', { text: '🎯 Active Tasks' });

        const controls = header.createDiv({ attr: { style: 'display: flex; gap: 6px; align-items: center;' } });

        const settingsBtn = controls.createEl('button');
        settingsBtn.addClass('clickable-icon');
        settingsBtn.ariaLabel = 'Settings';
        settingsBtn.style.display = 'flex';
        settingsBtn.style.alignItems = 'center';
        setIcon(settingsBtn, 'settings');
        settingsBtn.onclick = () => {
            // @ts-ignore
            this.plugin.app.setting.open();
            // @ts-ignore
            this.plugin.app.setting.openTabById(this.plugin.manifest.id);
        };

        const refreshBtn = controls.createEl('button');
        refreshBtn.addClass('clickable-icon');
        refreshBtn.ariaLabel = 'Refresh List';
        refreshBtn.style.display = 'flex';
        refreshBtn.style.alignItems = 'center';
        setIcon(refreshBtn, 'refresh-cw');
        refreshBtn.onclick = () => this.render();

        // Get active file
        let file = this.plugin.app.workspace.getActiveFile();
        if (!file) {
            // Try to find a markdown view
            const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
            if (view) file = view.file;
        }

        if (!file) {
            container.createEl('p', {
                text: 'Open a markdown file to see tasks.',
                attr: { style: 'color: var(--text-muted); font-style: italic; margin-top: 20px;' }
            });
            return;
        }

        const content = await this.plugin.app.vault.read(file);
        const lines = content.split('\n');
        const tasks: { line: number, text: string }[] = [];
        const tag = this.plugin.settings.tag.trim();

        // Use regex for checking incomplete tasks (- [ ] or * [ ])
        const taskRegex = /^\s*[-*] \[ \]/;

        lines.forEach((line, index) => {
            if (taskRegex.test(line) && line.includes(tag)) {
                tasks.push({
                    line: index,
                    text: line.replace(taskRegex, '').replace(tag, '').trim()
                });
            }
        });

        if (tasks.length === 0) {
            container.createEl('p', {
                text: `No tasks found with tag ${tag}`,
                attr: { style: 'color: var(--text-muted); font-style: italic; margin-top: 20px;' }
            });
            return;
        }

        const list = container.createDiv({ cls: 'pomodoro-task-list' });
        tasks.forEach(task => {
            const item = list.createDiv({ cls: 'pomodoro-task-item' });

            const icon = item.createDiv({ cls: 'pomodoro-task-icon' });
            setIcon(icon, 'circle'); // Obsidian icon

            const text = item.createDiv({ cls: 'pomodoro-task-text', text: task.text });

            item.addEventListener('click', () => {
                this.plugin.timerService.startSession({ file, line: task.line, text: task.text }, 'WORK');
            });
        });
    }

    async renderSubtasks(container: Element) {
        const { state } = this.plugin.timerService;
        if (!state.taskFile) return;

        const file = this.plugin.app.vault.getAbstractFileByPath(state.taskFile);
        if (!(file instanceof TFile)) return;

        const content = await this.plugin.app.vault.read(file);
        const lines = content.split('\n');
        const tag = this.plugin.settings.tag.trim();
        const limit = this.plugin.settings.subtaskCount;
        const useLimit = this.plugin.settings.enableSubtaskLimit;
        const showCompleted = this.plugin.settings.showCompletedSubtasks;
        const showTodayBypass = this.plugin.settings.showCompletedToday;

        const todayStr = moment().format('YYYY-MM-DD');

        // 1. Locate the main task line freshly to handle file edits
        let currentTaskLine = state.taskLine;
        const cleanTaskText = state.taskText.substring(0, 15);

        // Use a clean check (fuzzy)
        if (currentTaskLine >= lines.length || !lines[currentTaskLine].includes(cleanTaskText)) {
            // It moved or line changed significantly. Scan for it.
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(cleanTaskText) && lines[i].includes(tag)) {
                    currentTaskLine = i;
                    break;
                }
            }
        }

        interface SubtaskItem {
            line: number;
            text: string;
            completed: boolean;
            isSession: boolean;
            isToday: boolean;
        }

        const uncheckedCandidates: SubtaskItem[] = [];
        const checkedCandidates: SubtaskItem[] = [];

        const taskRegex = /^\s*[-*] \[ \]/;
        const completedRegex = /^\s*[-*] \[x\]/i;

        // 2. Scan lines BELOW the main task
        for (let i = currentTaskLine + 1; i < lines.length; i++) {
            const line = lines[i];

            // Stop conditions
            const isTaskLine = taskRegex.test(line);
            const isCompletedLine = completedRegex.test(line);

            if ((isTaskLine || isCompletedLine) && line.includes(tag)) {
                break;
            }

            if (isTaskLine) {
                uncheckedCandidates.push({
                    line: i,
                    text: line.replace(taskRegex, '').trim(),
                    completed: false,
                    isSession: false,
                    isToday: false
                });
            } else if (isCompletedLine) {
                const text = line.replace(completedRegex, '').trim();
                const isSession = state.completedSubtasks.some(stored => text.includes(stored));
                // We consider it "today" if it's in the current session OR matches today's date string
                const isToday = isSession || line.includes(todayStr);

                checkedCandidates.push({
                    line: i,
                    text: text,
                    completed: true,
                    isSession: isSession,
                    isToday: isToday
                });
            }
        }

        // 3. Select tasks to display
        const finalTasks: SubtaskItem[] = [];
        let slots = useLimit ? limit : 9999;

        // Priority 1: Unchecked Tasks
        for (const task of uncheckedCandidates) {
            if (slots > 0) {
                finalTasks.push(task);
                slots--;
            }
        }

        // Priority 2: Completed Tasks (After subtasks)
        for (const task of checkedCandidates) {
            // We show if 'Show Completed' setting is On OR if it was completed in this session
            const shouldShow = showCompleted || task.isSession;

            if (shouldShow) {
                // Bypass limit if 'Show Today' is On and it is today, OR if it's a session task (always show user actions)
                const bypassLimit = (showTodayBypass && task.isToday) || task.isSession;

                if (bypassLimit) {
                    finalTasks.push(task);
                } else if (slots > 0) {
                    finalTasks.push(task);
                    slots--;
                }
            }
        }

        // Find existing elements to replace (to avoid flickering)
        const oldList = container.querySelector('.pomodoro-subtask-list');
        const oldMsg = container.querySelector('.pomodoro-no-subtasks');

        if (finalTasks.length === 0) {
            const msgDiv = container.createDiv({
                text: "No pending subtasks found below.",
                cls: 'pomodoro-no-subtasks',
                attr: { style: 'text-align: center; color: var(--text-muted); font-size: 0.9em; margin-top: 10px;' }
            });

            if (oldList) oldList.remove();
            if (oldMsg) oldMsg.remove(); 
            return;
        }

        const listDiv = container.createDiv({ cls: 'pomodoro-subtask-list' });

        finalTasks.forEach(task => {
            const row = listDiv.createDiv({ cls: 'pomodoro-subtask-row' });
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.marginBottom = '5px';
            row.style.fontSize = '0.9em';

            const checkbox = row.createEl('input', { type: 'checkbox' });
            checkbox.checked = task.completed;

            checkbox.onchange = async () => {
                await this.toggleSubtask(file, task.line, task.text, checkbox.checked);
            };

            const textSpan = row.createSpan({ text: task.text });
            textSpan.style.marginLeft = '8px';
            textSpan.style.flex = '1';
            if (task.completed) {
                textSpan.style.textDecoration = 'line-through';
                textSpan.style.opacity = '0.6';
            }

            const linkIcon = row.createSpan({ text: '🔗', cls: 'pomodoro-subtask-link' });
            linkIcon.style.cursor = 'pointer';
            linkIcon.style.opacity = '0.5';
            linkIcon.style.fontSize = '0.8em';
            linkIcon.title = "Jump to subtask";
            linkIcon.onclick = () => this.jumpToTask(state.taskFile, task.line);
        });

        // Cleanup old elements after new one is inserted
        if (oldList) oldList.remove();
        if (oldMsg) oldMsg.remove();
    }

    async toggleSubtask(file: TFile, lineIdx: number, text: string, checked: boolean) {
        const content = await this.plugin.app.vault.read(file);
        const lines = content.split('\n');
        if (lines.length <= lineIdx) return;

        let line = lines[lineIdx];
        if (checked) {
            line = line.replace('[ ]', '[x]');
            this.plugin.timerService.state.completedSubtasks.push(text);
        } else {
            line = line.replace('[x]', '[ ]').replace('[X]', '[ ]');
            this.plugin.timerService.state.completedSubtasks = this.plugin.timerService.state.completedSubtasks.filter(t => t !== text);
        }

        lines[lineIdx] = line;
        await this.plugin.app.vault.modify(file, lines.join('\n'));
        await this.plugin.timerService.saveState();
        this.render();
    }

    async jumpToTask(filePath: string, line: number) {
        const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
            const leaf = this.plugin.app.workspace.getLeaf(false);
            await leaf.openFile(file);
            const view = leaf.view as MarkdownView;
            if (view && view.editor) {
                view.editor.setCursor({ line: line, ch: 0 });
                view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
                view.editor.focus();
            }
        }
    }

    renderStats(container: Element) {
        const stats = this.plugin.stats;
        const statsDiv = container.createDiv({ cls: 'pomodoro-stats' });

        const stat1 = statsDiv.createDiv({ cls: 'pomodoro-stat-item' });
        stat1.createSpan({ text: 'Cycles', attr: { style: 'font-size: 0.8em; opacity: 0.7;' } });
        stat1.createSpan({ cls: 'pomodoro-stat-value', text: String(stats.completedSessions) });

        const stat2 = statsDiv.createDiv({ cls: 'pomodoro-stat-item' });
        stat2.createSpan({ text: 'Focus Time', attr: { style: 'font-size: 0.8em; opacity: 0.7;' } });
        stat2.createSpan({ cls: 'pomodoro-stat-value', text: `${stats.totalWorkDuration} m` });
    }
}

// --- PLUGIN ---

export default class PomodoroTaskPlugin extends Plugin {
    settings: PomodoroTaskSettings;
    stats: PomodoroStats;
    timerService: TimerService;
    view: PomodoroView | null = null;

    async onload() {
        await this.loadSettings();

        // Ensure stats are loaded
        if (!this.stats) this.stats = { ...DEFAULT_STATS };

        this.timerService = new TimerService(this);
        await this.timerService.loadState();

        this.registerView(
            POMODORO_VIEW_TYPE,
            (leaf) => {
                this.view = new PomodoroView(leaf, this);
                return this.view;
            }
        );

        this.addRibbonIcon('alarm-clock', 'Pomodoro Task', (evt: MouseEvent) => {
            this.activateView();
        });

        this.addCommand({
            id: 'open-pomodoro-view',
            name: 'Open View',
            callback: () => {
                this.activateView();
            }
        });

        this.addSettingTab(new PomodoroSettingTab(this.app, this));

        // Event Listeners
        this.registerEvent(this.app.workspace.on('file-open', () => this.refreshView()));
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshView()));
        this.registerEvent(this.app.vault.on('modify', (file) => {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile && file.path === activeFile.path) {
                this.refreshView();
            }
        }));
    }

    refreshView() {
        const leaves = this.app.workspace.getLeavesOfType(POMODORO_VIEW_TYPE);
        leaves.forEach(leaf => {
            if (leaf.view instanceof PomodoroView) {
                leaf.view.render();
            }
        });
    }

    updateTimerUI() {
        const leaves = this.app.workspace.getLeavesOfType(POMODORO_VIEW_TYPE);
        leaves.forEach(leaf => {
            if (leaf.view instanceof PomodoroView && this.timerService.state.state !== 'IDLE') {
                const display = leaf.view.containerEl.querySelector('.pomodoro-timer-display');
                if (display) {
                    const timeLeft = this.timerService.getTimeLeft();
                    const minutes = Math.floor(timeLeft / 60);
                    const seconds = Math.floor(timeLeft % 60);
                    display.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                } else {
                    leaf.view.render();
                }
            }
        });
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(POMODORO_VIEW_TYPE);
        if (leaves.length > 0) {
            leaf = leaves[0];
            workspace.revealLeaf(leaf);
        } else {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                await rightLeaf.setViewState({ type: POMODORO_VIEW_TYPE, active: true });
                workspace.revealLeaf(rightLeaf);
            }
        }
    }

    onunload() {
        this.timerService.clearInterval();
    }

    async loadSettings() {
        const loadedData = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
        this.stats = Object.assign({}, DEFAULT_STATS, loadedData ? loadedData.stats : null);
    }

    async saveAllData() {
        const data = {
            ...this.settings,
            stats: this.stats,
            timerState: this.timerService.state
        };
        await this.saveData(data);
    }
}

class PomodoroSettingTab extends PluginSettingTab {
    plugin: PomodoroTaskPlugin;

    constructor(app: App, plugin: PomodoroTaskPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Pomodoro Settings' });

        new Setting(containerEl)
            .setName('Target Tag')
            .setDesc('Tasks with this tag will appear in the Pomodoro panel')
            .addText(text => text
                .setPlaceholder('#pomodoro')
                .setValue(this.plugin.settings.tag)
                .onChange(async (value) => {
                    this.plugin.settings.tag = value;
                    await this.plugin.saveAllData();
                }));

        containerEl.createEl('h3', { text: 'Durations (minutes)' });

        new Setting(containerEl)
            .setName('Work Duration')
            .setDesc('How long is a focus session?')
            .addText(text => text
                .setPlaceholder('25')
                .setValue(String(this.plugin.settings.workDuration))
                .onChange(async (value) => {
                    this.plugin.settings.workDuration = Number(value);
                    await this.plugin.saveAllData();
                }));

        new Setting(containerEl)
            .setName('Short Break')
            .setDesc('Duration of a short break')
            .addText(text => text
                .setPlaceholder('5')
                .setValue(String(this.plugin.settings.shortBreakDuration))
                .onChange(async (value) => {
                    this.plugin.settings.shortBreakDuration = Number(value);
                    await this.plugin.saveAllData();
                }));

        new Setting(containerEl)
            .setName('Long Break')
            .setDesc('Duration of a long break')
            .addText(text => text
                .setPlaceholder('15')
                .setValue(String(this.plugin.settings.longBreakDuration))
                .onChange(async (value) => {
                    this.plugin.settings.longBreakDuration = Number(value);
                    await this.plugin.saveAllData();
                }));

        new Setting(containerEl)
            .setName('Default Subtasks Expanded')
            .setDesc('Should subtasks be visible by default when starting a task?')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.defaultSubtasksExpanded)
                .onChange(async (value) => {
                    this.plugin.settings.defaultSubtasksExpanded = value;
                    await this.plugin.saveAllData();
                }));

        const limitSetting = new Setting(containerEl)
            .setName('Limit Subtasks Shown')
            .setDesc('Toggle to limit the number of subtasks displayed in the view')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableSubtaskLimit)
                .onChange(async (value) => {
                    this.plugin.settings.enableSubtaskLimit = value;
                    await this.plugin.saveAllData();
                    // Update visibility of the count setting
                    countSetting.settingEl.style.display = value ? 'flex' : 'none';
                    todaySetting.settingEl.style.display = value ? 'flex' : 'none';
                }));

        const countSetting = new Setting(containerEl)
            .setName('Max Subtasks')
            .setDesc('Maximum number of subtasks to show')
            .addText(text => text
                .setPlaceholder('3')
                .setValue(String(this.plugin.settings.subtaskCount))
                .onChange(async (value) => {
                    this.plugin.settings.subtaskCount = Number(value);
                    await this.plugin.saveAllData();
                }));

        new Setting(containerEl)
            .setName('Show Completed Subtasks')
            .setDesc('If enabled, completed subtasks will be displayed after pending ones')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showCompletedSubtasks)
                .onChange(async (value) => {
                    this.plugin.settings.showCompletedSubtasks = value;
                    await this.plugin.saveAllData();
                }));

        const todaySetting = new Setting(containerEl)
            .setName('Always Show Completed Today')
            .setDesc('If enabled, tasks completed today will be shown even if the limit is exceeded')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showCompletedToday)
                .onChange(async (value) => {
                    this.plugin.settings.showCompletedToday = value;
                    await this.plugin.saveAllData();
                }));

        // Initial visibility
        countSetting.settingEl.style.display = this.plugin.settings.enableSubtaskLimit ? 'flex' : 'none';
        todaySetting.settingEl.style.display = this.plugin.settings.enableSubtaskLimit ? 'flex' : 'none';
    }
}
