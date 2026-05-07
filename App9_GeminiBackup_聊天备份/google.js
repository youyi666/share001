// App9_Gemini_Backup/gemini_backup.cjs
// 核心逻辑：强力回溯版 (V3.1 修复 sanitizeFilename 丢失问题)
// 1. 增加滚动上限至 30+ 次。
// 2. 针对更新对话采用“清空并重采集”策略，确保顺序一致。
// 3. 引入消息去重池，防止重复采集。

const path = require('path');
const fs = require('fs');
const readline = require('readline');

// --- 引入核心基座 ---
const ENV_CONFIG = require('../00_Core_Infrastructure/env_config.cjs');
const browserManager = require('../00_Core_Infrastructure/browser_manager.cjs');
const dbManager = require('../00_Core_Infrastructure/db_manager.cjs');
const fileUtils = require('../00_Core_Infrastructure/file_utils.cjs');

// 加载环境变量
require('dotenv').config({ path: path.join(ENV_CONFIG.ROOT, '.env') });

// ==========================================================
// 🛠️ 核心配置区
// ==========================================================
const IS_FULL_SYNC_MODE = false; 
const SAVE_DIR = path.join(ENV_CONFIG.ROOT, "00_Shared_Downloads", "gemini_chats_backup_md");
const ARCHIVE_DIR = path.join(SAVE_DIR, "00_Archive_History"); 
const DB_TABLE_NAME = 'gemini_chat_history';
const TOP_CACHE_FILE = path.join(SAVE_DIR, "top_cache.json");

// 风险控制：滚动上限
const MAX_SCROLL_RETRIES = 40; 

// 设定黑名单字典
const BLACKLIST = [
    "当我询问 SQL 问题时", "当我要求将 CSV", "在处理复杂 UI", 
    "在提供 Playwright", "在写任何代码之前", "同一个功能或 Bug", 
    "优先使用中文", "在代码编写与修改时", "请根据我提出问题的质量", 
    "请警惕我对你的", "当我的观点与你的核心", "禁止简化我发你的代码", 
    "在修改代码时要遵循守恒原则"
];

// ==========================================
// [工具函数] 
// ==========================================

