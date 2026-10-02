import type { Settings } from '../config.js';
import type { Result } from '../protocol.js';
interface BackupEntry {
    backup_name: string;
    path: string;
    target: string;
    bytes: number;
    createdAt: string;
    sha256: string;
}
/** 原始字节快照只写入操作者拥有的专属状态目录。 */
export declare class BackupStore {
    private readonly config;
    readonly root: string;
    constructor(config: Settings);
    key(target: string): string;
    assertOutsideProject(projectDir: string, target: string): void;
    save(target: string, bytes: Uint8Array): Promise<string>;
    private names;
    entries(target?: string): Promise<BackupEntry[]>;
    private readSnapshot;
    load(target: string, name?: string): Promise<{
        name: string;
        bytes: Buffer;
    }>;
    private legacyStem;
    private legacyEntries;
    private loadLegacy;
    list(target: string): Promise<Result>;
    /** 保留本批使用的快照；清理只处理命名空间中的自有普通文件。 */
    prune(protectedNames: ReadonlySet<string>): Promise<void>;
}
export {};
