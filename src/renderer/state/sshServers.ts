import { create } from 'zustand'
import type { SshServer } from '@shared/ssh'

interface SshServersState {
  servers: SshServer[]
  readError: string | null
  hydrate(): Promise<void>
  save(server: SshServer): Promise<void>
  remove(id: string): Promise<void>
}

export const useSshServers = create<SshServersState>((set) => ({
  servers: [],
  readError: null,
  async hydrate() {
    try {
      set({ servers: await window.nodeTerminal.ssh.list(), readError: null })
    } catch (error) {
      set({ readError: (error as { code?: string })?.code === 'E_UNSUPPORTED'
        ? 'Saved SSH server management is unavailable in this browser build.'
        : 'Saved SSH servers could not be read.' })
    }
  },
  async save(server) {
    set({ servers: await window.nodeTerminal.ssh.save(server) })
  },
  async remove(id) {
    set({ servers: await window.nodeTerminal.ssh.remove(id) })
  }
}))
