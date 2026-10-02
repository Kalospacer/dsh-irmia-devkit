import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.js';
import type { Settings } from './config.js';
export { Config };
/** Cordis 诊断名，保留既有插件行身份。 */
export declare const name = "tool-irmia-devkit";
/** 文件、工具及提示均使用宿主的实际服务。 */
export declare const inject: string[];
/** 资源先停止事务恢复，再释放计算与进程；注册项由 Cordis effect 管理。 */
export declare function apply(ctx: Context, raw: Settings): void;
