import { Menu } from 'obsidian'
import type PMPlugin from '../main'
import { Project, Task } from '../types'
import { today, parsePlainDate, Temporal } from '../dates'
import { flattenTasks } from '../store/TaskTreeOps'
import { safeAsync, getPriorityConfig, isTaskOverdue, isTerminalStatus } from '../utils'
import { renderStatusBadge } from '../ui/StatusBadge'
import { openTaskModal } from '../ui/ModalFactory'
import { buildTaskContextMenu } from '../ui/TaskContextMenu'
import type { SubView } from './SubView'

type TimeBlock = 'morning' | 'afternoon' | 'evening' | 'flexible'

const TIME_BLOCKS: { id: TimeBlock; label: string; icon: string }[] = [
  { id: 'morning', label: 'Morning', icon: '🌅' },
  { id: 'afternoon', label: 'Afternoon', icon: '☀️' },
  { id: 'evening', label: 'Evening', icon: '🌙' },
  { id: 'flexible', label: 'Flexible', icon: '⏱' }
]

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DAY_NAMES_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function getWeekDays(referenceDate: Temporal.PlainDate): Temporal.PlainDate[] {
  // dayOfWeek: 1=Mon ... 7=Sun
  const dow = referenceDate.dayOfWeek
  const monday = referenceDate.subtract({ days: dow - 1 })
  return Array.from({ length: 7 }, (_, i) => monday.add({ days: i }))
}

function getTimeBlock(task: Task): TimeBlock {
  const raw = task.customFields?.time_block
  if (raw === 'morning' || raw === 'afternoon' || raw === 'evening') return raw
  return 'flexible'
}

function getScheduledTime(task: Task): string | null {
  const raw = task.customFields?.scheduled_time
  return typeof raw === 'string' && raw ? raw : null
}

function getEstimatedDuration(task: Task): string | null {
  const raw = task.customFields?.estimated_duration
  if (typeof raw === 'string' && raw) return raw
  if (typeof task.timeEstimate === 'number' && task.timeEstimate > 0) {
    return task.timeEstimate === 1 ? '1 hr' : `${task.timeEstimate} hrs`
  }
  return null
}

export class WeeklyKanbanView implements SubView {
  private dragTask: Task | null = null
  private dragSourceDue: string | null = null
  private dragSourceBlock: TimeBlock | null = null
  private cleanupFns: (() => void)[] = []
  private weekOffset = 0

  constructor(
    private container: HTMLElement,
    private project: Project,
    private plugin: PMPlugin,
    private onRefresh: () => Promise<void>
  ) {}

  destroy(): void {
    for (const fn of this.cleanupFns) fn()
    this.cleanupFns = []
  }

  render(): void {
    this.destroy()
    this.container.empty()
    this.container.addClass('pm-weekly-view')

    // Week navigation bar
    const nav = this.container.createDiv('pm-weekly-nav')
    this.renderNav(nav)

    // Board
    const board = this.container.createDiv('pm-weekly-board')
    this.renderBoard(board)
  }

