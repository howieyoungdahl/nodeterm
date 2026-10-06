import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { parseAssistantCreation, type AssistantCreation } from '../shared/assistant-creation'
import { parseOrganizationMetadata, type OrganizationMetadata } from '../shared/kanban-organization'
import { isSafeNodeId } from '../shared/safe-id'
import { OPS_OPERATOR_SOURCE_ID } from '../shared/ops-operator-identity'
import { publicationPlatform } from '../core/workspace-publication-platform'

export interface ReceiptPublication {
  version: 1
  platform: NodeJS.Platform
  guarantee: 'file-and-directory-sync' | 'file-flush-visibility'
}
export const receiptPublication = (): ReceiptPublication => {
  const platform = publicationPlatform.nativePlatform()
  return { version: 1, platform, guarantee: platform === 'win32' ? 'file-flush-visibility' : 'file-and-directory-sync' }
}

export interface VerifiedCreationSource {
  /** These values come only from authenticated routing, never request fields. */
  principal: 'ops-bearer' | 'verified-node'
  sourceNodeId: string
  projectId: string
}
export interface AssistantCreationReceipt {
  version: 1; id: string; creation: AssistantCreation; verifiedCreator: VerifiedCreationSource
  nodes: Array<{ nodeId: string; organization: OrganizationMetadata }>
  fingerprint: string
  publication: ReceiptPublication
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** Immutable private evidence before a node is saved or launched. A receipt is creation intent,
 * not proof of a successful backend/task or named assistant identity. No retrospective adoption. */
export class AssistantCreationReceipts {
  // Automatic cleanup additionally needs this runtime's successful acknowledgment. Copied,
  // legacy or interrupted receipt files cannot manufacture that host-private admission.
  private readonly cleanupAdmissions = new Map<string, string>()
  constructor(private readonly dir: string,
    private readonly phase?: (phase: 'before-publish' | 'published' | 'acknowledged') => Promise<void>) {}
  private file(source: VerifiedCreationSource, id: string) { return path.join(this.dir, `${hash(JSON.stringify([source, id]))}.json`) }
  private operation(file: string) { return path.join(this.dir, '.publication', path.basename(file, '.json')) }
  private async pending(file: string): Promise<void> {
    try { await fs.lstat(path.join(this.operation(file), 'writer.lock')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    throw new Error('assistant_creation_receipt_pending_no_adoption')
  }
  /** Admission uses only host-private creator grants and immutable receipts. Shared node fields
   * are not a lookup credential and cannot retrospectively adopt a human-created card. */
  async attestNode(projectId: string, nodeId: string,
    owner: { projectId?: string; sourceNodeId: string; assistantCreationId?: string } | undefined): Promise<string | undefined> {
    if (!owner?.assistantCreationId || owner.projectId !== projectId ||
      !isSafeNodeId(owner.sourceNodeId) || !isSafeNodeId(owner.assistantCreationId) || !isSafeNodeId(nodeId)) return
    let files: string[]
    try { files = await fs.readdir(this.dir) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (files.length > 1000) throw new Error('assistant_creation_discovery_limit')
    let evidence: string | undefined
    for (const file of files) {
      if (file === '.publication' && (await fs.lstat(path.join(this.dir, file))).isDirectory()) continue
      if (!/^[a-f0-9]{64}\.json$/.test(file)) throw new Error('assistant_creation_receipt_invalid')
      const raw = await fs.readFile(path.join(this.dir, file), 'utf8')
      if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('assistant_creation_receipt_invalid')
      const candidate = JSON.parse(raw) as AssistantCreationReceipt
      if (candidate.id !== owner.assistantCreationId) continue
      const source: VerifiedCreationSource = { principal: owner.sourceNodeId === OPS_OPERATOR_SOURCE_ID ? 'ops-bearer' : 'verified-node',
        sourceNodeId: owner.sourceNodeId, projectId }
      const receipt = await this.find(source, candidate.creation?.creationId)
      if (!receipt || receipt.id !== owner.assistantCreationId || path.basename(this.file(source, receipt.creation.creationId)) !== file ||
        !receipt.nodes.some(n => n.nodeId === nodeId)) return
      if (publicationPlatform.nativePlatform() !== 'linux' || receipt.publication.platform !== 'linux' ||
        receipt.publication.guarantee !== 'file-and-directory-sync' || this.cleanupAdmissions.get(file) !== hash(raw)) return
      if (evidence) return // Ambiguous private receipt identity is never an admission.
      evidence = hash(JSON.stringify({ projectId, nodeId, owner, receipt }))
    }
    return evidence
  }
  async find(source: VerifiedCreationSource, creationId: string): Promise<AssistantCreationReceipt | undefined> {
    const file = this.file(source, creationId), operation = this.operation(file)
    try {
      await this.pending(file)
      if (!(await fs.lstat(file)).isFile()) throw new Error('assistant_creation_receipt_invalid')
      const raw = await fs.readFile(file, 'utf8')
      if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('assistant_creation_receipt_invalid')
      const receipt = JSON.parse(raw) as AssistantCreationReceipt
      if (receipt.version !== 1 || !parseAssistantCreation(receipt.creation) || receipt.creation.creationId !== creationId ||
        JSON.stringify(receipt.verifiedCreator) !== JSON.stringify(source) || !isSafeNodeId(receipt.id) ||
        !Array.isArray(receipt.nodes) || !receipt.nodes.length || receipt.nodes.length > 100 ||
        new Set(receipt.nodes.map(n => n.nodeId)).size !== receipt.nodes.length || receipt.nodes.some(n => !isSafeNodeId(n.nodeId) ||
          !parseOrganizationMetadata(n.organization) || n.organization.projectId !== source.projectId || n.organization.owner !== receipt.creation.declaredOwner) ||
        !/^[a-f0-9]{64}$/.test(receipt.fingerprint) || receipt.publication?.version !== 1 ||
        !['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd'].includes(receipt.publication.platform) ||
        receipt.publication.guarantee !== (receipt.publication.platform === 'win32' ? 'file-flush-visibility' : 'file-and-directory-sync'))
        throw new Error('assistant_creation_receipt_invalid')
      const ackFile = path.join(operation, 'ack.json')
      if (!(await fs.lstat(ackFile)).isFile()) throw new Error('assistant_creation_receipt_unconfirmed_no_adoption')
      const ackRaw = await fs.readFile(ackFile, 'utf8')
      if (Buffer.byteLength(ackRaw) > 256 * 1024) throw new Error('assistant_creation_receipt_invalid')
      const ack = JSON.parse(ackRaw)
      if (ack.version !== 1 || ack.receiptHash !== hash(raw) || JSON.stringify(ack.publication) !== JSON.stringify(receipt.publication))
        throw new Error('assistant_creation_receipt_unconfirmed_no_adoption')
      await this.pending(file)
      return receipt
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // An interrupted attempt is retained evidence, not virgin absence or a retry grant.
      try { await fs.lstat(operation) }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return; throw missing }
      throw new Error('assistant_creation_receipt_unconfirmed_no_adoption')
    }
  }
  async record(source: VerifiedCreationSource, creation: AssistantCreation,
    nodes: AssistantCreationReceipt['nodes'], fingerprint: string, receiptId: string = randomUUID()): Promise<AssistantCreationReceipt> {
    if (!parseAssistantCreation(creation) || !['ops-bearer', 'verified-node'].includes(source.principal) ||
      !isSafeNodeId(source.sourceNodeId) || !isSafeNodeId(source.projectId) || !isSafeNodeId(receiptId) ||
      !/^[a-f0-9]{64}$/.test(fingerprint) || !nodes.length || nodes.length > 100 ||
      new Set(nodes.map(n => n.nodeId)).size !== nodes.length || nodes.some(n => !isSafeNodeId(n.nodeId) ||
        !parseOrganizationMetadata(n.organization) || n.organization.projectId !== source.projectId || n.organization.owner !== creation.declaredOwner))
      throw new Error('assistant_creation_evidence_invalid')
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    if (!(await fs.lstat(this.dir)).isDirectory()) throw new Error('assistant_creation_evidence_unavailable')
    const receipt: AssistantCreationReceipt = { version: 1, id: receiptId, creation, verifiedCreator: source, nodes, fingerprint,
      publication: receiptPublication() }
    const raw = JSON.stringify(receipt), file = this.file(source, creation.creationId), operation = this.operation(file)
    const completed = await this.find(source, creation.creationId)
    if (completed) {
      if (JSON.stringify(completed) !== raw) throw new Error('assistant_creation_evidence_conflict')
      return completed
    }
    await fs.mkdir(operation, { recursive: true, mode: 0o700 })
    if (!(await fs.lstat(path.dirname(operation))).isDirectory() || !(await fs.lstat(operation)).isDirectory())
      throw new Error('assistant_creation_evidence_unavailable')
    const lock = path.join(operation, 'writer.lock')
    try { await fs.mkdir(lock, { mode: 0o700 }) }
    catch (error) { throw new Error('assistant_creation_receipt_pending_no_adoption', { cause: error }) }
    const retain = async (target: string, bytes: string) => {
      let handle
      try { handle = await fs.open(target, 'wx', 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await fs.lstat(target)).isFile() ||
          await fs.readFile(target, 'utf8') !== bytes) throw new Error('assistant_creation_evidence_conflict', { cause: error })
        handle = await fs.open(target, 'r+')
        try { await handle.sync() } finally { await handle.close() }
        return
      }
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    }
    const syncDirectories = async () => {
      // Windows promises flushed file bytes and exclusive visibility only. This is explicit
      // admission for existing creation flows, not a power-loss/retained archive guarantee.
      if (receipt.publication.guarantee === 'file-flush-visibility') return
      for (const dir of [operation, path.dirname(operation), this.dir, path.dirname(this.dir)]) {
        const handle = await fs.open(dir, 'r')
        try { await handle.sync() } finally { await handle.close() }
      }
    }
    let finished = false
    try {
      const candidate = path.join(operation, 'publication.json')
      await retain(path.join(operation, 'intent.json'), raw)
      await retain(candidate, raw)
      await syncDirectories()
      await this.phase?.('before-publish')
      try { await fs.link(candidate, file) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await fs.lstat(file)).isFile() ||
          await fs.readFile(file, 'utf8') !== raw) throw new Error('assistant_creation_evidence_conflict', { cause: error })
      }
      await syncDirectories()
      await this.phase?.('published')
      await retain(path.join(operation, 'ack.json'), JSON.stringify({ version: 1, receiptHash: hash(raw), publication: receipt.publication }))
      await syncDirectories()
      if (await fs.readFile(file, 'utf8') !== raw) throw new Error('assistant_creation_publication_unknown')
      await this.phase?.('acknowledged')
      await fs.rm(lock, { recursive: true })
      try { await syncDirectories() }
      catch (error) { await fs.mkdir(lock, { mode: 0o700 }); throw error }
      finished = true
      if (receipt.publication.platform === 'linux') this.cleanupAdmissions.set(path.basename(file), hash(raw))
      return receipt
    } finally {
      // Failed/conflicting calls keep their own lock and exact intent. Never steal or replay an
      // interrupted publication. Only a fully acknowledged record can enable save or launch.
      if (!finished) this.cleanupAdmissions.delete(path.basename(file))
    }
  }
}
