import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const grammarRoot = dirname(require.resolve('tree-sitter-wasms/package.json'));
const languages = ['python', 'javascript', 'typescript', 'tsx', 'go', 'rust', 'java', 'c', 'cpp', 'php', 'bash'];
const manifest = { grammarPackage: 'tree-sitter-wasms@0.1.13', runtime: 'web-tree-sitter@0.20.8', files: {} };
await mkdir(resolve(root, 'assets/grammars'), { recursive: true });
await mkdir(resolve(root, 'assets/runtime'), { recursive: true });
for (const language of languages) {
  const name = `tree-sitter-${language}.wasm`;
  const target = resolve(root, 'assets/grammars', name);
  await copyFile(resolve(grammarRoot, 'out', name), target);
  const bytes = await readFile(target);
  manifest.files[`grammars/${name}`] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
const runtime = require.resolve('web-tree-sitter/tree-sitter.wasm');
await copyFile(runtime, resolve(root, 'assets/runtime/web-tree-sitter.wasm'));
const bytes = await readFile(runtime);
manifest.files['runtime/web-tree-sitter.wasm'] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
await writeFile(resolve(root, 'assets/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`已复制 ${languages.length} 个固定 grammar 与 runtime WASM，SHA256 清单已生成。`);

