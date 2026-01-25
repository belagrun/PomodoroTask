# Recurring Tasks Example

This note demonstrates how **Pomodoro Task** works with recurring tasks. Tasks with recurrence emoji 🔁 will create a new instance after completion.

---

## Daily Recurring Tasks

- [ ] Morning review and planning #pomodoro 🍅:: 0/2 🔁 every day
  - [ ] Check calendar for today's meetings
  - [ ] Review yesterday's completed tasks
  - [ ] Set priorities for today
  - [ ] Update task deadlines if needed

- [ ] Email inbox zero #pomodoro 🍅:: 0/1 🔁 every weekday
  - [ ] Process all new emails
  - [ ] Archive or delegate where possible
  - [ ] Flag important items for follow-up

- [ ] Physical exercise session #pomodoro 🍅:: 0/3 🔁 every day
  - [ ] Warm-up exercises (5 min)
  - [ ] Main workout routine (20 min)
  - [ ] Cool down and stretching (5 min)

---

## Weekly Recurring Tasks

- [ ] Team meeting preparation #pomodoro 🍅:: 0/2 🔁 every Monday
  - [ ] Review last week's action items
  - [ ] Prepare status update for projects
  - [ ] Draft agenda for this week's meeting
  - [ ] Gather metrics and reports

- [ ] Code review sessions #pomodoro 🍅:: 0/4 🔁 every Friday
  - [ ] Review open pull requests
  - [ ] Test changes locally
  - [ ] Provide constructive feedback
  - [ ] Approve or request changes

---

## Monthly Recurring Tasks

- [ ] Monthly financial review #pomodoro 🍅:: 0/3 🔁 every month
  - [ ] Reconcile bank statements
  - [ ] Review expenses and budget
  - [ ] Update financial projections
  - [ ] Plan next month's budget

---

## How It Works

**Pomodoro Task** works seamlessly with the [Tasks plugin](https://github.com/obsidian-tasks-group/obsidian-tasks) for recurring tasks through smart Editor API integration.

When a recurring task completes all its pomodoro cycles (e.g., `🍅:: 2/2`):

1. 🍅 **Pomodoro Task** updates the tomato counter to the goal: `🍅:: 2/2`
2. 📝 Uses **Obsidian's Editor API** to toggle the checkbox from `[ ]` to `[x]`
3. 🔄 **Tasks plugin** intercepts this editor change and automatically:
   - Creates the next instance with correct dates
   - Resets the checkbox to `[ ]`
   - Preserves all metadata (recurrence, priority, tags, etc.)

**Why Editor API?**

Instead of directly writing text to the file, Pomodoro Task uses `editor.replaceRange()` which:

- ✅ Triggers proper Obsidian events
- ✅ Allows Tasks plugin to detect and process the change
- ✅ Maintains full compatibility with Tasks plugin recurrence engine
- ✅ Preserves undo/redo history

**Important:** Make sure your recurring task template includes a reset tomato counter:

```markdown
- [ ] Daily review #pomodoro 🍅:: 0/2 🔁 every day
```

The Tasks plugin handles all complex recurrence logic:

- `🔁 every day` - Creates next task for tomorrow
- `🔁 every day when done` - Creates next task based on completion date
- `🔁 every week on Monday` - Creates next task for next Monday
- `🔁 every month on the 1st` - Creates next task on 1st of next month
- And many more patterns!

This integration keeps your recurring workflows seamless without duplicating the Tasks plugin's powerful recurrence engine.