// 🔴【修复】：找回被遗漏的文件名非法字符过滤函数
function sanitizeFilename(filename) {
    if (!filename) return "未命名对话";
    return filename.replace(/[\\/*?:"<>|]/g, "").trim();
}

// ==========================================
// [逻辑一] 数据库初始化
// ==========================================

function initApp9Database() {
    const db = dbManager.getRawDbInstance();
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${DB_TABLE_NAME} (
            chat_id TEXT PRIMARY KEY,
            title TEXT,
            url TEXT,
            content_md TEXT,
            scrape_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_updated DATETIME
        )
    `);
}

/**
 * 历史文件自动入库归档
 */
async function migrateExistingMarkdownFiles() {
    if (!fs.existsSync(SAVE_DIR)) return;
    if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

    const db = dbManager.getRawDbInstance();
    const files = fs.readdirSync(SAVE_DIR).filter(f => f.endsWith('.md') && f !== 'sync_history.log');
    
    if (files.length === 0) return;

    console.log(`\n📂 [中台同步] 正在扫描并归档 ${files.length} 份历史 MD 文件...`);
    const insertStmt = db.prepare(`
        INSERT OR REPLACE INTO ${DB_TABLE_NAME} (chat_id, title, url, content_md, scrape_time)
        VALUES (?, ?, ?, ?, ?)
    `);

    let count = 0;
    for (const file of files) {
        try {
            const filePath = path.join(SAVE_DIR, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            const match = file.match(/_([a-zA-Z0-9]+)\.md$/);
            if (match && match[1]) {
                const chatId = match[1];
                const title = file.replace(`_${chatId}.md`, '');
                const url = `/app/${chatId}`;
                insertStmt.run(chatId, title, url, content, new Date().toLocaleString());
                const destPath = path.join(ARCHIVE_DIR, file);
                if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                fs.renameSync(filePath, destPath);
                count++;
            }
        } catch (e) {}
    }
    console.log(`✅ 归档完成，共入库 ${count} 条记录。`);
}

// ==========================================
// [逻辑二] 核心提取逻辑 (Turn-based 颗粒度)
// ==========================================

function extractTurnsFromResponse(payloadStr) {
    let turnsData = [];
    try {
        const lines = payloadStr.split('\n');
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('[') && trimmedLine.endsWith(']')) {
                const dataArray = JSON.parse(trimmedLine);
                if (dataArray && dataArray[0] && dataArray[0][0] === 'wrb.fr' && dataArray[0][1] === 'hNvQHb') {
                    const innerData = JSON.parse(dataArray[0][2]);
                    const rawTurns = innerData[0]; 
                    if (Array.isArray(rawTurns)) {
                        rawTurns.forEach(turn => {
                            let q = "", a = "";
                            try { q = turn[2][0][0]; } catch (e) {}
                            try { a = turn[3][0][0][1][0]; } catch (e) {}
                            
                            if (q || a) {
                                // 清洗黑名单内容
                                if (q) {
                                    BLACKLIST.forEach(word => { q = q.split(word).join(''); });
                                    q = q.replace(/-{3,}/g, '').trim();
                                }
                                turnsData.push({ q, a });
                            }
                        });
                    }
                }
            }
        }
    } catch (e) {}
    return turnsData;
}

// ==========================================
// [核心封装] startApp
// ==========================================

async function startApp() {
    console.log("🚀 --- [App9] Gemini 备份系统启动 (强力回溯 & 顺序保障版) ---");
    
    // 基础环境准备
    if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });
    initApp9Database();
    await migrateExistingMarkdownFiles();

    // 加载排位记忆
    let lastTopCache = [];
    if (fs.existsSync(TOP_CACHE_FILE)) {
        try { lastTopCache = JSON.parse(fs.readFileSync(TOP_CACHE_FILE, 'utf-8')); } catch (e) {}
    }

    const db = dbManager.getRawDbInstance();
    const downloadedUrls = new Set(db.prepare(`SELECT url FROM ${DB_TABLE_NAME}`).all().map(r => r.url.replace('https://gemini.google.com', '')));

    let browserContextManager = null;
    let targetToClose = null;
    let page;

    try {
        // 分配 Chrome 浏览器环境
        const chromeProfile = path.join(ENV_CONFIG.PROFILES_DIR, 'Gemini_Chrome_User');
        browserContextManager = await browserManager.launchBrowser({ 
            profileDir: chromeProfile,
            channel: 'chrome',
            headless: false,
            platform: 'jd'
        });
        
        // 适配基座
        if (browserContextManager.page) {
            page = browserContextManager.page;
            targetToClose = browserContextManager.browser || browserContextManager.context;
        } else {
            page = browserContextManager.pages()[0] || await browserContextManager.newPage();
            targetToClose = browserContextManager;
        }

        let activeInterceptions = 0;
        let currentChatTurnMap = new Map(); // 🔴 关键：使用 Map 进行消息去重和排序

        // 网络响应拦截
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('batchexecute') && url.includes('rpcids=hNvQHb')) {
                activeInterceptions++;
                try {
                    const text = await response.text();
                    const extractedTurns = extractTurnsFromResponse(text);
                    extractedTurns.forEach(turn => {
                        // 使用 Q+A 的内容作为唯一 Key，防止重复抓取
                        const key = Buffer.from(turn.q + turn.a).toString('base64').substring(0, 50);
                        if (!currentChatTurnMap.has(key)) {
                            // 因为是向上滚动，越晚拦截到的包越“老”
                            currentChatTurnMap.set(key, turn);
                        }
                    });
                } catch (e) {} finally { activeInterceptions--; }
            }
        });

        await page.goto("https://gemini.google.com/app?hl=zh-cn", { waitUntil: 'domcontentloaded' });
        
        // 登录检测
        if (page.url().includes('accounts.google.com')) {
            console.log("\n🔑 请手动完成 Google 登录后在终端按回车...");
            await new Promise(r => { const rl = readline.createInterface({input:process.stdin}); rl.question('',()=>{rl.close();r();}); });
        }

        await page.waitForSelector('a[data-test-id="conversation"]', { timeout: 60000 });

        // --- 探测需要更新的对话 ---
        const chatTargets = [];
        const currentTopUrls = [];
        let pointerIndex = 0, consecutiveOldCount = 0;
        const MAX_OLD_OUTER = IS_FULL_SYNC_MODE ? 9999 : 10;

        while (true) {
            const elements = await page.$$('a[data-test-id="conversation"]');
            if (pointerIndex >= elements.length) break;

            for (; pointerIndex < elements.length; pointerIndex++) {
                const elem = elements[pointerIndex];
                const href = await elem.getAttribute("href");
                const titleElem = await elem.$('.conversation-title');
                // 🔴 修复点：调用清洗函数，防止非法字符报错
                let cleanTitle = sanitizeFilename((await titleElem?.innerText() || "未命名对话").split('\n')[0]);
                
                if (href) {
                    const baseUrl = href.split('?')[0];
                    if (currentTopUrls.length < 20) currentTopUrls.push(baseUrl);
                    
                    const oldIndex = lastTopCache.indexOf(baseUrl);
                    let isTarget = false;

                    // 业务判定：如果是老对话产生了新内容，则标记为目标
                    if (!downloadedUrls.has(baseUrl) || oldIndex === -1 || (oldIndex !== -1 && pointerIndex < oldIndex)) {
                        isTarget = true;
                    }

                    if (isTarget) {
                        chatTargets.push({ url: baseUrl, title: cleanTitle });
                        consecutiveOldCount = 0;
                    } else {
                        consecutiveOldCount++;
                    }
                }
                if (consecutiveOldCount >= MAX_OLD_OUTER) break;
            }
            if (consecutiveOldCount >= MAX_OLD_OUTER) break;
            await page.mouse.wheel(0, 3000);
            await page.waitForTimeout(2000);
        }

        fs.writeFileSync(TOP_CACHE_FILE, JSON.stringify(currentTopUrls, null, 2));

        // --- 启动循环抓取 ---
        for (let i = 0; i < chatTargets.length; i++) {
            const target = chatTargets[i];
            const chatId = target.url.split('/').pop();
            const fullUrl = `https://gemini.google.com${target.url}`;
            
            currentChatTurnMap.clear(); 

            console.log(`\n[${i+1}/${chatTargets.length}] 🔄 正在重采对话: ${target.title}`);
            await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(3000);

            let scrollRetries = 0;
            let noNewDataCount = 0;
            let lastSize = 0;

            // 强力触顶
            while (scrollRetries < MAX_SCROLL_RETRIES && noNewDataCount < 6) {
                await page.evaluate(() => {
                    const nodes = document.querySelectorAll('message-content, user-query, .conversation-container > div');
                    if (nodes[0]) nodes[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
                    else window.scrollTo(0, 0);
                });
                await page.mouse.wheel(0, -4000);
                await page.keyboard.press('PageUp');
                await page.waitForTimeout(3000);

                let waitNet = 0;
                while (activeInterceptions > 0 && waitNet < 20) { await page.waitForTimeout(500); waitNet++; }

                if (currentChatTurnMap.size > lastSize) {
                    console.log(`   ⬆️  已向上挖掘历史记录 (当前消息数: ${currentChatTurnMap.size})`);
                    noNewDataCount = 0;
                    lastSize = currentChatTurnMap.size;
                } else {
                    noNewDataCount++;
                }
                scrollRetries++;
            }

            // 最终组装
            if (currentChatTurnMap.size > 0) {
                // 顺序修正：反转 Map 确保是从最老到最新的阅读顺序
                const turns = Array.from(currentChatTurnMap.values()).reverse();
                
                let md = `# ${target.title}\n**链接**: ${fullUrl}\n**抓取时间**: ${new Date().toLocaleString()}\n\n---\n\n`;
                md += turns.map(t => `### 🧑‍💻 提问：\n${t.q}\n\n### 🤖 回答：\n${t.a}`).join('\n\n---\n\n');

                const fileName = `${target.title}_${chatId}.md`;
                fs.writeFileSync(path.join(SAVE_DIR, fileName), md, 'utf-8');
                
                db.prepare(`INSERT OR REPLACE INTO ${DB_TABLE_NAME} (chat_id, title, url, content_md, last_updated) VALUES (?, ?, ?, ?, ?)`).run(
                    chatId, target.title, target.url, md, new Date().toLocaleString()
                );
                console.log(`   ✅ 对话已完整重采入库: ${fileName}`);
            }
        }

    } catch (e) {
        console.error('❌ 执行异常:', e);
    } finally {
        if (targetToClose) await targetToClose.close();
        console.log('🏁 备份任务结束。');
    }
}

module.exports = { startApp };