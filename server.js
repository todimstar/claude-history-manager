const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.CHM_PORT || 3456;
const HOST = process.env.CHM_HOST || '0.0.0.0';

// ─── Claude 数据目录（支持环境变量覆盖）─────────────────────
const CLAUDE_DIR = process.env.CHM_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const FILE_HISTORY_DIR = path.join(CLAUDE_DIR, 'file-history');
const DEBUG_DIR = path.join(CLAUDE_DIR, 'debug');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const TRASH_DIR = path.join(CLAUDE_DIR, 'trash');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── 安全校验 ────────────────────────────────────────────────

/** 校验 session ID 必须是 UUID 格式，防止路径遍历 */
function validateSessionId(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('非法的 Session ID 格式');
  }
  return id;
}

/** 校验项目目录名只含安全字符 */
function validateProjectName(name) {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error('非法的项目名格式');
  }
  return name;
}

/** 确保解析后的路径在 CLAUDE_DIR 内，防止路径穿越 */
function safePath(...segments) {
  const resolved = path.resolve(path.join(...segments));
  if (!resolved.startsWith(path.resolve(CLAUDE_DIR))) {
    throw new Error('路径越界：禁止访问 .claude 目录之外的文件');
  }
  return resolved;
}

// ─── 工具函数 ───────────────────────────────────────────────

const SYSTEM_TAG_RE = /<(ide_opened_file|ide_selection|system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-caveat)[^>]*>[\s\S]*?<\/\1>/g;

function cleanUserText(text) {
  if (!text) return null;
  const cleaned = text.replace(SYSTEM_TAG_RE, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

function getDirSize(dirPath) {
  let totalSize = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        totalSize += fs.statSync(fullPath).size;
      } else if (entry.isDirectory()) {
        totalSize += getDirSize(fullPath);
      }
    }
  } catch { /* 目录不存在返回 0 */ }
  return totalSize;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/** 不应展示的内部消息类型 */
const SKIP_TYPES = new Set(['progress', 'queue-operation', 'file-history-snapshot']);
function isDisplayable(msg) {
  return !SKIP_TYPES.has(msg.type);
}

/** 从 JSONL 逐行读取，支持过滤和限制 */
async function readJsonl(filePath, opts = {}) {
  const messages = [];
  if (!fs.existsSync(filePath)) return messages;
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (opts.filterDisplayable && !isDisplayable(obj)) continue;
      if (opts.summaryOnly) {
        messages.push(extractSummary(obj));
      } else {
        messages.push(obj);
      }
      count++;
      if (opts.limit && count >= opts.limit) break;
    } catch { /* 跳过解析失败的行 */ }
  }
  return messages;
}

function extractSummary(msg) {
  const summary = { type: msg.type, timestamp: msg.timestamp };
  if (msg.type === 'user' && msg.message) {
    const content = msg.message.content;
    if (typeof content === 'string') {
      summary.preview = content.slice(0, 200);
    } else if (Array.isArray(content)) {
      const textPart = content.find(p => p.type === 'text');
      if (textPart) summary.preview = textPart.text.slice(0, 200);
      const toolResult = content.find(p => p.type === 'tool_result');
      if (toolResult) summary.preview = '[工具结果]';
    }
  } else if (msg.type === 'assistant' && msg.message) {
    const content = msg.message.content;
    if (Array.isArray(content)) {
      const textPart = content.find(p => p.type === 'text');
      if (textPart) summary.preview = textPart.text.slice(0, 200);
      const toolUse = content.find(p => p.type === 'tool_use');
      if (toolUse && !textPart) summary.preview = `[调用工具: ${toolUse.name}]`;
    }
  } else if (msg.type === 'system') {
    summary.preview = msg.content ? msg.content.slice(0, 100) : '[系统消息]';
  }
  return summary;
}

