const http = require('http');
const fs = require('fs');
const path = require('path');

const { queryCompany, searchCompanies } = require('./lib/company-service');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res) {
  const requestPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleCompanySearch(url, res) {
  const query = (url.searchParams.get('q') || '').trim();
  if (query.length < 2 || query.length > 50) {
    sendJson(res, 400, { error: '请输入至少 2 个字符的企业简称' });
    return;
  }
  try {
    sendJson(res, 200, { items: await searchCompanies(query) });
  } catch (error) {
    sendJson(res, 502, { error: '企业候选搜索失败，请稍后重试。', detail: error.message });
  }
}

async function handleCompanyRisk(url, res) {
  const name = (url.searchParams.get('name') || '').trim();
  if (name.length < 2 || name.length > 100) {
    sendJson(res, 400, { error: '请输入完整企业名称（2–100 个字符）' });
    return;
  }
  try {
    sendJson(res, 200, await queryCompany(name));
  } catch (error) {
    if (error.code === 'COMPANY_NOT_FOUND') {
      sendJson(res, 404, { error: '未检索到企业，请重新输入' });
      return;
    }
    sendJson(res, 502, {
      error: '暂时无法取得该企业的数据，请确认企业全称后重试。',
      detail: error.message
    });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/company-search') {
    await handleCompanySearch(url, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/company-risk') {
    await handleCompanyRisk(url, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`企业风险等级 Demo 已启动：http://${HOST}:${PORT}`);
});
