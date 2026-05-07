const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url'); // 引入 URL 模块处理查询参数

const PORT = 8000;

// ================= 关键配置 =================
const WEB_ROOT = path.join(__dirname, 'web');
const DATA_FILE = path.join(WEB_ROOT, 'assets/data.json');

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
    // 1. 解析请求 URL（关键修复：剥离 ?t=xxx 参数）
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // ================= 处理 API 接口 =================
    if (pathname === '/api/update-category' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { sessionId, category, isRisk } = JSON.parse(body);
                
                if (!fs.existsSync(DATA_FILE)) {
                    throw new Error(`找不到数据文件: ${DATA_FILE}`);
                }

                const rawData = fs.readFileSync(DATA_FILE, 'utf8');
                const data = JSON.parse(rawData);
                
                let found = false;
                // 兼容 id 或 sessionId
                const target = data.find(item => (item.id === sessionId || item.sessionId === sessionId));
                
                if (target) {
                    // 优先修改 AI 分析，没有则修改向量分析
                    let analysis = target.ai_analysis || target.vector_analysis;
                    if (analysis) {
                        analysis.category = category;
                        analysis.is_risk = isRisk;
                        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
                        found = true;
                    }
                }

                if (found) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Saved to disk' }));
                    console.log(`✅ [API] 修改成功: ID=${sessionId} -> ${category}`);
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Session not found' }));
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
                console.error('❌ [API] 错误:', e.message);
            }
        });
        return;
    }

    // ================= 处理静态文件 =================
    let requestPath = pathname;
    if (requestPath === '/') requestPath = '/index.html';

    // 安全路径处理
    const safePath = path.normalize(requestPath).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(WEB_ROOT, safePath);

    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                console.log(`⚠️ 404 文件未找到: ${filePath} (请求路径: ${req.url})`);
                res.writeHead(404);
                res.end('404 File Not Found');
            } else {
                res.writeHead(500);
                res.end('Server Error: ' + error.code);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

console.log('=========================================');
console.log(`🚀 Node.js 服务器已启动 (修复版)`);
console.log(`📂 网站根目录: ${WEB_ROOT}`);
console.log(`📄 数据源文件: ${DATA_FILE}`);
console.log(`👉 请访问: http://localhost:${PORT}`);
console.log('=========================================');

server.listen(PORT);