import { FsError } from '@deepseek-ai/dsh-fs';
import iconv from 'iconv-lite';
import { createHash } from 'node:crypto';
/** 固定 BOM/UTF-8/GB18030/单字节降级，不对二进制执行文本编辑。 */
export function decodeSource(bytes) {
    const buffer = Buffer.from(bytes);
    let encoding = '';
    if (buffer[0] === 0xff && buffer[1] === 0xfe)
        encoding = buffer[2] === 0 && buffer[3] === 0 ? 'utf32le' : 'utf16le';
    else if (buffer[0] === 0xfe && buffer[1] === 0xff)
        encoding = 'utf16be';
    else if (buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 0xfe && buffer[3] === 0xff)
        encoding = 'utf32be';
    if (encoding)
        return { text: iconv.decode(buffer, encoding), encoding };
    if (buffer.includes(0))
        throw new FsError('文件是二进制内容，不能进行文本编辑', 'FS_NOT_TEXT');
    try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf8' };
    }
    catch {
        const gb = iconv.decode(buffer, 'gb18030');
        if (iconv.encode(gb, 'gb18030').equals(buffer))
            return { text: gb, encoding: 'gb18030' };
        return { text: iconv.decode(buffer, 'latin1'), encoding: 'latin1' };
    }
}
/** 对原字节计算恢复时的版本证据，不替代 provider 的 opaque version。 */
export function byteHash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
/** 受 rc2 文件 provider 管理的读取、观察和有版本写入。 */
export class Files {
    ctx;
    config;
    policy;
    constructor(ctx, config, policy) {
        this.ctx = ctx;
        this.config = config;
        this.policy = policy;
    }
    async resolve(path, exec) {
        return this.ctx.fs.resolve(path, { cwd: exec.agent?.session.header.cwd, signal: exec.signal });
    }
    async projectDir(exec) {
        const root = await this.ctx.fs.resolve('.', { cwd: exec.agent?.session.header.cwd, signal: exec.signal });
        return this.ctx.fs.processPath(root);
    }
    async read(target, exec, signal = exec.signal, observe = true) {
        const before = await this.ctx.fs.stat(target, signal);
        if (before?.type !== 'file')
            throw new FsError('目标文件不存在或不是普通文件', 'FS_NOT_REGULAR_FILE');
        const bytes = Buffer.from(await this.ctx.fs.readBytes(target, signal, this.config.maxEditBytes));
        const after = await this.ctx.fs.stat(target, signal);
        if (before.version !== after?.version)
            throw new FsError('文件在读取期间发生变化，请重新读取', 'FS_STALE_VERSION');
        const decoded = decodeSource(bytes);
        if (observe)
            this.ctx.emit('fs/observed', target, { kind: 'present', version: before.version }, exec);
        return { target, path: this.ctx.fs.processPath(target), version: before.version, bytes, ...decoded };
    }
    /** 先读已有观察意图，避免用工具内部读覆盖调用者早先的陈旧观察。 */
    async editSnapshot(target, exec) {
        let observed;
        try {
            observed = await this.ctx.waterfall('fs/edit-intent', target, exec, () => undefined);
        }
        catch (error) {
            if (!(error instanceof FsError) || error.code !== 'FS_NOT_OBSERVED')
                throw error;
        }
        const snapshot = await this.read(target, exec, exec.signal, false);
        if (observed !== undefined && observed.version !== snapshot.version)
            throw new FsError('文件与上次观察不一致，请重新读取', 'FS_STALE_VERSION');
        this.ctx.emit('fs/observed', target, { kind: 'present', version: snapshot.version }, exec);
        await this.ctx.waterfall('fs/edit-intent', target, exec, () => ({ version: snapshot.version }));
        return snapshot;
    }
    async write(snapshot, content, version, exec, policy, signal = exec.signal) {
        try {
            const result = await this.ctx.fs.writeText(snapshot.target, content, { kind: 'replaceIfVersion', version }, signal, policy);
            this.ctx.emit('fs/observed', snapshot.target, { kind: 'present', version: result.version }, exec);
            return result.version;
        }
        catch (error) {
            throw this.policy.mapError(error, policy);
        }
    }
}
//# sourceMappingURL=files.js.map