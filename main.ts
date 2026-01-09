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
    overrides?: {
        workDuration?: number;
        shortBreakDuration?: number;
    }
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

    startSession(task: { file: TFile, line: number, text: string }, type: 'WORK' | 'BREAK', overrides?: { workDuration?: number, shortBreakDuration?: number }) {
        let duration = 0;

        if (type === 'WORK') {
            duration = overrides?.workDuration ?? this.plugin.settings.workDuration;
        } else {
            duration = overrides?.shortBreakDuration ?? this.plugin.settings.shortBreakDuration;
        }

        this.state = {
            state: type,
            startTime: Date.now(),
            duration: duration,
            taskId: task.file.path + ':' + task.line,
            taskLine: task.line,
            taskFile: task.file.path,
            taskText: task.text,
            completedSubtasks: [],
            overrides: overrides
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

    applyOverrides(work: number, shortBreak: number) {
        // Save overrides
        this.state.overrides = {
            workDuration: work,
            shortBreakDuration: shortBreak
        };

        // If currently running, update the current Duration accordingly
        // We only update if the duration logic matches the current state
        if (this.state.state === 'WORK') {
            this.state.duration = work;
        } else if (this.state.state === 'BREAK') {
            this.state.duration = shortBreak;
        }

        // Save and refresh
        this.saveState();
        this.plugin.refreshView();
        this.plugin.updateTimerUI();
    }


    resetSession() {
        if (this.state.state !== 'IDLE') {
            this.state.startTime = Date.now();
            this.state.pausedTime = null;
            this.saveState();
            this.startTick();
            this.plugin.refreshView();
            this.plugin.updateTimerUI(); // Force immediate update of digits
        }
    }

    switchMode() {
        if (this.state.state !== 'IDLE') {
            const nextType = this.state.state === 'WORK' ? 'BREAK' : 'WORK';
            const file = this.plugin.app.vault.getAbstractFileByPath(this.state.taskFile);

            if (file instanceof TFile) {
                // Pass existing overrides to the next session
                this.startSession({
                    file: file,
                    line: this.state.taskLine,
                    text: this.state.taskText
                }, nextType, this.state.overrides);
            } else {
                // If file is missing (deleted?), we can't easily restart with context.
                // Just stop.
                this.stopSession();
            }
        }
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

class CycleConfigModal extends Modal {
    plugin: PomodoroTaskPlugin;
    workDuration: number;
    shortBreakDuration: number;

    constructor(app: App, plugin: PomodoroTaskPlugin) {
        super(app);
        this.plugin = plugin;
        // Load current overrides or defaults
        const overrides = this.plugin.timerService.state.overrides;
        this.workDuration = overrides?.workDuration ?? this.plugin.settings.workDuration;
        this.shortBreakDuration = overrides?.shortBreakDuration ?? this.plugin.settings.shortBreakDuration;
    }

    onOpen() {
        // Custom UI implementation for better UX
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h3', { text: 'Cycle Configuration', attr: { style: 'text-align: center; margin-bottom: 20px;' } });

        const container = contentEl.createDiv({ cls: 'pomodoro-config-modal-container' });

        // Work Section
        this.createConfigSection(container, 'Focus Duration', this.workDuration, [5, 10, 15, 20, 25, 30, 45, 50, 60], (val) => {
            this.workDuration = val;
        });

        // Break Section
        this.createConfigSection(container, 'Short Break', this.shortBreakDuration, [3, 5, 10, 15, 20], (val) => {
            this.shortBreakDuration = val;
        });

        // Footer
        const footer = contentEl.createDiv({ attr: { style: 'margin-top: 20px; display: flex; justify-content: center;' } });
        const applyBtn = footer.createEl('button', { text: 'Apply Changes', cls: 'mod-cta pomodoro-apply-btn' });
        applyBtn.onclick = () => {
            this.plugin.timerService.applyOverrides(this.workDuration, this.shortBreakDuration);
            this.close();
        };
    }

    createConfigSection(container: HTMLElement, label: string, initialValue: number, presets: number[], onChange: (val: number) => void) {
        const section = container.createDiv({ cls: 'pomodoro-config-section' });

        // Header with Label
        section.createDiv({ cls: 'pomodoro-config-label', text: label });

        // Input Row
        const inputRow = section.createDiv({ cls: 'pomodoro-input-row' });

        // The actual input
        const input = inputRow.createEl('input', { type: 'number', cls: 'pomodoro-time-input' });
        input.value = String(initialValue);

        inputRow.createSpan({ text: 'minutes', cls: 'pomodoro-unit' });

        input.onchange = () => {
            const val = Number(input.value);
            if (!isNaN(val) && val > 0) {
                onChange(val);
                // clear active chips
                section.querySelectorAll('.pomodoro-preset-chip').forEach(el => el.removeClass('is-active'));
            }
        };

        // Presets
        const presetsRow = section.createDiv({ cls: 'pomodoro-presets-row' });
        presets.forEach(val => {
            const chip = presetsRow.createEl('span', { text: String(val), cls: 'pomodoro-preset-chip' });
            if (val === initialValue) chip.addClass('is-active');

            chip.onclick = () => {
                // Update Logic
                onChange(val);
                input.value = String(val);

                // Visual Selection
                section.querySelectorAll('.pomodoro-preset-chip').forEach(el => el.removeClass('is-active'));
                chip.addClass('is-active');
            };
        });
    }

    addDurationChips(container: HTMLElement, presets: number[], onClick: (val: number) => void) {
        // We want the chips to be under the input.
        // The container provided by Setting is usually a flex row.
        // We can append a div to it, but it might mess up layout unless we structure it.
        // Actually, Setting.controlEl contains the input. If we append there, it might be side-by-side or weird.
        // Let's force a flex column or just append a div that breaks.
        // However, standard Obs settings are row-based.
        // A cleaner way is to inject the chips container *after* the input, or wrap the input and chips in a col.

        // Simplest: just append to controlEl and assume flex-wrap or block.
        // Let's set the container (controlEl) to allow wrapping if needed, but it's usually flex-end.

        // Let's try appending a specific container for chips.
        const chipContainer = container.createDiv({ cls: 'pomodoro-duration-chips' });
        // Force it to break into new line? 'justify-content: flex-end' in CSS handles alignment.
        // But to put it *under*, we might need the parent to wrap.
        container.style.flexWrap = 'wrap';

        presets.forEach(val => {
            const chip = chipContainer.createEl('button', { text: String(val), cls: 'pomodoro-chip' });
            chip.onclick = () => onClick(val);
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// --- VIEW ---

export const POMODORO_VIEW_TYPE = "pomodoro-view";

export class PomodoroView extends ItemView {
    plugin: PomodoroTaskPlugin;
    showSubtasks: boolean;
    floatingStats: HTMLElement | null = null;
    currentZoom: number = 1.0;
    private renderCounter: number = 0;
    
    constructor(leaf: WorkspaceLeaf, plugin: PomodoroTaskPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.showSubtasks = this.plugin.settings.defaultSubtasksExpanded;
    }

    getViewType() { return POMODORO_VIEW_TYPE; }
    getDisplayText() { return "Pomodoro Task"; }

    async onOpen() {
        this.contentEl.addEventListener('wheel', (evt: WheelEvent) => {
            if (evt.ctrlKey) {
                evt.preventDefault();
                const delta = evt.deltaY > 0 ? -0.1 : 0.1;
                this.currentZoom = Math.min(Math.max(0.5, this.currentZoom + delta), 2.5);
                // @ts-ignore
                this.contentEl.style.zoom = this.currentZoom;
            }
        }, { passive: false });

        if (this.floatingStats) {
            this.floatingStats.remove();
            this.floatingStats = null;
        }
    }

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
        this.renderCounter++;
        const currentRenderId = this.renderCounter;

        if (!this.containerEl) return;
        const container = this.containerEl.children[1];
        if (!container) return;

        const { state } = this.plugin.timerService;
        const hasTimerView = container.querySelector('.pomodoro-timer-view');

        // Check if we can just update the existing timer view
        if (state.state !== 'IDLE' && hasTimerView) {
            this.updateTimer(container);
        } else {
            // Clean up global float if entering IDLE or non-timer state
            if (state.state === 'IDLE' && this.floatingStats) {
                this.floatingStats.remove();
                this.floatingStats = null;
            }

            container.empty();
            container.addClass('pomodoro-view-container');

            if (state.state !== 'IDLE') {
                this.renderTimer(container);
            } else {
                this.renderStats(container);
                this.renderTaskList(container, currentRenderId);
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
        settingsBtn.style.marginRight = '6px'; // Explicit margin to separate from toggle

        settingsBtn.onclick = (e) => {
            e.stopPropagation();
            // @ts-ignore
            this.plugin.app.setting.open();
            // @ts-ignore
            this.plugin.app.setting.openTabById(this.plugin.manifest.id);
        };

        // Refresh Button
        const refreshBtn = headerControls.createEl('button');
        setIcon(refreshBtn, 'refresh-cw');
        refreshBtn.addClass('clickable-icon');
        refreshBtn.ariaLabel = 'Refresh';
        refreshBtn.style.background = 'transparent';
        refreshBtn.style.border = 'none';
        refreshBtn.style.boxShadow = 'none';
        refreshBtn.style.color = 'var(--text-on-accent)';
        refreshBtn.style.opacity = '0.7';
        refreshBtn.style.cursor = 'pointer';
        refreshBtn.style.padding = '0';
        refreshBtn.style.display = 'flex';
        refreshBtn.style.transform = 'scale(0.85)';
        refreshBtn.style.marginRight = '12px';

        refreshBtn.onclick = (e) => {
            e.stopPropagation();
            this.render();
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

        const stopBtn = controls.createEl('button', { cls: 'pomodoro-btn pomodoro-btn-stop', text: 'Stop' });
        stopBtn.onclick = () => this.plugin.timerService.stopSession();

        const extraControls = view.createDiv({ cls: 'pomodoro-controls-extra', attr: { style: 'margin-top: 10px; display: flex; gap: 10px;' } });

        const resetBtn = extraControls.createEl('button', { cls: 'pomodoro-btn', text: 'Reset' });
        resetBtn.style.fontSize = '0.8em';
        resetBtn.style.padding = '6px 12px';
        resetBtn.style.opacity = '0.8';
        resetBtn.onclick = () => this.plugin.timerService.resetSession();

        const switchBtn = extraControls.createEl('button', { cls: 'pomodoro-btn', text: 'Switch' });
        switchBtn.style.fontSize = '0.8em';
        switchBtn.style.padding = '6px 12px';
        switchBtn.style.opacity = '0.8';
        switchBtn.onclick = () => this.plugin.timerService.switchMode();

        const cycleBtn = extraControls.createEl('button', { cls: 'pomodoro-btn', text: 'Cycle' });
        cycleBtn.style.fontSize = '0.8em';
        cycleBtn.style.padding = '6px 12px';
        cycleBtn.style.opacity = '0.8';
        cycleBtn.onclick = () => new CycleConfigModal(this.plugin.app, this.plugin).open();



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

    async renderTaskList(container: Element, renderId: number) {
        // Guard against race conditions. If render has been called again, this.renderCounter will be > renderId
        if (renderId !== this.renderCounter) return;

        // Double check container still exists
        if (!container) return;

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
             // Check concurrency again before manipulating DOM
             if (renderId !== this.renderCounter) return;

             container.createEl('p', {
                text: 'Open a markdown file to see tasks.',
                attr: { style: 'color: var(--text-muted); font-style: italic; margin-top: 20px;' }
            });
            return;
        }

        const content = await this.plugin.app.vault.read(file);
        
        // Check concurrency again after await
        if (renderId !== this.renderCounter) return;

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
            // Check Concurrency
            if (renderId !== this.renderCounter) return;

            container.createEl('p', {
                text: `No tasks found with tag ${tag}`,
                attr: { style: 'color: var(--text-muted); font-style: italic; margin-top: 20px;' }
            });
            return;
        }
        
        // Check Concurrency
        if (renderId !== this.renderCounter) return;

        const list = container.createDiv({ cls: 'pomodoro-task-list' });
        tasks.forEach(task => {
            const item = list.createDiv({ cls: 'pomodoro-task-item' });

            // Extract Pomodoro Info
            const tomatoRegex = /\[🍅::\s*(\d+)(?:\s*\/\s*(\d+))?\]/;
            const match = task.text.match(tomatoRegex);
            let tomatoCount = '';
            if (match) {
                const current = match[1];
                const goal = match[2];
                tomatoCount = goal ? `🍅 ${current}/${goal}` : `🍅 ${current}`;
            }

            // Clean Text
            const cleanText = this.cleanTaskText(task.text);

            // Left Side (Icon + Potentially Tomato Count)
            const leftSide = item.createDiv({ cls: 'pomodoro-task-left' });

            // Just use the Pomodoro count/icon if it exists, otherwise maybe a dot?
            // User: "🍅 2/4 a esquerda da pomodoro task... pode ser 🍅:: 1 ou até mesmo não ter nenhuma maça"
            // If match, show it. If not, show generic icon?
            if (tomatoCount) {
                const countSpan = leftSide.createSpan({ cls: 'pomodoro-task-count-pill', text: tomatoCount });
            } else {
                const icon = leftSide.createDiv({ cls: 'pomodoro-task-icon' });
                setIcon(icon, 'circle');
            }

            // Right Side (Text)
            const textContainer = item.createDiv({ cls: 'pomodoro-task-text-container' });

            // Clean Text (Default visible)
            const cleanSpan = textContainer.createDiv({ cls: 'pomodoro-task-text-clean', text: cleanText });

            // Full Text (Hover visible)
            // We strip the [🍅:: ..] tag from the full text to avoid duplication if we want smoothness,
            // or just render raw. User asked "task sem as coisas do obsidian... quando done...".
            // Implication: Hover = Full Raw Text (maybe minus the tag if we want to be fancy, but raw is safer for context).
            const fullSpan = textContainer.createDiv({ cls: 'pomodoro-task-text-full', text: task.text });


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

        // Stats Logic (Floating)
        const totalPending = uncheckedCandidates.length;
        const totalSubtasks = uncheckedCandidates.length + checkedCandidates.length;

        // Create or Update Floating Stats
        if (!this.floatingStats) {
            this.floatingStats = createDiv({ cls: 'pomodoro-floating-stats' });
            document.body.appendChild(this.floatingStats);
        }

        // Update content: Icon + Text
        // Icon: Plug for check ? Or use the check circle?
        // User requested: (3,40) style. Actually (20 of 40 tasks).
        // Let's use: ⚡ (Pending / Total) or similar.
        // User image shows: CircleCheck Icon + Plug + PT: ON.
        // But user asked to "add a small text... (20 of 40)... centered to the dash but before it".
        // The previous request was for inline. Now user wants it floating.
        // Let's keep it simple: "Tasks: 20 / 40" or just "20 / 40".
        // Let's use a small icon + numbers.
        this.floatingStats.empty();

        // Icon
        const iconSpan = this.floatingStats.createSpan({ cls: 'pomodoro-floating-icon' });
        setIcon(iconSpan, 'check-circle-2'); // Small check icon

        // Text
        const textSpan = this.floatingStats.createSpan();
        textSpan.innerText = `${totalPending} / ${totalSubtasks}`;

        // Find existing elements to replace (to avoid flickering)
        const oldList = container.querySelector('.pomodoro-subtask-list');
        const oldMsg = container.querySelector('.pomodoro-no-subtasks');
        const oldStats = container.querySelector('.pomodoro-subtask-stats');

        if (oldStats) oldStats.remove(); // Remove the inline stats if they exist

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

    addDurationChips(container: HTMLElement, presets: number[], onClick: (val: number) => void) {
        // Create a dedicated div BELOW the setting row
        const chipContainer = container.createDiv({ cls: 'pomodoro-duration-chips' });

        presets.forEach(val => {
            const chip = chipContainer.createEl('span', { text: String(val), cls: 'pomodoro-chip' });
            chip.onclick = () => onClick(val);
        });
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

        const workSetting = new Setting(containerEl)
            .setName('Work Duration')
            .setDesc('How long is a focus session?')
            .addText(text => text
                .setPlaceholder('25')
                .setValue(String(this.plugin.settings.workDuration))
                .onChange(async (value) => {
                    this.plugin.settings.workDuration = Number(value);
                    await this.plugin.saveAllData();
                }));

        // Add chips to the main container, so they appear below the setting row
        this.addDurationChips(containerEl, [1, 5, 10, 15, 20, 25, 30, 45, 60], async (val) => {
            this.plugin.settings.workDuration = val;
            const input = workSetting.controlEl.querySelector('input');
            if (input) input.value = String(val);
            await this.plugin.saveAllData();
        });

        const shortBreakSetting = new Setting(containerEl)
            .setName('Short Break')
            .setDesc('Duration of a short break')
            .addText(text => text
                .setPlaceholder('5')
                .setValue(String(this.plugin.settings.shortBreakDuration))
                .onChange(async (value) => {
                    this.plugin.settings.shortBreakDuration = Number(value);
                    await this.plugin.saveAllData();
                }));

        this.addDurationChips(containerEl, [1, 2, 3, 5, 10, 15], async (val) => {
            this.plugin.settings.shortBreakDuration = val;
            const input = shortBreakSetting.controlEl.querySelector('input');
            if (input) input.value = String(val);
            await this.plugin.saveAllData();
        });

        const longBreakSetting = new Setting(containerEl)
            .setName('Long Break')
            .setDesc('Duration of a long break')
            .addText(text => text
                .setPlaceholder('15')
                .setValue(String(this.plugin.settings.longBreakDuration))
                .onChange(async (value) => {
                    this.plugin.settings.longBreakDuration = Number(value);
                    await this.plugin.saveAllData();
                }));

        this.addDurationChips(containerEl, [10, 15, 20, 25, 30, 45, 60], async (val) => {
            this.plugin.settings.longBreakDuration = val;
            const input = longBreakSetting.controlEl.querySelector('input');
            if (input) input.value = String(val);
            await this.plugin.saveAllData();
        });


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

        containerEl.createEl('h3', { text: 'Statistics' });

        new Setting(containerEl)
            .setName('Reset Statistics')
            .setDesc('Resets the total cycles and focus time counters.')
            .addButton(button => button
                .setButtonText('Reset Stats')
                .setWarning()
                .onClick(async () => {
                    this.plugin.stats = {
                        completedSessions: 0,
                        totalWorkDuration: 0
                    };
                    await this.plugin.saveAllData();
                    this.plugin.refreshView();
                    new Notice('Pomodoro statistics have been reset.');
                    // Force refresh setting tab to show 0 if I were displaying them here, but I'm not.
                }));
    }
}