/** 从会话 JSONL 提取元信息 */
async function getSessionMeta(filePath) {
  let firstUserMsg = null;
  let lastTimestamp = null;
  let messageCount = 0;
  let sessionId = null;
  let gitBranch = null;
  let version = null;

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      // 跳过非展示型消息，不计入 messageCount
      if (!isDisplayable(obj)) continue;

      messageCount++;
      if (obj.timestamp) lastTimestamp = obj.timestamp;
      if (obj.sessionId && !sessionId) sessionId = obj.sessionId;
      if (obj.gitBranch && !gitBranch) gitBranch = obj.gitBranch;
      if (obj.version && !version) version = obj.version;

      if (!firstUserMsg && obj.type === 'user' && obj.message) {
        const content = obj.message.content;
        const cleaned = cleanUserText(typeof content === 'string' ? content : null);
        if (cleaned) {
          firstUserMsg = cleaned.slice(0, 200);
        } else if (Array.isArray(content)) {
          const textPart = content.find(p =>
            p.type === 'text' &&
            !p.text.includes('[Request interrupted') &&
            cleanUserText(p.text)
          );
          if (textPart) firstUserMsg = cleanUserText(textPart.text).slice(0, 200);
        }
      }
    } catch { /* 跳过 */ }
  }

  const stat = fs.statSync(filePath);
  return {
    sessionId: sessionId || path.basename(filePath, '.jsonl'),
    firstUserMsg: firstUserMsg || '[无用户消息]',
    messageCount,
    fileSize: stat.size,
    fileSizeFormatted: formatBytes(stat.size),
    lastModified: stat.mtime.toISOString(),
    lastTimestamp,
    gitBranch,
    version
  };
}

/** Claude Code 目录编码：将真实路径编码为目录名（用于与 history.jsonl 匹配） */
function encodeProjectPath(realPath) {
  return realPath
    .replace(/[\\\/]+$/, '')
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):\//, (_, letter) => letter.toLowerCase() + '--')
    .replace(/\//g, '-');
}

/** 从 history.jsonl 构建 encodedDirName → realPath 映射（无损） */
function buildProjectPathMap() {
  const map = new Map();
  try {
    if (!fs.existsSync(HISTORY_FILE)) return map;
    const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.project) {
          const encoded = encodeProjectPath(obj.project);
          if (!map.has(encoded)) map.set(encoded, obj.project);
        }
      } catch {}
    }
  } catch {}
  return map;
}

