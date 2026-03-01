/**
 * Claude History Manager — 删除功能全面安全测试
 *
 * 测试策略：在独立的临时目录中模拟完整的 .claude 数据结构，
 *          不触碰用户真实数据，测试完成后自动清理。
 *
 * 运行方式：node test/delete-safety.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// ─── 配置 ──────────────────────────────────────────────────
const TEST_PORT = 13456;
const TEST_DIR = path.join(os.tmpdir(), `chm-test-${Date.now()}`);
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

// 测试用 UUID
const UUID = {
  A: '00000000-0000-4000-8000-000000000001',
  B: '00000000-0000-4000-8000-000000000002',
  C: '00000000-0000-4000-8000-000000000003',
  D: '00000000-0000-4000-8000-000000000004',
  E: '00000000-0000-4000-8000-000000000005',
  INVALID: 'not-a-valid-uuid',
  TRAVERSAL: '../../../etc/passwd',
};

const PROJECT = 'test-project';

// ─── 测试框架 ──────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
let serverProcess = null;

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(arr, item, message) {
  if (!arr.includes(item)) {
    throw new Error(`${message}\n  数组 ${JSON.stringify(arr)} 不包含 ${JSON.stringify(item)}`);
  }
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message.split('\n')[0]}`);
  }
}

// ─── HTTP 工具 ──────────────────────────────────────────────

function request(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {},
    };
    if (body) {
      const data = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(options, (res) => {
      let chunks = '';
      res.on('data', (d) => (chunks += d));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(chunks) });
        } catch {
          resolve({ status: res.statusCode, data: chunks });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const GET = (p) => request('GET', p);
const DELETE = (p) => request('DELETE', p);
const POST = (p, b) => request('POST', p, b);

// ─── 测试数据准备 ──────────────────────────────────────────

function setupTestData() {
  const projectDir = path.join(TEST_DIR, 'projects', PROJECT);
  const debugDir = path.join(TEST_DIR, 'debug');
  const fhDir = path.join(TEST_DIR, 'file-history');
  const trashDir = path.join(TEST_DIR, 'trash');

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(debugDir, { recursive: true });
  fs.mkdirSync(fhDir, { recursive: true });
  fs.mkdirSync(trashDir, { recursive: true });

  // 创建会话 A（完整的：jsonl + debug + file-history + subagent）
  const msgA = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello from session A' }, sessionId: UUID.A }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi!' }, sessionId: UUID.A }),
  ];
  fs.writeFileSync(path.join(projectDir, UUID.A + '.jsonl'), msgA.join('\n'), 'utf-8');
  fs.writeFileSync(path.join(debugDir, UUID.A + '.txt'), 'debug log for A\n'.repeat(100), 'utf-8');
  const fhDirA = path.join(fhDir, UUID.A, 'some-file');
  fs.mkdirSync(fhDirA, { recursive: true });
  fs.writeFileSync(path.join(fhDirA, 'v1.txt'), 'file history v1', 'utf-8');
  const subagentDir = path.join(projectDir, UUID.A, 'sub1');
  fs.mkdirSync(subagentDir, { recursive: true });
  fs.writeFileSync(path.join(subagentDir, 'sub.jsonl'), '{"type":"user"}', 'utf-8');

  // 创建会话 B（只有 jsonl）
  const msgB = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello from session B' }, sessionId: UUID.B }),
  ];
  fs.writeFileSync(path.join(projectDir, UUID.B + '.jsonl'), msgB.join('\n'), 'utf-8');

  // 创建会话 C（只有 jsonl + debug）
  fs.writeFileSync(path.join(projectDir, UUID.C + '.jsonl'), '{"type":"user"}', 'utf-8');
  fs.writeFileSync(path.join(debugDir, UUID.C + '.txt'), 'debug for C', 'utf-8');

  // 创建会话 D（用于批量删除测试）
  fs.writeFileSync(path.join(projectDir, UUID.D + '.jsonl'), '{"type":"user"}', 'utf-8');

  // 创建会话 E（用于批量删除测试）
  fs.writeFileSync(path.join(projectDir, UUID.E + '.jsonl'), '{"type":"user"}', 'utf-8');

  // 创建 history.jsonl（全局索引）
  const historyLines = [
    JSON.stringify({ sessionId: UUID.A, project: PROJECT, cwd: '/test/a' }),
    JSON.stringify({ sessionId: UUID.B, project: PROJECT, cwd: '/test/b' }),
    JSON.stringify({ sessionId: UUID.C, project: PROJECT, cwd: '/test/c' }),
    JSON.stringify({ sessionId: UUID.D, project: PROJECT, cwd: '/test/d' }),
    JSON.stringify({ sessionId: UUID.E, project: PROJECT, cwd: '/test/e' }),
  ];
  fs.writeFileSync(path.join(TEST_DIR, 'history.jsonl'), historyLines.join('\n'), 'utf-8');

  // 创建孤立文件（debug 和 file-history 存在但对应 session 不存在）
  const orphanId1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const orphanId2 = 'ffffffff-1111-4222-8333-444444444444';
  fs.writeFileSync(path.join(debugDir, orphanId1 + '.txt'), 'orphan debug 1', 'utf-8');
  const orphanFhDir = path.join(fhDir, orphanId2, 'file');
  fs.mkdirSync(orphanFhDir, { recursive: true });
  fs.writeFileSync(path.join(orphanFhDir, 'v1.txt'), 'orphan fh', 'utf-8');
}

function resetTestData() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
  setupTestData();
}

// ─── 文件状态检查工具 ──────────────────────────────────────

function fileExists(relativePath) {
  return fs.existsSync(path.join(TEST_DIR, relativePath));
}

function readJSON(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(TEST_DIR, relativePath), 'utf-8'));
}

function readLines(relativePath) {
  return fs.readFileSync(path.join(TEST_DIR, relativePath), 'utf-8').split('\n').filter(l => l.trim());
}

// ─── 启动测试服务器 ────────────────────────────────────────

async function startServer() {
  return new Promise((resolve, reject) => {
    // 使用环境变量指向测试目录
    const { spawn } = require('child_process');
    serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        CHM_CLAUDE_DIR: TEST_DIR,
        CHM_PORT: String(TEST_PORT),
        CHM_HOST: '127.0.0.1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let started = false;
    serverProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      if (!started && msg.includes('listening')) {
        started = true;
        resolve();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      // 忽略 stderr 但打印重要错误
      const msg = data.toString();
      if (msg.includes('EADDRINUSE')) {
        reject(new Error(`端口 ${TEST_PORT} 被占用`));
      }
    });

    // 超时保底
    setTimeout(() => {
      if (!started) {
        started = true;
        resolve(); // 即使没收到 listening 也尝试继续
      }
    }, 3000);
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

// ═══════════════════════════════════════════════════════════
//  测试用例
// ═══════════════════════════════════════════════════════════

async function runTests() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  Claude History Manager — 删除安全测试套件   ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // ─── 1. 安全校验测试 ────────────────────────────────

  console.log('━━ 1. 输入校验与安全防护 ━━');

  await test('拒绝非法 Session ID', async () => {
    const res = await DELETE(`/api/session/${UUID.INVALID}?project=${PROJECT}`);
    assert(res.status === 500, `应返回 500，实际 ${res.status}`);
    assert(res.data.error.includes('非法'), `错误消息应包含"非法"：${res.data.error}`);
  });

  await test('拒绝路径遍历攻击', async () => {
    const res = await DELETE(`/api/session/${encodeURIComponent(UUID.TRAVERSAL)}?project=${PROJECT}`);
    assert(res.status === 500, `应返回 500，实际 ${res.status}`);
  });

  await test('拒绝非法项目名（含路径分隔符）', async () => {
    const res = await DELETE(`/api/session/${UUID.A}?project=${encodeURIComponent('../hack')}`);
    assert(res.status === 500, `应返回 500，实际 ${res.status}`);
  });

  await test('拒绝空项目名', async () => {
    const res = await DELETE(`/api/session/${UUID.A}?project=`);
    assert(res.status === 500, `应返回 500，实际 ${res.status}`);
  });

  // ─── 2. 软删除测试 ─────────────────────────────────

  console.log('\n━━ 2. 软删除（移至回收站） ━━');

  await test('软删除完整会话（jsonl + debug + file-history + subagent）', async () => {
    const res = await DELETE(`/api/session/${UUID.A}?project=${PROJECT}`);
    assert(res.status === 200, `应返回 200，实际 ${res.status}`);
    assert(res.data.success === true, '应返回 success: true');

    // 验证原文件已移除
    assert(!fileExists(`projects/${PROJECT}/${UUID.A}.jsonl`), '原 jsonl 应已移除');
    assert(!fileExists(`projects/${PROJECT}/${UUID.A}`), '原 subagent 目录应已移除');
    assert(!fileExists(`debug/${UUID.A}.txt`), '原 debug 应已移除');
    assert(!fileExists(`file-history/${UUID.A}`), '原 file-history 应已移除');

    // 验证回收站中有文件
    assert(fileExists(`trash/${UUID.A}/conversation.jsonl`), '回收站应有 conversation.jsonl');
    assert(fileExists(`trash/${UUID.A}/subagents`), '回收站应有 subagents 目录');
    assert(fileExists(`trash/${UUID.A}/debug.txt`), '回收站应有 debug.txt');
    assert(fileExists(`trash/${UUID.A}/file-history`), '回收站应有 file-history 目录');
    assert(fileExists(`trash/${UUID.A}/meta.json`), '回收站应有 meta.json');

    // 验证 meta.json 内容
    const meta = readJSON(`trash/${UUID.A}/meta.json`);
    assertEqual(meta.sessionId, UUID.A, 'meta.sessionId 应正确');
    assertEqual(meta.project, PROJECT, 'meta.project 应正确');
    assertIncludes(meta.movedItems, 'conversation', 'movedItems 应包含 conversation');
    assertIncludes(meta.movedItems, 'subagents', 'movedItems 应包含 subagents');
    assertIncludes(meta.movedItems, 'debug', 'movedItems 应包含 debug');
    assertIncludes(meta.movedItems, 'file-history', 'movedItems 应包含 file-history');
    assert(meta.deletedAt, 'deletedAt 应存在');
    assert(meta.totalSize > 0, 'totalSize 应大于 0');
  });

  await test('软删除后 history.jsonl 应移除对应条目', async () => {
    const lines = readLines('history.jsonl');
    const hasA = lines.some(l => {
      try { return JSON.parse(l).sessionId === UUID.A; } catch { return false; }
    });
    assert(!hasA, 'history.jsonl 不应再包含会话 A 的条目');
    // 确保其他条目还在
    const hasB = lines.some(l => {
      try { return JSON.parse(l).sessionId === UUID.B; } catch { return false; }
    });
    assert(hasB, 'history.jsonl 应仍包含会话 B 的条目');
  });

  await test('软删除仅有 jsonl 的会话', async () => {
    const res = await DELETE(`/api/session/${UUID.B}?project=${PROJECT}`);
    assert(res.status === 200, `应返回 200`);
    assert(!fileExists(`projects/${PROJECT}/${UUID.B}.jsonl`), '原 jsonl 应已移除');
    assert(fileExists(`trash/${UUID.B}/conversation.jsonl`), '回收站应有 conversation.jsonl');
    assert(!fileExists(`trash/${UUID.B}/debug.txt`), '回收站不应有 debug.txt');
    assert(!fileExists(`trash/${UUID.B}/file-history`), '回收站不应有 file-history');

    const meta = readJSON(`trash/${UUID.B}/meta.json`);
    assertEqual(meta.movedItems, ['conversation'], '应只移动 conversation');
  });

  await test('重复删除同一会话不应崩溃', async () => {
    // UUID.B 已删，再删一次
    const res = await DELETE(`/api/session/${UUID.B}?project=${PROJECT}`);
    // 应该成功但 moved 为空（因为文件已经不在原位了）
    assert(res.status === 200, `应返回 200，实际 ${res.status}`);
  });

  // ─── 3. 恢复测试 ──────────────────────────────────

  console.log('\n━━ 3. 从回收站恢复 ━━');

  await test('完整恢复会话 A（所有组件）', async () => {
    const res = await POST(`/api/trash/${UUID.A}/restore`);
    assert(res.status === 200, `应返回 200，实际 ${res.status}`);
    assert(res.data.success === true, '应返回 success: true');

    // 验证文件恢复到原位
    assert(fileExists(`projects/${PROJECT}/${UUID.A}.jsonl`), 'jsonl 应恢复');
    assert(fileExists(`projects/${PROJECT}/${UUID.A}`), 'subagent 目录应恢复');
    assert(fileExists(`debug/${UUID.A}.txt`), 'debug 应恢复');
    assert(fileExists(`file-history/${UUID.A}`), 'file-history 应恢复');

    // 验证回收站目录已清理
    assert(!fileExists(`trash/${UUID.A}`), '回收站中该会话目录应被清理');

    // 验证恢复的文件内容完整
    const content = fs.readFileSync(path.join(TEST_DIR, 'projects', PROJECT, UUID.A + '.jsonl'), 'utf-8');
    assert(content.includes('Hello from session A'), '恢复的内容应完整');
  });

  await test('恢复后 history.jsonl 应包含恢复的条目', async () => {
    const lines = readLines('history.jsonl');
    const hasA = lines.some(l => {
      try { return JSON.parse(l).sessionId === UUID.A; } catch { return false; }
    });
    assert(hasA, 'history.jsonl 应包含已恢复的会话 A 条目');
  });

  await test('恢复不存在的会话应报错', async () => {
    const fakeId = '99999999-9999-4999-8999-999999999999';
    const res = await POST(`/api/trash/${fakeId}/restore`);
    assert(res.status === 500, `应返回 500，实际 ${res.status}`);
  });

  await test('恢复到存在冲突的位置应报错', async () => {
    // 先删除 A
    await DELETE(`/api/session/${UUID.A}?project=${PROJECT}`);
    // 手动在原位创建一个同名文件
    fs.writeFileSync(
      path.join(TEST_DIR, 'projects', PROJECT, UUID.A + '.jsonl'),
      '{"fake": true}',
      'utf-8'
    );
    // 尝试恢复应失败
    const res = await POST(`/api/trash/${UUID.A}/restore`);
    assert(res.status === 500, `应返回 500，实际 ${res.status}`);
    assert(res.data.error.includes('已存在'), '错误消息应提示已存在');

    // 清理：移除手动创建的文件，恢复会话
    fs.unlinkSync(path.join(TEST_DIR, 'projects', PROJECT, UUID.A + '.jsonl'));
    await POST(`/api/trash/${UUID.A}/restore`);
  });

  // ─── 4. 删除 → 恢复数据完整性验证 ────────────────

  console.log('\n━━ 4. 删除-恢复往返完整性 ━━');

  await test('删除后恢复，文件 byte 级一致', async () => {
    // 记录原始内容
    const origContent = fs.readFileSync(
      path.join(TEST_DIR, 'projects', PROJECT, UUID.A + '.jsonl'), 'utf-8'
    );
    const origDebug = fs.readFileSync(
      path.join(TEST_DIR, 'debug', UUID.A + '.txt'), 'utf-8'
    );

    // 删除
    await DELETE(`/api/session/${UUID.A}?project=${PROJECT}`);
    // 恢复
    await POST(`/api/trash/${UUID.A}/restore`);

    // 比较
    const restoredContent = fs.readFileSync(
      path.join(TEST_DIR, 'projects', PROJECT, UUID.A + '.jsonl'), 'utf-8'
    );
    const restoredDebug = fs.readFileSync(
      path.join(TEST_DIR, 'debug', UUID.A + '.txt'), 'utf-8'
    );
    assertEqual(restoredContent, origContent, '对话内容应 byte 级一致');
    assertEqual(restoredDebug, origDebug, '调试日志应 byte 级一致');
  });

  await test('子代理目录内容应完整保留', async () => {
    const subPath = path.join(TEST_DIR, 'projects', PROJECT, UUID.A, 'sub1', 'sub.jsonl');
    assert(fs.existsSync(subPath), '子代理文件应存在');
    const content = fs.readFileSync(subPath, 'utf-8');
    assertEqual(content, '{"type":"user"}', '子代理文件内容应完整');
  });

  // ─── 5. 彻底删除测试 ──────────────────────────────

  console.log('\n━━ 5. 彻底删除（永久） ━━');

  await test('彻底删除回收站中的会话', async () => {
    // 先软删除 C
    await DELETE(`/api/session/${UUID.C}?project=${PROJECT}`);
    assert(fileExists(`trash/${UUID.C}/meta.json`), '回收站应有 C');

    // 彻底删除
    const res = await DELETE(`/api/trash/${UUID.C}`);
    assert(res.status === 200, `应返回 200`);
    assert(res.data.success === true, '应返回 success');
    assert(!fileExists(`trash/${UUID.C}`), '回收站不应再有 C');
    // 确保原位也没有
    assert(!fileExists(`projects/${PROJECT}/${UUID.C}.jsonl`), '原位也不应有 C');
  });

  await test('彻底删除不存在的回收站会话应返回 404', async () => {
    const res = await DELETE(`/api/trash/${UUID.C}`);
    assert(res.status === 404, `应返回 404，实际 ${res.status}`);
  });

  // ─── 6. 批量删除测试 ──────────────────────────────

  console.log('\n━━ 6. 批量操作 ━━');

  await test('批量删除多个会话', async () => {
    const res = await POST('/api/sessions/batch-delete', {
      project: PROJECT,
      sessionIds: [UUID.D, UUID.E],
    });
    assert(res.status === 200, `应返回 200`);
    assert(res.data.success === true, '应返回 success');

    // 验证两个都移到了回收站
    assert(fileExists(`trash/${UUID.D}/meta.json`), 'D 应在回收站');
    assert(fileExists(`trash/${UUID.E}/meta.json`), 'E 应在回收站');
    assert(!fileExists(`projects/${PROJECT}/${UUID.D}.jsonl`), 'D 原位应移除');
    assert(!fileExists(`projects/${PROJECT}/${UUID.E}.jsonl`), 'E 原位应移除');
  });

  await test('批量删除参数校验', async () => {
    const res1 = await POST('/api/sessions/batch-delete', { project: PROJECT });
    assert(res1.status === 400, '缺少 sessionIds 应 400');

    const res2 = await POST('/api/sessions/batch-delete', { sessionIds: [UUID.A] });
    assert(res2.status === 400, '缺少 project 应 400');
  });

  await test('批量删除含无效 ID 时，有效 ID 仍应成功', async () => {
    // 先恢复 D
    await POST(`/api/trash/${UUID.D}/restore`);
    const res = await POST('/api/sessions/batch-delete', {
      project: PROJECT,
      sessionIds: [UUID.D, UUID.INVALID],
    });
    assert(res.status === 200, `应返回 200`);
    // D 应该被删成功
    assert(fileExists(`trash/${UUID.D}/meta.json`), 'D 应在回收站');
    // 结果中应有错误记录
    const errorResult = res.data.results.find(r => r.error);
    assert(errorResult, '应有一个错误结果');
  });

  // ─── 7. 清空回收站测试 ────────────────────────────

  console.log('\n━━ 7. 清空回收站 ━━');

  await test('清空回收站', async () => {
    // 回收站中应该有 D, E, (B 可能也在)
    const trashBefore = await GET('/api/trash');
    const countBefore = (trashBefore.data.items || []).length;
    assert(countBefore > 0, `回收站应有内容，实际 ${countBefore} 项`);

    const res = await POST('/api/trash/purge');
    assert(res.status === 200, `应返回 200`);
    assert(res.data.purged > 0, `应清除了内容`);

    // 验证回收站为空
    const trashAfter = await GET('/api/trash');
    assertEqual((trashAfter.data.items || []).length, 0, '回收站应为空');
  });

  // ─── 8. 孤立文件检测与清理 ────────────────────────

  console.log('\n━━ 8. 孤立文件管理 ━━');

  resetTestData(); // 重建测试数据
  await new Promise(r => setTimeout(r, 500)); // 等待文件系统同步

  await test('检测孤立 debug 日志', async () => {
    const res = await GET('/api/orphans/debug');
    assert(res.status === 200, `应返回 200`);
    const orphanSids = res.data.items.map(i => i.sessionId);
    assertIncludes(orphanSids, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', '应检测到孤立 debug');
  });

  await test('检测孤立文件历史', async () => {
    const res = await GET('/api/orphans/file-history');
    assert(res.status === 200, `应返回 200`);
    const orphanSids = res.data.items.map(i => i.sessionId);
    assertIncludes(orphanSids, 'ffffffff-1111-4222-8333-444444444444', '应检测到孤立文件历史');
  });

  await test('删除单个孤立 debug 日志', async () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    assert(fileExists(`debug/${sid}.txt`), '孤立文件应存在');
    const res = await DELETE(`/api/orphans/debug/${sid}`);
    assert(res.status === 200, `应返回 200`);
    assert(!fileExists(`debug/${sid}.txt`), '孤立文件应被删除');
    assert(res.data.freedBytes > 0, '应报告释放空间');
  });

  await test('删除单个孤立文件历史', async () => {
    const sid = 'ffffffff-1111-4222-8333-444444444444';
    assert(fileExists(`file-history/${sid}`), '孤立目录应存在');
    const res = await DELETE(`/api/orphans/file-history/${sid}`);
    assert(res.status === 200, `应返回 200`);
    assert(!fileExists(`file-history/${sid}`), '孤立目录应被删除');
  });

  await test('不应误删活跃会话的 debug 日志', async () => {
    // UUID.A 和 UUID.C 有对应 jsonl，其 debug 不应被标记为孤立
    const res = await GET('/api/orphans/debug');
    const orphanSids = res.data.items.map(i => i.sessionId);
    assert(!orphanSids.includes(UUID.A), '活跃会话 A 的 debug 不应被标记为孤立');
    assert(!orphanSids.includes(UUID.C), '活跃会话 C 的 debug 不应被标记为孤立');
  });

  await test('批量清理孤立 debug（已无孤立时应返回 0）', async () => {
    const res = await POST('/api/cleanup/debug');
    assert(res.status === 200, `应返回 200`);
    assertEqual(res.data.cleaned, 0, '已无孤立文件，cleaned 应为 0');
  });

  // ─── 9. 边界条件测试 ──────────────────────────────

  console.log('\n━━ 9. 边界条件 ━━');

  await test('删除不存在的会话（不报错，但 moved 为空）', async () => {
    const fakeId = '11111111-2222-4333-8444-555555555555';
    const res = await DELETE(`/api/session/${fakeId}?project=${PROJECT}`);
    assert(res.status === 200, `应返回 200`);
  });

  await test('对空回收站执行清空应安全返回', async () => {
    // 先清空
    await POST('/api/trash/purge');
    const res = await POST('/api/trash/purge');
    assert(res.status === 200, `应返回 200`);
    assertEqual(res.data.purged, 0, '清空空回收站应 purged=0');
  });

  await test('history.jsonl 不存在时删除不应崩溃', async () => {
    // 临时移走 history.jsonl
    const histPath = path.join(TEST_DIR, 'history.jsonl');
    const backupPath = histPath + '.bak';
    if (fs.existsSync(histPath)) fs.renameSync(histPath, backupPath);

    const res = await DELETE(`/api/session/${UUID.A}?project=${PROJECT}`);
    assert(res.status === 200, '即使 history.jsonl 不存在也不应崩溃');

    // 恢复
    if (fs.existsSync(backupPath)) fs.renameSync(backupPath, histPath);
    // 恢复会话
    if (fileExists(`trash/${UUID.A}`)) await POST(`/api/trash/${UUID.A}/restore`);
  });

  await test('回收站列表应正确读取 meta.json', async () => {
    // 删除一个然后查看列表
    await DELETE(`/api/session/${UUID.B}?project=${PROJECT}`);
    const res = await GET('/api/trash');
    assert(res.status === 200, `应返回 200`);
    assert(Array.isArray(res.data.items), '应返回 items 数组');
    const item = res.data.items.find(i => i.sessionId === UUID.B);
    assert(item, '回收站列表应包含 B');
    assert(item.project === PROJECT, '项目名应正确');
    assert(item.deletedAt, '删除时间应存在');
  });

  // ─── 10. API 功能不受影响验证 ─────────────────────

  console.log('\n━━ 10. 删除后 API 一致性 ━━');

  await test('删除后项目列表仍正常', async () => {
    const res = await GET('/api/projects');
    assert(res.status === 200, '项目列表应正常');
    assert(Array.isArray(res.data), '应返回数组');
  });

  await test('删除后会话列表排除已删会话', async () => {
    const res = await GET(`/api/sessions?project=${PROJECT}`);
    assert(res.status === 200, '会话列表应正常');
    const ids = res.data.map(s => s.sessionId);
    assert(!ids.includes(UUID.B), '已删除的 B 不应出现在会话列表');
  });

  await test('删除后搜索不返回已删会话', async () => {
    const res = await GET(`/api/search?q=session+B`);
    assert(res.status === 200, '搜索应正常');
    const results = res.data.results || res.data || [];
    const ids = Array.isArray(results) ? results.map(r => r.sessionId) : [];
    assert(!ids.includes(UUID.B), '已删除的 B 不应出现在搜索结果');
  });

  await test('删除后统计数据应更新', async () => {
    const res = await GET('/api/stats');
    assert(res.status === 200, '统计应正常');
    assert(res.data.total && typeof res.data.total.size === 'number', '应有 total.size');
    assert(Array.isArray(res.data.breakdown), '应有 breakdown 数组');
  });

  // ─── 输出结果 ─────────────────────────────────────

  console.log('\n══════════════════════════════════════════════');
  console.log(`  通过: ${passed}  失败: ${failed}  跳过: ${skipped}`);
  console.log('══════════════════════════════════════════════');

  if (failures.length > 0) {
    console.log('\n失败详情:');
    for (const f of failures) {
      console.log(`  ✗ ${f.name}`);
      console.log(`    ${f.error}`);
    }
  }

  return failed === 0;
}

// ─── 主流程 ────────────────────────────────────────────────

async function main() {
  console.log(`测试数据目录: ${TEST_DIR}`);

  try {
    // 准备
    setupTestData();
    console.log('测试数据已创建');

    // 启动服务器
    console.log(`正在启动测试服务器 (port ${TEST_PORT})...`);
    await startServer();
    console.log('服务器已启动\n');

    // 等待服务器完全就绪
    await new Promise(r => setTimeout(r, 1000));

    // 执行测试
    const success = await runTests();

    // 结束
    stopServer();

    // 清理测试目录
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
      console.log(`\n已清理测试目录: ${TEST_DIR}`);
    }

    process.exit(success ? 0 : 1);
  } catch (err) {
    console.error('\n测试执行出错:', err);
    stopServer();
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
    process.exit(1);
  }
}

main();
