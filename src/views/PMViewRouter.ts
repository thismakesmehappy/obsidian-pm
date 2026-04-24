import { TFile } from 'obsidian'
import type PMPlugin from '../main'
import { PM_DASHBOARD_VIEW_TYPE } from './DashboardView'
import { PM_PROJECT_VIEW_TYPE } from './ProjectView'

export class PMViewRouter {
  constructor(private plugin: PMPlugin) {}

  async openDashboard(): Promise<void> {
    const ws = this.plugin.app.workspace
    const leaf = this.getReusableLeaf()
    await leaf.setViewState({ type: PM_DASHBOARD_VIEW_TYPE, state: {} })
    await ws.revealLeaf(leaf)
  }

  async openProject(file: TFile): Promise<void> {
    const ws = this.plugin.app.workspace
    const leaf = this.getReusableLeaf()
    await leaf.setViewState({ type: PM_PROJECT_VIEW_TYPE, state: { filePath: file.path } })
    await ws.revealLeaf(leaf)
  }

  async openProjectByPath(path: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path)
    if (file instanceof TFile) await this.openProject(file)
  }

  async openAllTasks(): Promise<void> {
    const ws = this.plugin.app.workspace
    const leaf = this.getReusableLeaf()
    await leaf.setViewState({ type: PM_PROJECT_VIEW_TYPE, state: { virtualProjectId: '__all_tasks__' } })
    await ws.revealLeaf(leaf)
  }

  private getReusableLeaf() {
    const ws = this.plugin.app.workspace
    const activeLeaf = ws.activeLeaf
    const activeType = activeLeaf?.view.getViewType()
    if (activeLeaf && (activeType === PM_DASHBOARD_VIEW_TYPE || activeType === PM_PROJECT_VIEW_TYPE)) {
      return activeLeaf
    }
    return ws.getLeaf('tab')
  }
}
