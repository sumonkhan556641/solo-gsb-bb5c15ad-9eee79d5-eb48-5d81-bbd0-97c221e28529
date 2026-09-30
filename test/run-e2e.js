'use strict';
// 端到端测试运行器：用临时数据库自动拉起服务，跑完自动关闭。
// 用法：npm run test:e2e
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.E2E_PORT || '3998';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-e2e-'));
const dbPath = path.join(tmpDir, 'charter.db');

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
  env: { ...process.env, PORT, DB_PATH: dbPath },
  stdio: ['ignore', 'inherit', 'inherit'],
});

function shutdown(code) {
  try { server.kill(); } catch {}
  setTimeout(() => process.exit(code), 200);
}

async function waitReady(deadline = Date.now() + 8000) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/overview`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('服务器未在限定时间内启动');
}

waitReady()
  .then(() => new Promise((resolve) => {
    const e2e = spawn(process.execPath, [path.join(__dirname, 'e2e.js')], {
      env: { ...process.env, E2E_BASE: `http://127.0.0.1:${PORT}` },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    e2e.on('exit', (code) => resolve(code || 0));
  }))
  .then((code) => shutdown(code))
  .catch((err) => {
    console.error(err);
    shutdown(1);
  });