  private renderNav(nav: HTMLElement): void {
    nav.empty()

    const prevBtn = nav.createEl('button', { cls: 'pm-weekly-nav-btn', text: '←' })
    prevBtn.setAttribute('aria-label', 'Previous week')
    prevBtn.addEventListener('click', () => {
      this.weekOffset -= 1
      this.render()
    })

    const todayBtn = nav.createEl('button', { cls: 'pm-weekly-nav-btn pm-weekly-nav-today', text: 'Today' })
    todayBtn.addEventListener('click', () => {
      this.weekOffset = 0
      this.render()
    })
    if (this.weekOffset === 0) todayBtn.addClass('pm-weekly-nav-today--active')

    const nextBtn = nav.createEl('button', { cls: 'pm-weekly-nav-btn', text: '→' })
    nextBtn.setAttribute('aria-label', 'Next week')
    nextBtn.addEventListener('click', () => {
      this.weekOffset += 1
      this.render()
    })

    const ref = today().add({ weeks: this.weekOffset })
    const days = getWeekDays(ref)
    const mon = days[0]
    const sun = days[6]
    const label = nav.createEl('span', {
      cls: 'pm-weekly-nav-label',
      text: `${mon.toLocaleString('en-US', { month: 'short', day: 'numeric' })} – ${sun.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    })
    nav.insertBefore(label, nextBtn)
  }

  private renderBoard(board: HTMLElement): void {
    board.empty()

    const ref = today().add({ weeks: this.weekOffset })
    const allDays = getWeekDays(ref)
    const todayStr = today().toString()

    // Flatten all tasks and filter to this week
    const allTasks = flattenTasks(this.project.tasks)
      .map((ft) => ft.task)
      .filter((t) => !t.archived)

    // Determine which days have tasks (for Sat/Sun conditional display)
    const tasksByDay = new Map<string, Task[]>()
    for (const day of allDays) {
      const dayStr = day.toString()
      tasksByDay.set(dayStr, allTasks.filter((t) => t.due === dayStr))
    }

    // Show Mon–Fri always; Sat/Sun only if tasks exist
    const visibleDays = allDays.filter((day, idx) => {
      if (idx < 5) return true // Mon–Fri
      return (tasksByDay.get(day.toString()) ?? []).length > 0
    })

    // Label column (time block labels on the left)
    const labelCol = board.createDiv('pm-weekly-label-col')
    labelCol.createDiv('pm-weekly-day-header-spacer') // aligns with day header row
    for (const block of TIME_BLOCKS) {
      const cell = labelCol.createDiv('pm-weekly-block-label')
      cell.createEl('span', { cls: 'pm-weekly-block-icon', text: block.icon })
      cell.createEl('span', { cls: 'pm-weekly-block-name', text: block.label })
    }

    // Day columns
    for (const day of visibleDays) {
      const dayStr = day.toString()
      const isToday = dayStr === todayStr
      const dayIdx = day.dayOfWeek - 1 // 0=Mon
      const tasks = tasksByDay.get(dayStr) ?? []

      const col = board.createDiv('pm-weekly-col')
      if (isToday) col.addClass('pm-weekly-col--today')

      // Day header
      const header = col.createDiv('pm-weekly-day-header')
      const dayLabel = header.createDiv('pm-weekly-day-name')
      dayLabel.createEl('span', { text: DAY_NAMES[dayIdx], cls: 'pm-weekly-day-abbr' })
      const dateEl = header.createEl('span', {
        text: day.toLocaleString('en-US', { month: 'short', day: 'numeric' }),
        cls: isToday ? 'pm-weekly-day-date pm-weekly-day-date--today' : 'pm-weekly-day-date'
      })
      if (isToday) {
        const dot = header.createEl('span', { cls: 'pm-weekly-today-dot' })
        dateEl.prepend(dot)
      }

      // Task count badge
      const nonDone = tasks.filter((t) => !isTerminalStatus(t.status, this.plugin.settings.statuses))
      if (tasks.length > 0) {
        header.createEl('span', {
          text: String(nonDone.length > 0 ? nonDone.length : tasks.length),
          cls: nonDone.length > 0 ? 'pm-weekly-day-count' : 'pm-weekly-day-count pm-weekly-day-count--done'
        })
      }

      // Time block rows
      for (const block of TIME_BLOCKS) {
        const blockTasks = tasks.filter((t) => getTimeBlock(t) === block.id)
        this.renderBlockCell(col, dayStr, block.id, blockTasks)
      }
    }
  }

  private renderBlockCell(col: HTMLElement, dayStr: string, block: TimeBlock, tasks: Task[]): void {
    const cell = col.createDiv('pm-weekly-block-cell')
    cell.dataset.day = dayStr
    cell.dataset.block = block

    const cards = cell.createDiv('pm-weekly-block-cards')

    for (const task of tasks) {
      this.renderCard(cards, task)
    }

    // Drop zone
    cell.addEventListener('dragover', (e) => {
      e.preventDefault()
      cell.addClass('pm-weekly-drop-target')
      const afterEl = this.getDragAfterElement(cards, e.clientY)
      const dragging = cards.querySelector('.pm-weekly-card--dragging')
      if (dragging) {
        if (afterEl) cards.insertBefore(dragging, afterEl)
        else cards.appendChild(dragging)
      }
    })

    cell.addEventListener('dragleave', (e) => {
      if (!cell.contains(e.relatedTarget as Node)) {
        cell.removeClass('pm-weekly-drop-target')
      }
    })

    cell.addEventListener(
      'drop',
      safeAsync(async (e: DragEvent) => {
        e.preventDefault()
        cell.removeClass('pm-weekly-drop-target')
        if (!this.dragTask) return

        const patch: Partial<Task> = {}
        if (dayStr !== this.dragSourceDue) patch.due = dayStr
        if (block !== this.dragSourceBlock) {
          patch.customFields = { ...this.dragTask.customFields, time_block: block }
        }

        if (Object.keys(patch).length > 0) {
          await this.plugin.store.updateTask(this.project, this.dragTask.id, patch)
          await this.onRefresh()
        }
        this.dragTask = null
        this.dragSourceDue = null
        this.dragSourceBlock = null
      })
    )
  }

  private renderCard(container: HTMLElement, task: Task): void {
    const card = container.createDiv('pm-weekly-card')
    card.draggable = true
    card.dataset.taskId = task.id

    const priorityConfig = getPriorityConfig(this.plugin.settings.priorities, task.priority)
    if (priorityConfig && task.priority !== 'medium' && task.priority !== 'low') {
      const bar = card.createDiv('pm-weekly-card-priority-bar')
      bar.setCssStyles({ background: priorityConfig.color })
    }

    const body = card.createDiv('pm-weekly-card-body')

    // Title row
    const titleRow = body.createDiv('pm-weekly-card-title-row')
    titleRow.createEl('span', { text: task.title, cls: 'pm-weekly-card-title' })

    // Time metadata row (scheduled_time + estimated_duration)
    const scheduledTime = getScheduledTime(task)
    const estimatedDuration = getEstimatedDuration(task)
    if (scheduledTime || estimatedDuration) {
      const timeMeta = body.createDiv('pm-weekly-card-time')
      if (scheduledTime) {
        timeMeta.createEl('span', { text: `🕐 ${scheduledTime}`, cls: 'pm-weekly-card-scheduled' })
      }
      if (estimatedDuration) {
        timeMeta.createEl('span', { text: `⏱ ${estimatedDuration}`, cls: 'pm-weekly-card-duration' })
      }
    }

    // Status badge (inline editable)
    const footer = body.createDiv('pm-weekly-card-footer')
    renderStatusBadge(footer, task, this.plugin.settings.statuses, safeAsync(async (status) => {
      await this.plugin.store.updateTask(this.project, task.id, { status })
      await this.onRefresh()
    }))

    // Overdue indicator
    if (isTaskOverdue(task, this.plugin.settings.statuses)) {
      footer.createEl('span', { text: 'overdue', cls: 'pm-weekly-card-overdue' })
    }

    // Drag
    card.addEventListener('dragstart', () => {
      this.dragTask = task
      this.dragSourceDue = task.due
      this.dragSourceBlock = getTimeBlock(task)
      card.addClass('pm-weekly-card--dragging')
      activeWindow.setTimeout(() => card.addClass('pm-dragging'), 0)
    })

    card.addEventListener('dragend', () => {
      card.removeClass('pm-weekly-card--dragging')
      card.removeClass('pm-dragging')
    })

    // Click to open modal
    card.addEventListener('click', () => {
      openTaskModal(this.plugin, this.project, {
        task,
        onSave: safeAsync(async () => {
          await this.onRefresh()
        })
      })
    })

    // Right-click context menu
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const menu = new Menu()
      buildTaskContextMenu(menu, task, { plugin: this.plugin, project: this.project, onRefresh: this.onRefresh })
      menu.showAtMouseEvent(e)
    })
  }

  private getDragAfterElement(container: HTMLElement, y: number): Element | null {
    const cards = Array.from(container.querySelectorAll('.pm-weekly-card:not(.pm-weekly-card--dragging)'))
    let closest: Element | null = null
    let closestOffset = Number.NEGATIVE_INFINITY
    for (const card of cards) {
      const box = card.getBoundingClientRect()
      const offset = y - box.top - box.height / 2
      if (offset < 0 && offset > closestOffset) {
        closestOffset = offset
        closest = card
      }
    }
    return closest
  }
}
