import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.DSBRIDGE_DATA || path.join(os.homedir(), '.dsbridge');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const AUDIT_PATH = path.join(DATA_DIR, 'audit.log');

function defaults() {
  return {
    name: 'Дипсик Мост',
    version: '0.1.0',
    port: Number(process.env.DSBRIDGE_PORT) || 8443,
    token: crypto.randomBytes(24).toString('hex'),
    workspaceRoot: process.env.DSBRIDGE_WORKSPACE || path.join(os.homedir(), 'DeepSeekWorkspace'),
    allowedOrigins: ['https://chat.deepseek.com'],
    autoOpen: true,
    // Выполнение команд (run_command, git-мутации, фоновые процессы).
    // Включено по просьбе, но это самый опасный инструмент — отключается одним флагом.
    allowCommands: true,
    // Сетевой доступ (download, http_get, http_post). Выключен по умолчанию:
    // это новая поверхность атаки — модель сможет и читать, и отправлять данные наружу.
    allowNetwork: false,
    // Дополнительные разрешённые каталоги вне рабочей папки. Пустой список —
    // поведение как раньше: всё, что вне workspace, отбивается с EPATHJAIL.
    // Нужно, чтобы модель могла помогать с уже существующими проектами.
    extraRoots: [],
  };
}

export function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let existing = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      existing = {};
    }
  }
  const cfg = { ...defaults(), ...existing };
  // Явно заданные переменные окружения перекрывают сохранённый конфиг.
  if (process.env.DSBRIDGE_PORT) cfg.port = Number(process.env.DSBRIDGE_PORT);
  if (process.env.DSBRIDGE_WORKSPACE) cfg.workspaceRoot = process.env.DSBRIDGE_WORKSPACE;
  if (!cfg.token) cfg.token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(cfg.workspaceRoot, { recursive: true });
  cfg.extraRoots = normalizeRoots(cfg.extraRoots);
  saveConfig(cfg);
  return cfg;
}

// Приводим список дополнительных каталогов к абсолютным путям без дублей.
// Несуществующие не выбрасываем: папку могут создать позже.
export function normalizeRoots(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) continue;
    let abs;
    try {
      abs = path.resolve(item.trim());
    } catch {
      continue;
    }
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

export function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}
