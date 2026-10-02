import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat, lstat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isWithin } from '../dsh/policy.js';
import type { Settings } from '../config.js';
import type { Result, Json } from '../protocol.js';

interface Snapshot {
  format: 1; target: string; createdAt: string; contentBase64: string; sha256: string;
}
interface BackupEntry { backup_name: string; path: string; target: string; bytes: number; createdAt: string; sha256: string }
const OWN_NAME = /^[0-9a-f]{24}\.[0-9TZ-]+\.[0-9a-f-]+\.irmia-backup\.json$/;

/** 原始字节快照只写入操作者拥有的专属状态目录。 */
export class BackupStore {
  readonly root: string;
  constructor(private readonly config: Settings) { this.root = join(config.stateDir, 'backups'); }

  key(target: string): string { return createHash('sha256').update(target).digest('hex').slice(0, 24); }

  assertOutsideProject(projectDir: string, target: string): void {
    if (isWithin(projectDir, this.root) || isWithin(this.config.stateDir, target)) {
      throw new Error('备份状态目录必须位于项目之外，且不能编辑插件状态文件');
    }
  }

  async save(target: string, bytes: Uint8Array): Promise<string> {
    await mkdir(this.root, { recursive: true });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const createdAt = new Date().toISOString();
    const name = `${this.key(target)}.${createdAt.replace(/[:.]/g, '-')}.${randomUUID()}.irmia-backup.json`;
    const data: Snapshot = { format: 1, target, createdAt, contentBase64: Buffer.from(bytes).toString('base64'), sha256 };
    await writeFile(join(this.root, name), JSON.stringify(data), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return name;
  }

  private async names(): Promise<string[]> {
    try { return (await readdir(this.root)).filter(name => OWN_NAME.test(name)); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async entries(target?: string): Promise<BackupEntry[]> {
    const entries: BackupEntry[] = [];
    for (const name of await this.names()) {
      if (target !== undefined && !name.startsWith(`${this.key(target)}.`)) continue;
      const path = join(this.root, name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const data = await this.readSnapshot(path);
      if (target !== undefined && data.target !== target) continue;
      entries.push({ backup_name: name, path, target: data.target, bytes: info.size, createdAt: data.createdAt, sha256: data.sha256 });
    }
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async readSnapshot(path: string): Promise<Snapshot> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > this.config.maxEditBytes * 2 + 4096) throw new Error('备份文件类型或大小无效');
    const data: Partial<Snapshot> = JSON.parse(await readFile(path, 'utf8'));
    if (data.format !== 1 || typeof data.target !== 'string' || typeof data.createdAt !== 'string'
        || typeof data.contentBase64 !== 'string' || typeof data.sha256 !== 'string') throw new Error('备份元数据无效');
    return data as Snapshot;
  }

  async load(target: string, name?: string): Promise<{ name: string; bytes: Buffer }> {
    if (name !== undefined && name !== '' && !OWN_NAME.test(name)) return this.loadLegacy(target, name);
    const selected = name || (await this.entries(target))[0]?.backup_name;
    if (selected === undefined) {
      const legacy = await this.legacyEntries(target);
      if (legacy[0] !== undefined) return this.loadLegacy(target, legacy[0].backup_name);
      throw new Error('没有该文件可用的备份');
    }
    if (!selected.startsWith(`${this.key(target)}.`)) throw new Error('备份不属于目标文件');
    const data = await this.readSnapshot(join(this.root, selected));
    if (data.target !== target) throw new Error('备份目标身份不匹配');
    const bytes = Buffer.from(data.contentBase64, 'base64');
    if (bytes.length > this.config.maxEditBytes || createHash('sha256').update(bytes).digest('hex') !== data.sha256) throw new Error('备份内容校验失败');
    return { name: selected, bytes };
  }

  private legacyStem(target: string): string {
    const hash = createHash('sha256').update(dirname(resolve(target)).replace(/\\/g, '/')).digest('hex').slice(0, 8);
    return `${basename(target)}.${hash}.`;
  }

  private async legacyEntries(target: string): Promise<{ backup_name: string; createdAt: string }[]> {
    if (!this.config.legacyBackupDir) return [];
    try {
      const entries = [];
      for (const name of await readdir(this.config.legacyBackupDir)) {
        if (!name.startsWith(this.legacyStem(target)) || !/\.(?:\d{8}_\d{6}_\d{6}|\d{14})(?:\.[a-z]+)?\.bak$/.test(name)) continue;
        const info = await lstat(join(this.config.legacyBackupDir, name));
        if (info.isFile() && !info.isSymbolicLink()) entries.push({ backup_name: name, createdAt: info.mtime.toISOString() });
      }
      return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async loadLegacy(target: string, name: string): Promise<{ name: string; bytes: Buffer }> {
    const entries = await this.legacyEntries(target);
    if (!entries.some(entry => entry.backup_name === name)) throw new Error('legacyBackupDir 未配置或备份归属无效');
    const path = join(this.config.legacyBackupDir, name);
    if ((await stat(path)).size > this.config.maxEditBytes) throw new Error('旧备份超过大小上限');
    return { name, bytes: await readFile(path) };
  }

  async list(target: string): Promise<Result> {
    const own = await this.entries(target);
    const old = await this.legacyEntries(target);
    return { ok: true, file: target, backups: [...own, ...old].map(entry => ({ ...entry }) as Record<string, Json>) };
  }

  /** 保留本批使用的快照；清理只处理命名空间中的自有普通文件。 */
  async prune(protectedNames: ReadonlySet<string>): Promise<void> {
    const entries = await this.entries();
    const counts = new Map<string, number>();
    const keep: BackupEntry[] = [];
    for (const entry of entries) {
      const count = counts.get(entry.target) ?? 0;
      counts.set(entry.target, count + 1);
      if (count < this.config.backupRetention || protectedNames.has(entry.backup_name)) keep.push(entry);
      else await unlink(entry.path);
    }
    let total = keep.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of keep.slice().reverse()) {
      if (total <= this.config.maxBackupBytes) break;
      if (protectedNames.has(entry.backup_name)) continue;
      await unlink(entry.path);
      total -= entry.bytes;
    }
  }
}
