// Ресурсы, которые лежат на диске рядом с кодом, но в собранном exe должны быть внутри него.
// Единственное место, где код знает о файлах проекта: build.mjs подменяет исходник этого
// модуля целиком (см. buildAssetsModule в build.mjs), поэтому остальные модули просто зовут
// getIndexHtml() / screenshotScriptPath() и не думают о режиме запуска.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STANDALONE = false;

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function getIndexHtml() {
  return fs.readFileSync(path.join(HERE, '..', 'public', 'index.html'), 'utf8');
}

// screenshot.ps1 запускается как файл (`& script.ps1`), поэтому нужен путь на диске,
// а не содержимое: в exe-режиме копия распаковывается во временную папку.
export function screenshotScriptPath() {
  return path.join(HERE, '..', 'scripts', 'screenshot.ps1');
}
