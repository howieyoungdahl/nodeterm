import { readPublicationFile } from '../core/project-commit-store'
import { platform } from '../core/platform'
import type { WorkspaceStore } from '../core/workspace-store'
import { WorkspaceWatcher } from '../core/workspace-watcher'
import { IPC } from '../shared/ipc'
import type { Project } from '../shared/types'

type WatchedWorkspaceStore = Pick<
  WorkspaceStore,
  'localRefPaths' | 'isSelfWrite' | 'readLocalRefByPath'
>

export interface ServerWorkspaceWatcherOptions {
  debounceMs?: number
  publish?: (project: Project) => void
  exclusive?: <T>(work: () => Promise<T>) => Promise<T>
}

/**
 * Give Server Edition the desktop's live hand-edit path without importing Electron: the shared
 * watcher identifies a genuine outside write, WorkspaceStore adopts the complete project, and the
 * existing workspace broadcast replaces the browser's clean canvas wholesale. A full Project is
 * intentional here — unlike `canvas:mut`, it carries bridge and rope removals as well as nodes.
 */
export function createServerWorkspaceWatcher(
  store: WatchedWorkspaceStore,
  options: ServerWorkspaceWatcherOptions = {}
): WorkspaceWatcher {
  const publish = options.publish ?? ((project: Project) => {
    platform().broadcast(IPC.workspaceExternalChange, project)
  })
  const watcher = new WorkspaceWatcher({
    paths: () => store.localRefPaths(),
    isSelfWrite: (filePath, content) => store.isSelfWrite(filePath, content),
    onExternalChange: (filePath) => {
      const read = async () => {
        // A queued filesystem notification may describe a server publication that finished
        // after the watcher's first content check. Recheck after the writer FIFO drains.
        const raw = await readPublicationFile(filePath)
        if (store.isSelfWrite(filePath, raw)) return null
        return store.readLocalRefByPath(filePath)
      }
      void (options.exclusive ? options.exclusive(read) : read())
        .then((changed) => {
          if (changed) publish(changed)
        })
        .catch((error) => {
          console.warn('[nodeterm-server] external workspace edit could not be adopted', error)
        })
    },
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs })
  })
  watcher.sync()
  return watcher
}
