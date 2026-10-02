/** 只允许已有文件按当前内容哈希恢复原字节，不接受脚本或任意其他文件操作。 */
export interface RestoreRequest {
    path: string;
    expectedSha256: string;
    contentBase64: string;
    maxBytes: number;
}
export declare function restoreRaw(request: RestoreRequest): Promise<void>;
