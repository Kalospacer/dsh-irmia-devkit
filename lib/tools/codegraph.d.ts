import type { Context } from '@deepseek-ai/cordis';
import type { CodeGraphService } from '../codegraph/service.js';
/** 保留 MCP 合并的 code_status→code_index(status=true) 形态。 */
export declare function registerCodeGraphTools(ctx: Context, service: CodeGraphService): void;
