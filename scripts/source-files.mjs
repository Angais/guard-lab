import fs from 'node:fs/promises';
import path from 'node:path';
export const ROOT_FILES = [
  '.editorconfig',
  '.prettierignore',
  '.prettierrc.json',
  '.gitattributes',
  '.gitignore',
  'AGENTS.md',
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'THIRD_PARTY.md',
  'electron-builder.config.cjs',
  'index.html',
  'package.json',
  'package-lock.json',
  'vite.config.js',
];
const roots = {
  src: ['.jsx', '.mjs', '.css'],
  tests: ['.mjs'],
  scripts: ['.mjs', '.cjs'],
  shared: ['.cjs', '.mjs'],
  electron: ['.cjs'],
  docs: ['.md', '.svg', '.json', '.png', '.jpg'],
  public: ['.svg', '.png'],
  '.github': ['.yml', '.md'],
  // electron-builder build resources (macOS entitlements).
  build: ['.plist'],
};
export async function sourceFiles(root) {
  const files = [...ROOT_FILES];
  async function walk(relative, extensions) {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Symlinks are excluded from source releases.');
      const file = relative + '/' + entry.name;
      if (entry.name.startsWith('.') && relative !== '.github')
        throw new Error('Unexpected hidden source entry: ' + file);
      if (entry.isDirectory()) await walk(file, extensions);
      else if (extensions.includes(path.extname(file))) files.push(file);
      else throw new Error('Unexpected source file: ' + file);
    }
  }
  for (const [relative, extensions] of Object.entries(roots)) await walk(relative, extensions);
  for (const file of files) {
    const stat = await fs.lstat(path.join(root, file));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Not a regular source file: ' + file);
  }
  return files.sort();
}
