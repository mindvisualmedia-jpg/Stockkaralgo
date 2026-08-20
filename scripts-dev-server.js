'use strict';
// Dev-preview launcher (never deployed): runs server.js AS MAIN (it only
// listens when require.main === module) on a throwaway data dir + port 7788,
// so UI wiring can be checked in a browser without touching the real data
// files or any broker (no tokens exist in the temp dir).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-dev-'));
fs.writeFileSync(path.join(dir, 'order_log.json'), '[]');
const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  stdio: 'inherit',
  env: { ...process.env, STOCKKAR_DATA_DIR: dir, PORT: '7788', STOCKKAR_TELEGRAM_DISABLED: '1' },
});
child.on('exit', (code) => process.exit(code ?? 0));