/** 从项目 JSONL 中提取 cwd（遍历多个文件，每个最多读前 30 行） */
async function extractCwdFromJsonl(projectDir) {
  try {
    const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files.slice(0, 3)) {
      const stream = fs.createReadStream(path.join(projectDir, file), { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let lineCount = 0;
      for await (const line of rl) {
        if (!line.trim()) continue;
        if (++lineCount > 30) break;
        try {
          const obj = JSON.parse(line);
          if (obj.cwd) { rl.close(); stream.destroy(); return obj.cwd; }
        } catch {}
      }
      rl.close();
      stream.destroy();
    }
  } catch {}
  return null;
}

/**
 * 智能路径解码：通过文件系统验证，逐级匹配实际存在的目录，解决连字符歧义
 * 例：c--ep-code-frontend-claude-history-manager
 *   → 逐级验证 C:\ep → C:\ep\code → C:\ep\code\frontend → C:\ep\code\frontend\claude-history-manager ✓
 */
function smartDecodePath(encodedName) {
  const driveMatch = encodedName.match(/^([a-z])--(.+)$/);
  if (!driveMatch) return null;
  const basePath = driveMatch[1].toUpperCase() + ':\\';
  const segments = driveMatch[2].split('-');
  if (!segments.length) return null;

  function resolve(dir, startIdx) {
    if (startIdx >= segments.length) return dir;
    // 从最长候选开始尝试（优先保留连字符）
    for (let endIdx = segments.length; endIdx > startIdx; endIdx--) {
      const candidate = segments.slice(startIdx, endIdx).join('-');
      const candidatePath = path.join(dir, candidate);
      try {
        if (!fs.existsSync(candidatePath)) continue;
        if (endIdx === segments.length) return candidatePath; // 已消费全部片段
        if (fs.statSync(candidatePath).isDirectory()) {
          const result = resolve(candidatePath, endIdx);
          if (result) return result;
        }
      } catch {}
    }
    return null;
  }

  return resolve(basePath, 0);
}

/** 获取项目显示名（真实路径）— 优先级：history.jsonl > JSONL cwd > 文件系统验证 > 正则解码（有损） */
async function getProjectDisplayName(projectDir, encodedName, pathMap) {
  if (pathMap && pathMap.has(encodedName)) return { displayName: pathMap.get(encodedName), isFallback: false };
  const cwd = await extractCwdFromJsonl(projectDir);
  if (cwd) return { displayName: cwd, isFallback: false };
  // 尝试文件系统智能解析
  const smartResult = smartDecodePath(encodedName);
  if (smartResult) return { displayName: smartResult, isFallback: false };
  // 最终兜底：纯正则（有损，可能不准确）
  return { displayName: encodedName.replace(/--/g, ':\\').replace(/-/g, '\\'), isFallback: true };
}

// ─── history.jsonl 同步 ─────────────────────────────────────

/** 从 history.jsonl 移除指定 sessionId 的条目，返回被移除的原始行 */
function removeFromHistoryJsonl(sessionId) {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
  const lines = raw.split('\n');
  const removed = [];
  const kept = [];

  for (const line of lines) {
    if (!line.trim()) { kept.push(line); continue; }
    try {
      const obj = JSON.parse(line);
      if (obj.sessionId === sessionId) {
        removed.push(line);
      } else {
        kept.push(line);
      }
    } catch {
      kept.push(line); // 保留无法解析的行
    }
  }

  // 原子写：先写临时文件再重命名
  const tmpFile = HISTORY_FILE + '.tmp';
  fs.writeFileSync(tmpFile, kept.join('\n'), 'utf-8');
  fs.renameSync(tmpFile, HISTORY_FILE);
  return removed;
}

/** 恢复 history.jsonl 条目 */
function restoreToHistoryJsonl(lines) {
  if (!lines || lines.length === 0) return;
  fs.appendFileSync(HISTORY_FILE, '\n' + lines.join('\n'), 'utf-8');
}

// ─── 回收站操作 ──────────────────────────────────────────────

/** 将会话移入回收站（软删除） */
function softDeleteSession(project, sessionId) {
  validateProjectName(project);
  validateSessionId(sessionId);

  const trashSessionDir = safePath(TRASH_DIR, sessionId);
  ensureDir(trashSessionDir);

  const moved = [];
  let totalSize = 0;

  // 1) 对话 JSONL
  const jsonlPath = safePath(PROJECTS_DIR, project, sessionId + '.jsonl');
  if (fs.existsSync(jsonlPath)) {
    totalSize += fs.statSync(jsonlPath).size;
    fs.renameSync(jsonlPath, path.join(trashSessionDir, 'conversation.jsonl'));
    moved.push('conversation');
  }

  // 2) 子代理目录
  const subagentDir = safePath(PROJECTS_DIR, project, sessionId);
  if (fs.existsSync(subagentDir) && fs.statSync(subagentDir).isDirectory()) {
    totalSize += getDirSize(subagentDir);
    fs.renameSync(subagentDir, path.join(trashSessionDir, 'subagents'));
    moved.push('subagents');
  }

  // 3) 调试日志
  const debugPath = safePath(DEBUG_DIR, sessionId + '.txt');
  if (fs.existsSync(debugPath)) {
    totalSize += fs.statSync(debugPath).size;
    fs.renameSync(debugPath, path.join(trashSessionDir, 'debug.txt'));
    moved.push('debug');
  }

  // 4) 文件版本历史
  const fhDir = safePath(FILE_HISTORY_DIR, sessionId);
  if (fs.existsSync(fhDir) && fs.statSync(fhDir).isDirectory()) {
    totalSize += getDirSize(fhDir);
    fs.renameSync(fhDir, path.join(trashSessionDir, 'file-history'));
    moved.push('file-history');
  }

  // 5) 从 history.jsonl 移除条目
  const removedHistoryLines = removeFromHistoryJsonl(sessionId);

  // 6) 写入元数据
  const meta = {
    sessionId,
    project,
    deletedAt: new Date().toISOString(),
    movedItems: moved,
    totalSize,
    removedHistoryLines
  };
  fs.writeFileSync(path.join(trashSessionDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

  return { sessionId, moved, totalSize };
}

/** 从回收站恢复会话（兼容普通会话和孤立文件） */
function restoreSession(sessionId) {
  validateSessionId(sessionId);
  const trashSessionDir = safePath(TRASH_DIR, sessionId);
  if (!fs.existsSync(trashSessionDir)) throw new Error('回收站中不存在此会话');

  const metaPath = path.join(trashSessionDir, 'meta.json');
  if (!fs.existsSync(metaPath)) throw new Error('缺少元数据，无法恢复');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

  const project = meta.project; // 孤立文件时为 null
  const isOrphan = !project;
  const restored = [];

  // 有项目关联时，恢复对话和子代理
  if (project) {
    ensureDir(safePath(PROJECTS_DIR, project));

    // 1) 恢复对话
    const convSrc = path.join(trashSessionDir, 'conversation.jsonl');
    if (fs.existsSync(convSrc)) {
      const dest = safePath(PROJECTS_DIR, project, sessionId + '.jsonl');
      if (fs.existsSync(dest)) throw new Error('目标位置已存在同名会话，恢复中止');
      fs.renameSync(convSrc, dest);
      restored.push('conversation');
    }

    // 2) 恢复子代理
    const subSrc = path.join(trashSessionDir, 'subagents');
    if (fs.existsSync(subSrc)) {
      fs.renameSync(subSrc, safePath(PROJECTS_DIR, project, sessionId));
      restored.push('subagents');
    }
  }

  // 3) 恢复调试日志（普通会话和孤立文件都可能有）
  const debugSrc = path.join(trashSessionDir, 'debug.txt');
  if (fs.existsSync(debugSrc)) {
    ensureDir(DEBUG_DIR);
    const dest = safePath(DEBUG_DIR, sessionId + '.txt');
    if (fs.existsSync(dest)) throw new Error('调试日志目标位置已存在同名文件，恢复中止');
    fs.renameSync(debugSrc, dest);
    restored.push('debug');
  }

  // 4) 恢复文件历史（普通会话和孤立文件都可能有）
  const fhSrc = path.join(trashSessionDir, 'file-history');
  if (fs.existsSync(fhSrc)) {
    ensureDir(FILE_HISTORY_DIR);
    const dest = safePath(FILE_HISTORY_DIR, sessionId);
    if (fs.existsSync(dest)) throw new Error('文件历史目标位置已存在同名目录，恢复中止');
    fs.renameSync(fhSrc, dest);
    restored.push('file-history');
  }

  // 5) 恢复 history.jsonl 条目（仅普通会话）
  if (!isOrphan && meta.removedHistoryLines && meta.removedHistoryLines.length > 0) {
    restoreToHistoryJsonl(meta.removedHistoryLines);
    restored.push('history-index');
  }

  // 6) 清理回收站目录
  fs.rmSync(trashSessionDir, { recursive: true });

  return { sessionId, project: project || '(孤立文件)', restored };
}

/** 将孤立文件移入回收站（软删除） */
function softDeleteOrphan(type, sessionId) {
  validateSessionId(sessionId);
  const trashSessionDir = safePath(TRASH_DIR, sessionId);

  // 如果回收站已有同 sessionId 的条目（极端场景：会话被删但孤立文件还在）
  // 则合并进去；否则新建
  const metaPath = path.join(trashSessionDir, 'meta.json');
  let existingMeta = null;
  if (fs.existsSync(metaPath)) {
    existingMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  }

  ensureDir(trashSessionDir);
  const moved = existingMeta ? [...(existingMeta.movedItems || [])] : [];
  let totalSize = existingMeta ? (existingMeta.totalSize || 0) : 0;

  if (type === 'debug') {
    const debugPath = safePath(DEBUG_DIR, sessionId + '.txt');
    if (!fs.existsSync(debugPath)) throw new Error('文件不存在');
    const size = fs.statSync(debugPath).size;
    totalSize += size;
    fs.renameSync(debugPath, path.join(trashSessionDir, 'debug.txt'));
    if (!moved.includes('debug')) moved.push('debug');
  } else if (type === 'file-history') {
    const fhDir = safePath(FILE_HISTORY_DIR, sessionId);
    if (!fs.existsSync(fhDir)) throw new Error('目录不存在');
    const size = getDirSize(fhDir);
    totalSize += size;
    fs.renameSync(fhDir, path.join(trashSessionDir, 'file-history'));
    if (!moved.includes('file-history')) moved.push('file-history');
  }

  // 写/更新 meta.json
  const meta = existingMeta ? {
    ...existingMeta,
    movedItems: moved,
    totalSize,
    lastOrphanCleanup: new Date().toISOString()
  } : {
    sessionId,
    project: null,
    type: `orphan-${type}`,
    deletedAt: new Date().toISOString(),
    movedItems: moved,
    totalSize,
    removedHistoryLines: []
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

  return { sessionId, moved, totalSize, sizeFormatted: formatBytes(totalSize) };
}

// ─── API 路由 ───────────────────────────────────────────────

/** GET /api/projects — 列出所有项目 */
app.get('/api/projects', async (req, res) => {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return res.json([]);
    const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    const pathMap = buildProjectPathMap();
    const projects = [];
    for (const e of entries.filter(e => e.isDirectory())) {
      const dirPath = path.join(PROJECTS_DIR, e.name);
      const jsonlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
      const size = getDirSize(dirPath);
      const { displayName, isFallback } = await getProjectDisplayName(dirPath, e.name, pathMap);
      projects.push({
        name: e.name,
        displayName,
        isFallback,
        sessionCount: jsonlFiles.length,
        size,
        sizeFormatted: formatBytes(size)
      });
    }
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/sessions?project=xxx */
app.get('/api/sessions', async (req, res) => {
  try {
    const project = validateProjectName(req.query.project || '');
    const projectDir = safePath(PROJECTS_DIR, project);
    if (!fs.existsSync(projectDir)) return res.json([]);

    const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    const dirs = fs.readdirSync(projectDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
    const subagentSessions = new Set(dirs);

    const sessions = [];
    for (const file of files) {
      const filePath = path.join(projectDir, file);
      const meta = await getSessionMeta(filePath);
      meta.hasSubagents = subagentSessions.has(meta.sessionId);
      meta.hasDebugLog = fs.existsSync(path.join(DEBUG_DIR, meta.sessionId + '.txt'));
      meta.hasFileHistory = fs.existsSync(path.join(FILE_HISTORY_DIR, meta.sessionId));
      // 关联文件真实路径（让用户眼见为实）
      meta.files = {
        conversation: filePath,
        subagents: meta.hasSubagents ? path.join(projectDir, meta.sessionId) : null,
        debug: meta.hasDebugLog ? path.join(DEBUG_DIR, meta.sessionId + '.txt') : null,
        fileHistory: meta.hasFileHistory ? path.join(FILE_HISTORY_DIR, meta.sessionId) : null
      };
      sessions.push(meta);
    }

    sessions.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/session/:id?project=xxx */
app.get('/api/session/:id', async (req, res) => {
  try {
    const id = validateSessionId(req.params.id);
    const project = validateProjectName(req.query.project || '');
    const filePath = safePath(PROJECTS_DIR, project, id + '.jsonl');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '会话不存在' });

    const messages = await readJsonl(filePath, { filterDisplayable: true });
    // 返回关联文件路径
    const sid = id;
    const files = {
      conversation: filePath,
      subagents: fs.existsSync(safePath(PROJECTS_DIR, project, sid)) ? safePath(PROJECTS_DIR, project, sid) : null,
      debug: fs.existsSync(safePath(DEBUG_DIR, sid + '.txt')) ? safePath(DEBUG_DIR, sid + '.txt') : null,
      fileHistory: fs.existsSync(safePath(FILE_HISTORY_DIR, sid)) ? safePath(FILE_HISTORY_DIR, sid) : null
    };
    res.json({ sessionId: id, project, messageCount: messages.length, messages, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/session/:id?project=xxx — 软删除（移至回收站） */
app.delete('/api/session/:id', (req, res) => {
  try {
    const id = validateSessionId(req.params.id);
    const project = validateProjectName(req.query.project || '');
    const result = softDeleteSession(project, id);
    res.json({ success: true, ...result, message: '已移至回收站，可随时恢复' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/sessions/batch-delete — 批量软删除 */
app.post('/api/sessions/batch-delete', (req, res) => {
  try {
    const { project, sessionIds } = req.body;
    if (!project || !Array.isArray(sessionIds)) {
      return res.status(400).json({ error: 'project 和 sessionIds[] 必填' });
    }
    validateProjectName(project);
    const results = [];
    for (const id of sessionIds) {
      try {
        results.push(softDeleteSession(project, id));
      } catch (err) {
        results.push({ sessionId: id, error: err.message });
      }
    }
    res.json({ success: true, results, message: `${results.length} 个会话已移至回收站` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/stats */
app.get('/api/stats', (req, res) => {
  try {
    const historySize = fs.existsSync(HISTORY_FILE) ? fs.statSync(HISTORY_FILE).size : 0;
    const projectsSize = getDirSize(PROJECTS_DIR);
    const debugSize = getDirSize(DEBUG_DIR);
    const fileHistorySize = getDirSize(FILE_HISTORY_DIR);
    const trashSize = getDirSize(TRASH_DIR);
    const totalSize = historySize + projectsSize + debugSize + fileHistorySize + trashSize;

    const debugFiles = fs.existsSync(DEBUG_DIR) ? fs.readdirSync(DEBUG_DIR).length : 0;
    const fileHistoryDirs = fs.existsSync(FILE_HISTORY_DIR)
      ? fs.readdirSync(FILE_HISTORY_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).length : 0;
    const trashCount = fs.existsSync(TRASH_DIR)
      ? fs.readdirSync(TRASH_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).length : 0;

    res.json({
      total: { size: totalSize, formatted: formatBytes(totalSize) },
      breakdown: [
        { name: '对话数据 (projects)', size: projectsSize, formatted: formatBytes(projectsSize), color: '#7c6ef6' },
        { name: '调试日志 (debug)', size: debugSize, formatted: formatBytes(debugSize), count: debugFiles, color: '#f59e0b' },
        { name: '文件历史 (file-history)', size: fileHistorySize, formatted: formatBytes(fileHistorySize), count: fileHistoryDirs, color: '#10b981' },
        { name: '对话索引 (history.jsonl)', size: historySize, formatted: formatBytes(historySize), color: '#6b7280' },
        { name: '回收站 (trash)', size: trashSize, formatted: formatBytes(trashSize), count: trashCount, color: '#f7768e' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/search?q=keyword&project=xxx */
app.get('/api/search', async (req, res) => {
  try {
    const keyword = (req.query.q || '').toLowerCase();
    const projectFilter = req.query.project;
    if (!keyword) return res.status(400).json({ error: '搜索关键词不能为空' });

    const results = [];
    let projectDirs;
    if (projectFilter) {
      validateProjectName(projectFilter);
      projectDirs = [projectFilter];
    } else {
      projectDirs = fs.existsSync(PROJECTS_DIR)
        ? fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
        : [];
    }

    for (const projName of projectDirs) {
      const projDir = path.join(PROJECTS_DIR, projName);
      const files = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = path.join(projDir, file);
        const sessionId = path.basename(file, '.jsonl');
        const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let matched = false;
        let matchPreview = '';

        for await (const line of rl) {
          if (line.toLowerCase().includes(keyword)) {
            matched = true;
            try {
              const obj = JSON.parse(line);
              if (obj.type === 'user' && obj.message) {
                const content = typeof obj.message.content === 'string'
                  ? obj.message.content : JSON.stringify(obj.message.content);
                if (content.toLowerCase().includes(keyword)) matchPreview = content.slice(0, 300);
              } else if (obj.type === 'assistant' && obj.message?.content) {
                const textParts = Array.isArray(obj.message.content)
                  ? obj.message.content.filter(p => p.type === 'text').map(p => p.text).join(' ') : '';
                if (textParts.toLowerCase().includes(keyword)) matchPreview = textParts.slice(0, 300);
              }
            } catch {}
            if (matchPreview) break;
          }
        }

        if (matched) {
          results.push({ project: projName, sessionId, preview: matchPreview || `[包含 "${keyword}"]`, filePath: file });
        }
        if (results.length >= 50) break;
      }
      if (results.length >= 50) break;
    }

    res.json({ keyword, count: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 收集所有项目中的活跃 session ID */
function collectActiveSessions() {
  const active = new Set();
  if (fs.existsSync(PROJECTS_DIR)) {
    for (const proj of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(e => e.isDirectory())) {
      fs.readdirSync(path.join(PROJECTS_DIR, proj.name))
        .filter(f => f.endsWith('.jsonl'))
        .forEach(f => active.add(path.basename(f, '.jsonl')));
    }
  }
  return active;
}

/** GET /api/orphans/debug — 列出孤立的 debug 日志（不删除） */
app.get('/api/orphans/debug', (req, res) => {
  try {
    if (!fs.existsSync(DEBUG_DIR)) return res.json({ items: [], totalSize: 0, totalFormatted: '0 B' });
    const activeSessions = collectActiveSessions();
    const debugFiles = fs.readdirSync(DEBUG_DIR).filter(f => f.endsWith('.txt'));
    const items = [];
    let totalSize = 0;
    for (const file of debugFiles) {
      const sid = path.basename(file, '.txt');
      if (!activeSessions.has(sid)) {
        const fullPath = path.join(DEBUG_DIR, file);
        const stat = fs.statSync(fullPath);
        totalSize += stat.size;
        items.push({
          sessionId: sid,
          fileName: file,
          filePath: fullPath,
          size: stat.size,
          sizeFormatted: formatBytes(stat.size),
          lastModified: stat.mtime.toISOString()
        });
      }
    }
    items.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    res.json({ items, totalSize, totalFormatted: formatBytes(totalSize) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/orphans/file-history — 列出孤立的文件历史目录（不删除） */
app.get('/api/orphans/file-history', (req, res) => {
  try {
    if (!fs.existsSync(FILE_HISTORY_DIR)) return res.json({ items: [], totalSize: 0, totalFormatted: '0 B' });
    const activeSessions = collectActiveSessions();
    const fhDirs = fs.readdirSync(FILE_HISTORY_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
    const items = [];
    let totalSize = 0;
    for (const dir of fhDirs) {
      if (!activeSessions.has(dir.name)) {
        const fullPath = path.join(FILE_HISTORY_DIR, dir.name);
        const size = getDirSize(fullPath);
        const stat = fs.statSync(fullPath);
        const fileCount = fs.readdirSync(fullPath).length;
        totalSize += size;
        items.push({
          sessionId: dir.name,
          dirPath: fullPath,
          size,
          sizeFormatted: formatBytes(size),
          fileCount,
          lastModified: stat.mtime.toISOString()
        });
      }
    }
    items.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    res.json({ items, totalSize, totalFormatted: formatBytes(totalSize) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/orphans/debug/:sid — 将孤立 debug 日志移至回收站 */
app.delete('/api/orphans/debug/:sid', (req, res) => {
  try {
    const sid = validateSessionId(req.params.sid);
    const result = softDeleteOrphan('debug', sid);
    res.json({ success: true, ...result, message: '已移至回收站，可随时恢复' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/orphans/file-history/:sid — 将孤立文件历史移至回收站 */
app.delete('/api/orphans/file-history/:sid', (req, res) => {
  try {
    const sid = validateSessionId(req.params.sid);
    const result = softDeleteOrphan('file-history', sid);
    res.json({ success: true, ...result, message: '已移至回收站，可随时恢复' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/cleanup/debug — 批量清理孤立 debug 日志（移至回收站） */
app.post('/api/cleanup/debug', (req, res) => {
  try {
    if (!fs.existsSync(DEBUG_DIR)) return res.json({ cleaned: 0, freedBytes: 0, freedFormatted: '0 B' });
    const activeSessions = collectActiveSessions();
    const debugFiles = fs.readdirSync(DEBUG_DIR).filter(f => f.endsWith('.txt'));
    const cleaned = [];
    let freedBytes = 0;
    for (const file of debugFiles) {
      const sid = path.basename(file, '.txt');
      if (!activeSessions.has(sid)) {
        try {
          const result = softDeleteOrphan('debug', sid);
          freedBytes += result.totalSize;
          cleaned.push(sid);
        } catch { /* 跳过单个失败项 */ }
      }
    }
    res.json({ cleaned: cleaned.length, freedBytes, freedFormatted: formatBytes(freedBytes), message: '已移至回收站' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/cleanup/file-history — 批量清理孤立文件历史（移至回收站） */
app.post('/api/cleanup/file-history', (req, res) => {
  try {
    if (!fs.existsSync(FILE_HISTORY_DIR)) return res.json({ cleaned: 0, freedBytes: 0, freedFormatted: '0 B' });
    const activeSessions = collectActiveSessions();
    const fhDirs = fs.readdirSync(FILE_HISTORY_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
    const cleaned = [];
    let freedBytes = 0;
    for (const dir of fhDirs) {
      if (!activeSessions.has(dir.name)) {
        try {
          const result = softDeleteOrphan('file-history', dir.name);
          freedBytes += result.totalSize;
          cleaned.push(dir.name);
        } catch { /* 跳过单个失败项 */ }
      }
    }
    res.json({ cleaned: cleaned.length, freedBytes, freedFormatted: formatBytes(freedBytes), message: '已移至回收站' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 设置 API ────────────────────────────────────────────────

/** GET /api/settings */
app.get('/api/settings', (req, res) => {
  try {
    let settings = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    }
    res.json({
      cleanupPeriodDays: settings.cleanupPeriodDays ?? 30,
      settingsFilePath: SETTINGS_FILE
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PUT /api/settings */
app.put('/api/settings', (req, res) => {
  try {
    const { cleanupPeriodDays } = req.body;
    if (typeof cleanupPeriodDays !== 'number' || cleanupPeriodDays < 1) {
      return res.status(400).json({ error: 'cleanupPeriodDays 必须为正整数' });
    }
    let settings = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    }
    settings.cleanupPeriodDays = cleanupPeriodDays;
    // 原子写
    const tmpPath = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf-8');
    fs.renameSync(tmpPath, SETTINGS_FILE);
    res.json({ success: true, cleanupPeriodDays });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 文件管理器打开 ─────────────────────────────────────────

/** POST /api/open-path — 在系统文件管理器中打开文件/目录 */
app.post('/api/open-path', (req, res) => {
  try {
    const { filePath: requestedPath } = req.body;
    if (!requestedPath) return res.status(400).json({ error: 'filePath 必填' });

    const resolved = path.resolve(requestedPath);
    if (!resolved.startsWith(path.resolve(CLAUDE_DIR))) {
      return res.status(403).json({ error: '只能打开 .claude 目录内的文件' });
    }
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: '路径不存在: ' + resolved });
    }

    const isDir = fs.statSync(resolved).isDirectory();
    if (process.platform === 'win32') {
      exec(isDir ? `explorer "${resolved}"` : `explorer /select,"${resolved}"`);
    } else if (process.platform === 'darwin') {
      exec(isDir ? `open "${resolved}"` : `open -R "${resolved}"`);
    } else {
      exec(`xdg-open "${isDir ? resolved : path.dirname(resolved)}"`);
    }

    res.json({ success: true, path: resolved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 回收站 API ──────────────────────────────────────────────

/** GET /api/trash — 列出回收站 */
app.get('/api/trash', (req, res) => {
  try {
    if (!fs.existsSync(TRASH_DIR)) return res.json({ items: [], totalSize: 0, totalFormatted: '0 B' });
    const dirs = fs.readdirSync(TRASH_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
    const items = [];
    let totalSize = 0;
    for (const dir of dirs) {
      const metaPath = path.join(TRASH_DIR, dir.name, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        const dirSize = getDirSize(path.join(TRASH_DIR, dir.name));
        totalSize += dirSize;

        // 尝试读取首条用户消息作为预览
        let preview = '[无预览]';
        const convPath = path.join(TRASH_DIR, dir.name, 'conversation.jsonl');
        if (fs.existsSync(convPath)) {
          const lines = fs.readFileSync(convPath, 'utf-8').split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.type === 'user' && obj.message) {
                const c = obj.message.content;
                const text = typeof c === 'string' ? c : (Array.isArray(c) ? (c.find(p => p.type === 'text')?.text || '') : '');
                const cleaned = cleanUserText(text);
                if (cleaned) { preview = cleaned.slice(0, 150); break; }
              }
            } catch {}
          }
        }

        items.push({
          sessionId: meta.sessionId,
          project: meta.project,
          deletedAt: meta.deletedAt,
          movedItems: meta.movedItems,
          size: dirSize,
          sizeFormatted: formatBytes(dirSize),
          preview
        });
      } catch {}
    }
    items.sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
    res.json({ items, totalSize, totalFormatted: formatBytes(totalSize) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/trash/:id/restore — 从回收站恢复 */
app.post('/api/trash/:id/restore', (req, res) => {
  try {
    const result = restoreSession(req.params.id);
    res.json({ success: true, ...result, message: '会话已恢复到原位置' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/trash/:id — 彻底删除单个 */
app.delete('/api/trash/:id', (req, res) => {
  try {
    const id = validateSessionId(req.params.id);
    const trashPath = safePath(TRASH_DIR, id);
    if (!fs.existsSync(trashPath)) return res.status(404).json({ error: '回收站中不存在此会话' });
    const size = getDirSize(trashPath);
    fs.rmSync(trashPath, { recursive: true });
    res.json({ success: true, sessionId: id, freedBytes: size, freedFormatted: formatBytes(size) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/trash/purge — 清空回收站 */
app.post('/api/trash/purge', (req, res) => {
  try {
    if (!fs.existsSync(TRASH_DIR)) return res.json({ purged: 0, freedBytes: 0, freedFormatted: '0 B' });
    const dirs = fs.readdirSync(TRASH_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
    let freedBytes = 0;
    for (const dir of dirs) {
      const fullPath = path.join(TRASH_DIR, dir.name);
      freedBytes += getDirSize(fullPath);
      fs.rmSync(fullPath, { recursive: true });
    }
    res.json({ purged: dirs.length, freedBytes, freedFormatted: formatBytes(freedBytes) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 启动 ───────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`\n  ✨ Claude History Manager 已启动`);
  console.log(`  📂 数据目录: ${CLAUDE_DIR}`);
  console.log(`  🌐 打开浏览器: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (HOST === '0.0.0.0') console.log(`  🔗 局域网访问: http://<你的IP>:${PORT}`);
  console.log();
});
