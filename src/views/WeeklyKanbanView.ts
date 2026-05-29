import { Menu } from 'obsidian'
import type PMPlugin from '../main'
import { Project, Task, TaskStatus, TaskPriority } from '../types'
import { today, Temporal } from '../dates'
import { flattenTasks } from '../store/TaskTreeOps'
import { safeAsync, getStatusConfig, getPriorityConfig, isTaskOverdue, isTerminalStatus } from '../utils'
import { renderStatusBadge } from '../ui/StatusBadge'
import { openTaskModal } from '../ui/ModalFactory'
import { buildTaskContextMenu } from '../ui/TaskContextMenu'
import { renderFilterDropdown } from '../ui/FilterDropdown'
import { formatBadgeText } from '../utils'
import { TimeBlock, TIME_BLOCKS, DEFAULT_TIME_BLOCK, isTimeBlock } from '../timeBlocks'
import { collectAllAssignees, collectAllTags, collectAllSprints } from '../store'
import type { SubView } from './SubView'

interface WeeklyFilter {
  text: string
  statuses: TaskStatus[]
  priorities: TaskPriority[]
  assignees: string[]
  tags: string[]
  sprints: string[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function getWeekDays(referenceDate: Temporal.PlainDate): Temporal.PlainDate[] {
  const dow    = referenceDate.dayOfWeek        // 1=Mon … 7=Sun
  const monday = referenceDate.subtract({ days: dow - 1 })
  return Array.from({ length: 7 }, (_, i) => monday.add({ days: i }))
}

function getTimeBlock(task: Task): TimeBlock {
  const raw = task.customFields?.time_block
  return isTimeBlock(raw) ? raw : DEFAULT_TIME_BLOCK
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

// ─── View ─────────────────────────────────────────────────────────────────────

export class WeeklyKanbanView implements SubView {
  private dragTask:        Task | null      = null
  private dragSourceDue:   string | null    = null
  private dragSourceBlock: TimeBlock | null = null

  private cleanupFns: (() => void)[] = []
  private weekOffset = 0
  private filter: WeeklyFilter = {
    text: '', statuses: [], priorities: [], assignees: [], tags: [], sprints: []
  }

  constructor(
    private container:       HTMLElement,
    private project:         Project,
    private plugin:          PMPlugin,
    private onRefresh:       () => Promise<void>,
    private resolveProject:  (taskId: string) => Project = () => project
  ) {}

  destroy(): void {
    for (const fn of this.cleanupFns) fn()
    this.cleanupFns = []
  }

  render(): void {
    this.destroy()
    this.container.empty()
    this.container.addClass('pm-weekly-view')

    const nav = this.container.createDiv('pm-weekly-nav')
    this.renderNav(nav)

    const board = this.container.createDiv('pm-weekly-board')
    this.renderBoard(board)
  }

  // ─── Nav ──────────────────────────────────────────────────────────────────

  private renderNav(nav: HTMLElement): void {
    nav.empty()

    // ── Week navigation ──
    const prevBtn = nav.createEl('button', { cls: 'pm-weekly-nav-btn', text: '←' })
    prevBtn.setAttribute('aria-label', 'Previous week')
    prevBtn.addEventListener('click', () => { this.weekOffset -= 1; this.render() })

    const todayBtn = nav.createEl('button', {
      cls: 'pm-weekly-nav-btn pm-weekly-nav-today', text: 'Today'
    })
    todayBtn.addEventListener('click', () => { this.weekOffset = 0; this.render() })
    if (this.weekOffset === 0) todayBtn.addClass('pm-weekly-nav-today--active')

    const nextBtn = nav.createEl('button', { cls: 'pm-weekly-nav-btn', text: '→' })
    nextBtn.setAttribute('aria-label', 'Next week')
    nextBtn.addEventListener('click', () => { this.weekOffset += 1; this.render() })

    const ref  = today().add({ weeks: this.weekOffset })
    const days = getWeekDays(ref)
    const label = nav.createEl('span', {
      cls:  'pm-weekly-nav-label',
      text: `${days[0].toLocaleString('en-US', { month: 'short', day: 'numeric' })} – ${days[6].toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    })
    nav.insertBefore(label, nextBtn)

    // ── Spacer ──
    nav.createEl('span', { cls: 'pm-weekly-nav-spacer' })

    // ── Filters row (on narrow viewports this wraps to a second line via CSS) ──
    const filters = nav.createDiv('pm-weekly-nav-filters')

    // Text search — re-renders board only so the input keeps focus
    const search = filters.createEl('input', {
      type:        'text',
      placeholder: 'Search…',
      cls:         'pm-filter-input pm-weekly-search'
    })
    search.value = this.filter.text
    search.addEventListener('input', () => {
      this.filter.text = search.value
      const board = this.container.querySelector('.pm-weekly-board') as HTMLElement | null
      if (board) this.renderBoard(board)
    })

    // Status
    renderFilterDropdown(
      filters, 'Status', this.filter.statuses,
      this.plugin.settings.statuses.map((s) => ({ id: s.id, label: formatBadgeText(s.icon, s.label) })),
      (sel) => { this.filter.statuses = sel; this.render() }
    )

    // Priority
    renderFilterDropdown(
      filters, 'Priority', this.filter.priorities,
      this.plugin.settings.priorities.map((p) => ({ id: p.id, label: formatBadgeText(p.icon, p.label) })),
      (sel) => { this.filter.priorities = sel as TaskPriority[]; this.render() }
    )

    // Assignee (conditional)
    const allAssignees = collectAllAssignees(this.project.tasks)
    if (allAssignees.length) {
      renderFilterDropdown(
        filters, 'Assignee', this.filter.assignees,
        allAssignees.map((a) => ({ id: a, label: a })),
        (sel) => { this.filter.assignees = sel; this.render() }
      )
    }

    // Tag (conditional)
    const allTags = collectAllTags(this.project.tasks)
    if (allTags.length) {
      renderFilterDropdown(
        filters, 'Tag', this.filter.tags,
        allTags.map((t) => ({ id: t, label: t })),
        (sel) => { this.filter.tags = sel; this.render() }
      )
    }

    // Sprint (conditional)
    const allSprints = collectAllSprints(this.project.tasks)
    if (allSprints.length) {
      renderFilterDropdown(
        filters, 'Sprint', this.filter.sprints,
        allSprints.map((s) => ({ id: s, label: s })),
        (sel) => { this.filter.sprints = sel; this.render() }
      )
    }

    // Condensed / Full toggle — persisted in plugin settings
    const condensed     = this.plugin.settings.weeklyCondensed
    const condensedBtn  = filters.createEl('button', {
      cls:  'pm-weekly-nav-btn pm-weekly-condensed-btn',
      text: condensed ? 'Full' : 'Condensed',
      attr: { 'aria-label': 'Toggle condensed card view' }
    })
    if (condensed) condensedBtn.addClass('pm-weekly-condensed-btn--active')
    condensedBtn.addEventListener('click', () => {
      this.plugin.settings.weeklyCondensed = !this.plugin.settings.weeklyCondensed
      this.plugin.saveSettings()
      this.render()
    })
  }

  // ─── Filter ───────────────────────────────────────────────────────────────

  private applyFilter(tasks: Task[]): Task[] {
    let result = tasks
    if (this.filter.text) {
      const q = this.filter.text.toLowerCase()
      result = result.filter((t) =>
        t.title.toLowerCase().includes(q) ||
        t.status.toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q)) ||
        t.assignees.some((a) => a.toLowerCase().includes(q)) ||
        t.sprints.some((s) => s.toLowerCase().includes(q))
      )
    }
    if (this.filter.statuses.length)   result = result.filter((t) => this.filter.statuses.includes(t.status))
    if (this.filter.priorities.length) result = result.filter((t) => this.filter.priorities.includes(t.priority))
    if (this.filter.assignees.length)  result = result.filter((t) => t.assignees.some((a) => this.filter.assignees.includes(a)))
    if (this.filter.tags.length)       result = result.filter((t) => t.tags.some((tag) => this.filter.tags.includes(tag)))
    if (this.filter.sprints.length)    result = result.filter((t) => t.sprints.some((s) => this.filter.sprints.includes(s)))
    return result
  }

  // ─── Board ────────────────────────────────────────────────────────────────

  private renderBoard(board: HTMLElement): void {
    board.empty()

    const ref      = today().add({ weeks: this.weekOffset })
    const allDays  = getWeekDays(ref)
    const todayStr = today().toString()

    // Raw task map — unfiltered, used for weekend visibility + header counts
    const allTasksRaw = flattenTasks(this.project.tasks)
      .map((ft) => ft.task)
      .filter((t) => !t.archived)

    const tasksByDayRaw = new Map<string, Task[]>()
    for (const day of allDays) {
      const ds = day.toString()
      tasksByDayRaw.set(ds, allTasksRaw.filter((t) => t.due === ds))
    }

    // Show Sat + Sun together if either has tasks
    const showWeekend =
      (tasksByDayRaw.get(allDays[5].toString()) ?? []).length > 0 ||
      (tasksByDayRaw.get(allDays[6].toString()) ?? []).length > 0

    const visibleDays = allDays.filter((_, i) => i < 5 || showWeekend)
    const numDayCols  = visibleDays.length

    board.setAttribute(
      'style',
      `grid-template-columns: 90px repeat(${numDayCols}, minmax(120px, 1fr)); ` +
      `grid-template-rows: 52px auto auto auto auto auto;`
    )

    // Filtered task map for card rendering
    const tasksByDay = new Map<string, Task[]>()
    for (const day of allDays) {
      const ds = day.toString()
      tasksByDay.set(ds, this.applyFilter(tasksByDayRaw.get(ds) ?? []))
    }

    // Label column
    const labelCol = board.createDiv('pm-weekly-label-col')
    labelCol.createDiv('pm-weekly-day-header-spacer')
    for (const block of TIME_BLOCKS) {
      const cell = labelCol.createDiv('pm-weekly-block-label')
      cell.dataset.block = block.id
      cell.createEl('span', { cls: 'pm-weekly-block-icon', text: block.icon })
      cell.createEl('span', { cls: 'pm-weekly-block-name', text: block.label })
    }

    // Day columns
    for (const day of visibleDays) {
      const dayStr   = day.toString()
      const isToday  = dayStr === todayStr
      const dayIdx   = day.dayOfWeek - 1
      const tasks    = tasksByDay.get(dayStr)    ?? []
      const rawTasks = tasksByDayRaw.get(dayStr) ?? []

      const col = board.createDiv('pm-weekly-col')
      if (isToday) col.addClass('pm-weekly-col--today')
      if (rawTasks.some((t) => getTimeBlock(t) === 'all-day')) col.addClass('pm-weekly-col--has-allday')

      // Header
      const header  = col.createDiv('pm-weekly-day-header')
      const dayName = header.createDiv('pm-weekly-day-name')
      dayName.createEl('span', { text: DAY_NAMES[dayIdx], cls: 'pm-weekly-day-abbr' })
      const dateEl  = header.createEl('span', {
        text: day.toLocaleString('en-US', { month: 'short', day: 'numeric' }),
        cls:  isToday ? 'pm-weekly-day-date pm-weekly-day-date--today' : 'pm-weekly-day-date'
      })
      if (isToday) dateEl.prepend(header.createEl('span', { cls: 'pm-weekly-today-dot' }))

      const nonDone = rawTasks.filter((t) => !isTerminalStatus(t.status, this.plugin.settings.statuses))
      if (rawTasks.length > 0) {
        header.createEl('span', {
          text: String(nonDone.length > 0 ? nonDone.length : rawTasks.length),
          cls:  nonDone.length > 0 ? 'pm-weekly-day-count' : 'pm-weekly-day-count pm-weekly-day-count--done'
        })
      }

      for (const block of TIME_BLOCKS) {
        this.renderBlockCell(col, dayStr, block.id, tasks.filter((t) => getTimeBlock(t) === block.id))
      }
    }
  }

  // ─── Block cell ───────────────────────────────────────────────────────────

  private renderBlockCell(col: HTMLElement, dayStr: string, block: TimeBlock, tasks: Task[]): void {
    const cell  = col.createDiv('pm-weekly-block-cell')
    cell.dataset.day   = dayStr
    cell.dataset.block = block

    const cards = cell.createDiv('pm-weekly-block-cards')
    for (const task of tasks) this.renderCard(cards, task)

    // ── Mouse drop zone ──
    cell.addEventListener('dragover', (e) => {
      e.preventDefault()
      cell.addClass('pm-weekly-drop-target')
      const afterEl  = this.getDragAfterElement(cards, e.clientY)
      const dragging = cards.querySelector('.pm-weekly-card--dragging')
      if (dragging) {
        if (afterEl) cards.insertBefore(dragging, afterEl)
        else         cards.appendChild(dragging)
      }
    })

    cell.addEventListener('dragleave', (e) => {
      if (!cell.contains(e.relatedTarget as Node)) cell.removeClass('pm-weekly-drop-target')
    })

    cell.addEventListener('drop', safeAsync(async (e: DragEvent) => {
      e.preventDefault()
      cell.removeClass('pm-weekly-drop-target')
      if (!this.dragTask) return

      const patch: Partial<Task> = {}
      if (dayStr !== this.dragSourceDue)   patch.due          = dayStr
      if (block  !== this.dragSourceBlock) patch.customFields = { ...this.dragTask.customFields, time_block: block }

      if (Object.keys(patch).length > 0) {
        await this.plugin.store.updateTask(this.resolveProject(this.dragTask.id), this.dragTask.id, patch)
        await this.onRefresh()
      }
      this.dragTask = this.dragSourceDue = this.dragSourceBlock = null
    }))
  }

  // ─── Card ─────────────────────────────────────────────────────────────────

  private renderCard(container: HTMLElement, task: Task): void {
    const card = container.createDiv('pm-weekly-card')
    if (this.plugin.settings.weeklyCondensed) card.addClass('pm-weekly-card--condensed')
    card.draggable = true
    card.dataset.taskId = task.id

    const statusConfig = getStatusConfig(this.plugin.settings.statuses, task.status)
    const statusBar    = card.createDiv('pm-weekly-card-status-bar')
    statusBar.setCssStyles({ background: statusConfig?.color ?? '#8a94a0' })

    const body = card.createDiv('pm-weekly-card-body')

    const titleRow = body.createDiv('pm-weekly-card-title-row')
    titleRow.createEl('span', { text: task.title, cls: 'pm-weekly-card-title' })

    const estimatedDuration = getEstimatedDuration(task)
    if (estimatedDuration) {
      body.createDiv('pm-weekly-card-time')
        .createEl('span', { text: `⏱ ${estimatedDuration}`, cls: 'pm-weekly-card-duration' })
    }

    const footer = body.createDiv('pm-weekly-card-footer')
    renderStatusBadge(footer, task, this.plugin.settings.statuses, safeAsync(async (status) => {
      await this.plugin.store.updateTask(this.resolveProject(task.id), task.id, { status })
      await this.onRefresh()
    }))

    const block        = getTimeBlock(task)
    const blockDef     = TIME_BLOCKS.find((b) => b.id === block)
    const scheduledTime = getScheduledTime(task)
    if (blockDef) {
      const chip = footer.createEl('span', {
        cls: `pm-weekly-card-block-chip pm-weekly-card-block-chip--${block}`
      })
      chip.createEl('span', { cls: 'pm-weekly-card-block-chip-icon', text: blockDef.icon })
      if (scheduledTime) chip.createEl('span', { cls: 'pm-weekly-card-block-chip-time', text: scheduledTime })
    }

    if (isTaskOverdue(task, this.plugin.settings.statuses)) {
      footer.createEl('span', { text: 'overdue', cls: 'pm-weekly-card-overdue' })
    }

    const priorityConfig = getPriorityConfig(this.plugin.settings.priorities, task.priority)
    if (priorityConfig) {
      const dot = footer.createEl('span', { cls: 'pm-priority-dot' })
      dot.title = priorityConfig.label
      dot.setCssStyles({ background: priorityConfig.color })
      if (task.priority === 'medium' || task.priority === 'low') dot.addClass('pm-priority-dot--dim')
    }

    // ── Drag (mouse / pointer only) ──
    card.addEventListener('dragstart', () => {
      this.dragTask        = task
      this.dragSourceDue   = task.due
      this.dragSourceBlock = getTimeBlock(task)
      card.addClass('pm-weekly-card--dragging')
      activeWindow.setTimeout(() => card.addClass('pm-dragging'), 0)
    })
    card.addEventListener('dragend', () => {
      card.removeClass('pm-weekly-card--dragging')
      card.removeClass('pm-dragging')
    })

    // ── Condensed tap-to-expand (touch) ──
    if (this.plugin.settings.weeklyCondensed) {
      card.addEventListener('touchend', (e: TouchEvent) => {
        e.stopPropagation()
        card.toggleClass('pm-weekly-card--expanded', !card.hasClass('pm-weekly-card--expanded'))
      })
    }

    // ── Click to open modal ──
    card.addEventListener('click', () => {
      openTaskModal(this.plugin, this.resolveProject(task.id), {
        task,
        onSave: safeAsync(async () => { await this.onRefresh() })
      })
    })

    // ── Context menu — use element position as fallback for touch long-press ──
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const menu = new Menu()
      buildTaskContextMenu(menu, task, {
        plugin:    this.plugin,
        project:   this.resolveProject(task.id),
        onRefresh: this.onRefresh
      })
      // e.clientX/Y is 0,0 on iOS long-press; fall back to card bounding rect
      const x = e.clientX || card.getBoundingClientRect().left + 16
      const y = e.clientY || card.getBoundingClientRect().top  + 16
      menu.showAtPosition({ x, y })
    })
  }

  // ─── Drag helpers ────────────────────────────────────────────────────────

  private getDragAfterElement(container: HTMLElement, y: number): Element | null {
    const cards = Array.from(
      container.querySelectorAll('.pm-weekly-card:not(.pm-weekly-card--dragging)')
    )
    let closest: Element | null = null
    let closestOffset = Number.NEGATIVE_INFINITY
    for (const card of cards) {
      const box    = card.getBoundingClientRect()
      const offset = y - box.top - box.height / 2
      if (offset < 0 && offset > closestOffset) {
        closestOffset = offset
        closest = card
      }
    }
    return closest
  }
}
