import { ItemView, WorkspaceLeaf, TFile, EventRef } from 'obsidian'
import type PMPlugin from '../main'
import { Project, ViewMode } from '../types'
import { truncateTitle, safeAsync } from '../utils'
import type { SubView } from './SubView'
import { TableView } from './table/TableView'
import type { TableViewState } from './table/TableView'
import { GanttView } from './gantt/GanttView'
import { KanbanView } from './KanbanView'
import { WeeklyKanbanView } from './WeeklyKanbanView'
import { openProjectModal, openTaskModal, openProjectPicker } from '../ui/ModalFactory'

export const PM_PROJECT_VIEW_TYPE = 'pm-project'

interface ProjectViewState {
  filePath?: string
  virtualProjectId?: string
  [key: string]: unknown
}

export class ProjectView extends ItemView {
  plugin: PMPlugin
  project: Project | null = null
  filePath = ''
  virtualProjectId: string | null = null
  currentView: ViewMode
  private subview: SubView | null = null
  private savedTableViewState: TableViewState | null = null
  private toolbarEl!: HTMLElement
  private bodyEl!: HTMLElement
  private titleEl2!: HTMLElement
  private sourceProjects: Project[] = []
  private taskProjectMap = new Map<string, Project>()
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null
  private fileModifyRef: EventRef | null = null
  private reloadDebounceTimer: number | null = null

  constructor(leaf: WorkspaceLeaf, plugin: PMPlugin) {
    super(leaf)
    this.plugin = plugin
    this.currentView = plugin.settings.defaultView
    this.navigation = false
  }

  getViewType(): string {
    return PM_PROJECT_VIEW_TYPE
  }
  getDisplayText(): string {
    return this.project ? `TMMH PM: ${truncateTitle(this.project.title, 18)}` : 'TMMH PM'
  }
  getIcon(): string {
    return 'folder-kanban'
  }

  async setState(state: ProjectViewState, result: unknown): Promise<void> {
    const nextFilePath = state.filePath ?? ''
    const nextVirtualProjectId = state.virtualProjectId ?? null
    if (nextFilePath !== this.filePath || nextVirtualProjectId !== this.virtualProjectId) {
      this.filePath = nextFilePath
      this.virtualProjectId = nextVirtualProjectId
      await this.loadProject()
    }
    await super.setState(state, result as import('obsidian').ViewStateResult)
  }

  getState(): ProjectViewState {
    return {
      filePath: this.filePath || undefined,
      virtualProjectId: this.virtualProjectId ?? undefined
    }
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass('pm-view')
    const root = this.contentEl
    root.empty()
    root.addClass('pm-root')
    this.toolbarEl = root.createDiv('pm-toolbar')
    this.bodyEl = root.createDiv('pm-content')

    if (this.filePath || this.virtualProjectId) await this.loadProject()

    this.keydownHandler = (e: KeyboardEvent) => {
      this.subview?.handleKeyDown?.(e)
    }
    this.containerEl.addEventListener('keydown', this.keydownHandler)
    if (!this.containerEl.hasAttribute('tabindex')) {
      this.containerEl.setAttribute('tabindex', '-1')
    }

    const reloadIfRelevant = (filePath: string) => {
      if (!this.project) return false
      if (this.virtualProjectId === '__all_tasks__') {
        return filePath.startsWith(this.plugin.settings.projectsFolder + '/')
      }
      if (!this.filePath) return false
      const taskFolder = this.filePath.replace(/\.md$/, '_tasks')
      return filePath.startsWith(taskFolder) || filePath === this.filePath
    }
    this.fileModifyRef = this.app.vault.on('modify', (file) => {
      if (!(file instanceof TFile) || !reloadIfRelevant(file.path)) return
      if (this.reloadDebounceTimer !== null) activeWindow.clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = activeWindow.setTimeout(
        safeAsync(async () => {
          this.reloadDebounceTimer = null
          await this.loadProject()
        }),
        300
      )
    })
    this.registerEvent(this.fileModifyRef)
    this.registerEvent(
      this.app.vault.on(
        'delete',
        safeAsync(async (file) => {
          if (reloadIfRelevant(file.path)) {
            await this.loadProject()
          }
        })
      )
    )
  }

  onClose(): Promise<void> {
    if (this.reloadDebounceTimer !== null) {
      activeWindow.clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = null
    }
    if (this.keydownHandler) {
      this.containerEl.removeEventListener('keydown', this.keydownHandler)
      this.keydownHandler = null
    }
    this.fileModifyRef = null
    this.subview?.destroy?.()
    this.subview = null
    return Promise.resolve()
  }

