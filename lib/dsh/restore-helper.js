import { constants } from 'node:fs';
import { copyFile, readFile, writeFile, rename, unlink, stat, chmod, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function restoreRaw(request) {
    if (!isAbsolute(request.path) || !/^[0-9a-f]{64}$/.test(request.expectedSha256)
        || typeof request.contentBase64 !== 'string' || !Number.isInteger(request.maxBytes) || request.maxBytes < 1)
        throw new Error('无效恢复请求');
    const path = await realpath(request.path);
    if (path !== request.path)
        throw new Error('目标路径身份已变化');
    const info = await stat(path);
    if (!info.isFile() || info.size > request.maxBytes)
        throw new Error('恢复目标类型或大小无效');
    const before = await readFile(path);
    if (createHash('sha256').update(before).digest('hex') !== request.expectedSha256)
        throw new Error('恢复时目标已被其他操作修改');
    const bytes = Buffer.from(request.contentBase64, 'base64');
    if (bytes.length > request.maxBytes)
        throw new Error('恢复内容超过大小上限');
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.irmia-restore.tmp`);
    let copied = false;
    try {
        // 从现有目标复制到同目录临时文件，再改字节，避免丢掉源文件权限。
        await copyFile(path, temporary, constants.COPYFILE_EXCL);
        copied = true;
        await writeFile(temporary, bytes);
        if (process.platform !== 'win32')
            await chmod(temporary, info.mode);
        const current = await readFile(path);
        if (createHash('sha256').update(current).digest('hex') !== request.expectedSha256)
            throw new Error('文件在恢复准备期间被修改');
        await rename(temporary, path);
        copied = false;
    }
    finally {
        if (copied)
            await unlink(temporary);
    }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const chunks = [];
        for await (const chunk of process.stdin)
            chunks.push(Buffer.from(chunk));
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        await restoreRaw(request);
        process.stdout.write(JSON.stringify({ ok: true }));
    }
    catch (error) {
        process.stderr.write(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
//# sourceMappingURL=restore-helper.js.map