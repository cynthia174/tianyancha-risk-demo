const path = require('path');
const { execFile } = require('child_process');

const TYC_ENTRY = process.platform === 'win32'
  ? path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'tyc-cli', 'dist', 'index.js')
  : null;

function runTyc(args) {
  return new Promise((resolve, reject) => {
    const command = TYC_ENTRY ? process.execPath : 'tyc';
    const commandArgs = TYC_ENTRY ? [TYC_ENTRY, ...args] : args;
    execFile(command, commandArgs, {
      cwd: path.join(__dirname, '..'),
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 6 * 1024 * 1024,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || '天眼查 CLI 调用失败').trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error('天眼查返回了无法解析的数据'));
      }
    });
  });
}

function runOptionalTyc(args) {
  return runTyc(args).catch((error) => ({
    _error: error.message,
    _empty: true,
    items: [],
    total: 0
  }));
}

module.exports = { runTyc, runOptionalTyc };