  private async loadProject(): Promise<void> {
    if (this.virtualProjectId === '__all_tasks__') {
      const { project, sourceProjects, taskProjectMap } = await this.plugin.store.loadAllTasksProject(
        this.plugin.settings.projectsFolder
      )
      this.project = project
      this.sourceProjects = sourceProjects
      this.taskProjectMap = taskProjectMap
      ;(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.()
      this.renderProjectToolbar()
      this.renderCurrentView()
      return
    }

    const file = this.app.vault.getAbstractFileByPath(this.filePath)
    if (!(file instanceof TFile)) {
      this.renderMissingProject()
      return
    }
    this.project = await this.plugin.store.loadProject(file)
    if (!this.project) {
      this.renderMissingProject()
      return
    }
    this.sourceProjects = await this.plugin.store.loadAllProjects(this.plugin.settings.projectsFolder)
    this.taskProjectMap = new Map()
    for (const task of this.project.tasks) {
      this.indexTaskProject(task, this.project)
    }
    ;(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.()
    this.renderProjectToolbar()
    this.renderCurrentView()
  }

  private renderMissingProject(): void {
    this.toolbarEl.empty()
    this.bodyEl.empty()
    const msg = this.bodyEl.createDiv('pm-empty-state')
    msg.createEl('h3', { text: 'Project not found' })
    msg.createEl('p', { text: `No project at ${this.filePath}. It may have been deleted or renamed.` })
  }

  private renderProjectToolbar(): void {
    if (!this.project) return
    this.toolbarEl.empty()

    const left = this.toolbarEl.createDiv('pm-toolbar-left')
    const navWrap = left.createDiv('pm-project-nav')
    const crumbs = navWrap.createDiv('pm-project-breadcrumbs')
    const dashboardLink = crumbs.createEl('button', { text: 'Projects', cls: 'pm-breadcrumb-btn' })
    dashboardLink.addEventListener('click', () => {
      void this.plugin.router.openDashboard()
    })
    crumbs.createEl('span', { text: '/', cls: 'pm-breadcrumb-sep' })
    crumbs.createEl('span', { text: this.project.title, cls: 'pm-breadcrumb-current' })

    const iconEl = left.createEl('span', {
      text: this.project.icon,
      cls: 'pm-toolbar-icon',
      attr: { 'aria-label': 'Edit project', role: 'button', tabindex: '0' }
    })
    iconEl.addEventListener('click', () => {
      if (this.project?.virtual) return
      openProjectModal(this.plugin, {
        project: this.project,
        onSave: (updated) => {
          this.project = updated
          this.renderProjectToolbar()
        }
      })
    })

    this.titleEl2 = left.createEl('h2', { text: this.project.title, cls: 'pm-toolbar-title' })
    this.titleEl2.contentEditable = this.project.virtual ? 'false' : 'true'
    this.titleEl2.addEventListener(
      'blur',
      safeAsync(async () => {
        if (!this.project || this.project.virtual) return
        this.project.title = this.titleEl2.textContent?.trim() ?? this.project.title
        await this.plugin.store.saveProject(this.project)
      })
    )

    const switcher = this.toolbarEl.createDiv('pm-view-switcher')
    const views: { mode: ViewMode; icon: string; label: string }[] = [
      { mode: 'table', icon: '≡', label: 'Table' },
      { mode: 'gantt', icon: '▬', label: 'Gantt' },
      { mode: 'kanban', icon: '⊞', label: 'Board' },
      { mode: 'weekly', icon: '📅', label: 'Week' }
    ]
    for (const v of views) {
      const btn = switcher.createEl('button', {
        cls: 'pm-view-btn',
        attr: { 'aria-label': `Switch to ${v.label} view` }
      })
      btn.createEl('span', { text: v.icon, cls: 'pm-view-btn-icon' })
      btn.createEl('span', { text: v.label })
      if (v.mode === this.currentView) btn.addClass('pm-view-btn--active')
      btn.addEventListener('click', () => {
        this.currentView = v.mode
        switcher.querySelectorAll('.pm-view-btn').forEach((b) => b.removeClass('pm-view-btn--active'))
        btn.addClass('pm-view-btn--active')
        this.renderCurrentView()
      })
    }

    const right = this.toolbarEl.createDiv('pm-toolbar-right')
    const projectSelect = right.createEl('select', { cls: 'pm-project-switcher' })
    projectSelect.createEl('option', { value: '__all_tasks__', text: 'All Tasks' })
    for (const sourceProject of this.sourceProjects.length ? this.sourceProjects : [this.project]) {
      projectSelect.createEl('option', { value: sourceProject.id, text: sourceProject.title })
    }
    projectSelect.value = this.project.virtual ? '__all_tasks__' : this.project.id
    projectSelect.addEventListener('change', () => {
      if (projectSelect.value === '__all_tasks__') {
        void this.plugin.router.openAllTasks()
        return
      }
      const target = this.sourceProjects.find((candidate) => candidate.id === projectSelect.value)
      if (target) {
        void this.plugin.router.openProjectByPath(target.filePath)
      }
    })

    const addBtn = right.createEl('button', { text: '+ add task', cls: 'pm-btn pm-btn-primary' })
    addBtn.addEventListener('click', () => {
      if (!this.project) return
      if (this.project.virtual) {
        openProjectPicker(this.plugin, this.sourceProjects, (project) => {
          openTaskModal(this.plugin, project, {
            onSave: async () => {
              await this.refreshProject()
            }
          })
        })
        return
      }
      openTaskModal(this.plugin, this.project, {
        onSave: async () => {
          await this.refreshProject()
        }
      })
    })

    const settingsBtn = right.createEl('button', {
      cls: 'pm-btn pm-btn-icon',
      attr: { 'aria-label': 'Project settings' }
    })
    settingsBtn.createEl('span', { text: '⚙' })
    settingsBtn.addEventListener('click', () => {
      if (!this.project || this.project.virtual) return
      openProjectModal(this.plugin, {
        project: this.project,
        onSave: (updated) => {
          this.project = updated
          this.renderProjectToolbar()
          this.renderCurrentView()
        }
      })
    })
  }

  private renderCurrentView(): void {
    if (!this.project) return

    const quickAddFocused =
      activeDocument.activeElement instanceof HTMLElement && activeDocument.activeElement.matches('.pm-quick-add-input')

    let savedGanttScroll: ReturnType<GanttView['getScrollPosition']> | null = null
    let savedGanttLabelWidth: number | null = null
    if (this.currentView === 'gantt' && this.subview instanceof GanttView) {
      savedGanttScroll = this.subview.getScrollPosition()
      savedGanttLabelWidth = this.subview.getLabelWidth()
    }

    if (this.subview instanceof TableView) {
      this.savedTableViewState = this.subview.getViewState()
    } else if (this.currentView !== 'table') {
      this.savedTableViewState = null
    }

    this.subview?.destroy?.()
    this.bodyEl.empty()
    this.subview = null

    switch (this.currentView) {
      case 'table':
        this.subview = new TableView(
          this.bodyEl,
          this.project,
          this.plugin,
          () => this.refreshProject(),
          this.savedTableViewState ?? undefined,
          {
            resolveProjectForTask: (task) => this.resolveProjectForTask(task.id),
            availableProjects: this.sourceProjects.length ? this.sourceProjects : this.project ? [this.project] : [],
            openProjectById: (projectId) => {
              const target = this.sourceProjects.find((project) => project.id === projectId)
              if (target) void this.plugin.router.openProjectByPath(target.filePath)
            }
          }
        )
        break
      case 'gantt': {
        const gantt = new GanttView(this.bodyEl, this.project, this.plugin, () => this.refreshProject())
        if (savedGanttScroll) gantt.setPendingScroll(savedGanttScroll)
        if (savedGanttLabelWidth !== null) gantt.setLabelWidth(savedGanttLabelWidth)
        this.subview = gantt
        break
      }
      case 'kanban':
        this.subview = new KanbanView(this.bodyEl, this.project, this.plugin, () => this.refreshProject(), (taskId) => this.resolveProjectForTask(taskId))
        break
      case 'weekly':
        this.subview = new WeeklyKanbanView(this.bodyEl, this.project, this.plugin, () => this.refreshProject(), (taskId) => this.resolveProjectForTask(taskId))
        break
    }
    this.subview?.render()

    if (quickAddFocused) {
      const newInput = this.bodyEl.querySelector('.pm-quick-add-input') as HTMLInputElement
      if (newInput) newInput.focus()
    }
  }

  async refreshProject(): Promise<void> {
    if (this.virtualProjectId === '__all_tasks__') {
      await this.loadProject()
      return
    }
    if (!this.filePath) return
    if (this.reloadDebounceTimer !== null) {
      activeWindow.clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = null
    }
    const file = this.app.vault.getAbstractFileByPath(this.filePath)
    if (file instanceof TFile) {
      this.project = await this.plugin.store.loadProject(file)
      this.sourceProjects = this.project ? await this.plugin.store.loadAllProjects(this.plugin.settings.projectsFolder) : []
      this.taskProjectMap = new Map()
      if (this.project) {
        for (const task of this.project.tasks) {
          this.indexTaskProject(task, this.project)
        }
      }
    }
    this.renderCurrentView()
  }

  private resolveProjectForTask(taskId: string): Project {
    return this.taskProjectMap.get(taskId) ?? this.project!
  }

  private indexTaskProject(task: Project['tasks'][number], project: Project): void {
    this.taskProjectMap.set(task.id, project)
    for (const subtask of task.subtasks) this.indexTaskProject(subtask, project)
  }
}
