/**
 * Pinduoduo Chat Log Scraper & DB Sync (拼多多聊天记录抓取与数据库同步 - 专家版 v2)
 * * 功能：
 * 1. 自动登录（复用 Profile）
 * 2. 从 TmallDataCenter.db 读取待抓取订单
 * 3. [新增] 智能控制阀：按最近 N 天过滤订单，避免全量扫描
 * 4. 抓取全量聊天记录（自动翻页）
 * 5. 输出结构化 JSON 文件（本地备份）
 * 6. 实时比对 chat_logs.db，匹配成功则回写 order_id
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const Database = require('better-sqlite3');

/**
 * 智能寻址工具：向上自动寻找公共数据库大本营
 * @param {string} dbName 数据库文件名
 * @returns {string} 数据库的绝对路径
 */
function getSharedDbPath(dbName) {
    return path.join(
        __dirname, 
        '..', '..', // 根据脚本实际层级调整：若是跳 3 层则保持原样，若在 price_scraper 则改为 2 个 '..'
        '00_Shared_Database数据库', 
        dbName
    );
}

// ================= [配置区域 - 已修复为动态路径] =================

// 1. 任务源数据库路径 (自动指向新家)
const DB_SOURCE_PATH = getSharedDbPath('TmallDataCenter.db');

// 2. 目标日志数据库路径 (自动指向新家)
const DB_TARGET_PATH = getSharedDbPath('chat_logs.db');

// ==========================================================

console.log(`🚀 [路径检查] 源数据库: ${DB_SOURCE_PATH}`);
console.log(`🚀 [路径检查] 目标数据库: ${DB_TARGET_PATH}`);

// 3. 结果保存目录 (JSON备份)
const OUTPUT_DIR = path.join(__dirname, 'chat_logs');

// 4. 浏览器缓存路径
const USER_DATA_DIR = path.join(__dirname, 'browser_profiles', 'pdd_store');

// 5. 目标网址
const TARGET_URL = 'https://mms.pinduoduo.com/mms-chat/search?msfrom=mms_sidenav';

// 6. [新增] 控制阀：仅处理最近多少天的订单
// 设为 30 表示只处理最近30天的订单；设为 0 或 -1 表示关闭限制，处理全部。
const MAX_DAYS_LOOKBACK = 3; 

// ================= [数据库初始化] =================
// 初始化源数据库连接
let sourceDb, targetDb;
try {
    sourceDb = new Database(DB_SOURCE_PATH, { readonly: true }); // 只读模式保护源数据
    targetDb = new Database(DB_TARGET_PATH); // 读写模式
    
    // [安全检查] 检查目标表是否存在 order_id 字段，不存在则添加
    const tableInfo = targetDb.prepare("PRAGMA table_info(messages)").all();
    const hasOrderId = tableInfo.some(col => col.name === 'order_id');
    if (!hasOrderId) {
        console.log("🛠️ 检测到 messages 表缺少 order_id 字段，正在自动添加...");
        targetDb.prepare("ALTER TABLE messages ADD COLUMN order_id TEXT").run();
    }
} catch (e) {
    console.error(`❌ 数据库连接失败: ${e.message}`);
    process.exit(1);
}

// ================= [辅助工具函数] =================

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

const randomDelay = (min = 1000, max = 3000) => {
    return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
};

/**
 * 核心算法：从订单号推算日期范围
 */
function calculateDateRange(orderId) {
    try {
        const idStr = String(orderId).trim();
        const datePart = idStr.substring(0, 6);
        
        if (/^\d{6}$/.test(datePart)) {
            const year = '20' + datePart.substring(0, 2);
            const month = datePart.substring(2, 4);
            const day = datePart.substring(4, 6);
            
            const orderDate = DateTime.fromISO(`${year}-${month}-${day}`);
            
            if (orderDate.isValid) {
                // 策略：开始时间 = 订单日期 - 30天，结束时间 = 订单日期 + 60天 (覆盖售后)
                const start = orderDate.minus({ days: 30 }).toFormat('yyyy-MM-dd');
                const end = orderDate.plus({ days: 60 }).toFormat('yyyy-MM-dd');
                return `${start} ~ ${end}`;
            }
        }
    } catch (e) {
        console.warn(`   ⚠️ 无法从订单号 [${orderId}] 解析日期，使用默认范围。`);
    }

    // 默认回退方案：最近3个月
    const end = DateTime.now().toFormat('yyyy-MM-dd');
    const start = DateTime.now().minus({ months: 3 }).toFormat('yyyy-MM-dd');
    return `${start} ~ ${end}`;
}

/**
 * [新增] 订单时效性检查器
 * 判断订单日期是否在 MAX_DAYS_LOOKBACK 范围内
 */
function isOrderWithinRange(orderId, maxDays) {
    if (maxDays <= 0) return true; // 未开启限制

    try {
        const idStr = String(orderId).trim();
        const datePart = idStr.substring(0, 6); // 提取前6位 YYMMDD

        if (/^\d{6}$/.test(datePart)) {
            const year = '20' + datePart.substring(0, 2);
            const month = datePart.substring(2, 4);
            const day = datePart.substring(4, 6);
            
            const orderDate = DateTime.fromISO(`${year}-${month}-${day}`);
            
            if (orderDate.isValid) {
                // 计算当前时间与订单时间的差值（天数）
                const diffDays = DateTime.now().diff(orderDate, 'days').days;
                // 如果差值小于 maxDays，且不是未来的异常单，则保留
                return diffDays <= maxDays && diffDays > -365; 
            }
        }
    } catch (e) {
        // 如果解析失败，为了安全起见，默认保留，避免漏单
        return true; 
    }
    return true;
}

/**
 * 数据库同步核心逻辑
 * 将抓取到的消息与数据库进行指纹比对，若匹配则更新 order_id
 */
function syncToDatabase(orderID, scrapedMessages) {
    let matchCount = 0;
    
    // 预编译查询语句
    const findStmt = targetDb.prepare(`
        SELECT id, content FROM messages 
        WHERE time = ? AND sender = ?
    `);

    const updateStmt = targetDb.prepare(`
        UPDATE messages SET order_id = ? WHERE id = ?
    `);

    targetDb.transaction(() => {
        for (const msg of scrapedMessages) {
            // 1. 尝试在数据库中寻找匹配行
            const candidates = findStmt.all(msg.time, msg.name);
            
            for (const row of candidates) {
                let isMatch = false;

                // 2. 内容比对逻辑
                if (msg.type === 'image') {
                    // 如果网页抓取是图片URL，数据库里应该是 "[图片]"
                    if (row.content === '[图片]') isMatch = true;
                } else {
                    // 文本内容完全匹配
                    if (row.content === msg.content) isMatch = true;
                }

                // 3. 如果匹配成功，更新 order_id
                if (isMatch) {
                    updateStmt.run(orderID, row.id);
                    matchCount++;
                    break; // 找到一个匹配项后跳出内层循环
                }
            }
        }
    })(); 

    return matchCount;
}

// ================= [主逻辑] =================

async function runChatScraper() {
    console.log(`🚀 [启动] 拼多多聊天记录抓取与同步任务...`);

    // 1. 读取 SQLite 任务
    let tasks = [];
    try {
        const rows = sourceDb.prepare('SELECT "订单号" FROM TmallDataCenter').all();
        // 过滤空值并去重
        let allTasks = [...new Set(rows.map(row => String(row['订单号']).trim()).filter(id => id && id.length > 5))];
        console.log(`📋 数据库中共有 ${allTasks.length} 个订单。`);

        // [新增] 应用控制阀过滤
        if (MAX_DAYS_LOOKBACK > 0) {
            console.log(`⚖️ [控制阀开启] 正在筛选最近 ${MAX_DAYS_LOOKBACK} 天内的订单...`);
            tasks = allTasks.filter(id => isOrderWithinRange(id, MAX_DAYS_LOOKBACK));
            const skipped = allTasks.length - tasks.length;
            console.log(`✂️ 已过滤掉 ${skipped} 个旧订单，剩余 ${tasks.length} 个待处理。`);
        } else {
            tasks = allTasks;
        }

    } catch (e) {
        console.error(`❌ 读取源数据库失败: ${e.message}`);
        return;
    }

    if (tasks.length === 0) {
        console.log("⚠️ 没有符合日期范围的订单需要处理。");
        return;
    }

    // 2. 启动浏览器
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        channel: 'msedge', 
        headless: false,   
        viewport: null,
        args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
    });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    try {
        // 3. 访问页面并检查登录
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);

        if (page.url().includes('login')) {
            console.log("🛑 检测到未登录，请在浏览器窗口中扫码登录...");
            await page.waitForURL(url => !url.toString().includes('login'), { timeout: 0 });
            console.log("✅ 登录成功，继续任务...");
        }

        // 4. 遍历订单列表
        for (let i = 0; i < tasks.length; i++) {
            const orderID = tasks[i];
            console.log(`\n============== 处理订单 (${i + 1}/${tasks.length}): ${orderID} ==============`);

            try {
                // --- 步骤 A: 切换查询模式 ---
                const radioLabel = page.locator('label').filter({ hasText: '按订单/违规会话编号查询' });
                await radioLabel.click();
                await randomDelay(500, 1000);

                // --- 步骤 B: 输入订单号 ---
                const orderInput = page.locator('input[placeholder*="订单/违规会话编号"]');
                await orderInput.clear();
                await orderInput.fill(orderID);
                await randomDelay(500, 1000);

                // --- 步骤 C: 输入日期范围 ---
                const dateRangeStr = calculateDateRange(orderID);
                console.log(`   📅 设定时间范围: ${dateRangeStr}`);

                // [专家技巧] 移除 readonly 强制赋值
                await page.evaluate(({ selector, val }) => {
                    const el = document.querySelector(selector);
                    if (el) {
                        el.removeAttribute('readonly'); 
                        el.value = val; 
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('blur', { bubbles: true }));
                    }
                }, { selector: 'input[data-testid="beast-core-rangePicker-htmlInput"]', val: dateRangeStr });

                await randomDelay(1000, 2000);

                // --- 步骤 D: 点击查询 ---
                const searchBtn = page.locator('button').filter({ hasText: '查询' }).first();
                await searchBtn.click();
                
                console.log(`   ⏳ 等待搜索结果...`);
                try {
                    await Promise.any([
                        page.waitForSelector('.message-item', { timeout: 5000 }),
                        page.waitForSelector('.result-col-body', { timeout: 5000 })
                    ]);
                } catch (e) {
                    console.log(`   ⚠️ 未找到消息元素，可能无记录或加载超时。`);
                    continue; 
                }

                // --- 步骤 E: 循环抓取 (翻页) ---
                let allMessages = [];
                let hasNextPage = true;
                let pageCount = 1;

                while (hasNextPage) {
                    console.log(`      📄 正在抓取第 ${pageCount} 页...`);
                    await page.waitForTimeout(1000);

                    const messageItems = await page.locator('.message-item').all();

                    for (const item of messageItems) {
                        // 内部提取逻辑
                        const msgData = await item.evaluate((el) => {
                            const nameEl = el.querySelector('.message-name');
                            const timeEl = el.querySelector('.message-time');
                            const contentEl = el.querySelector('.message-text');
                            const imgEl = el.querySelector('.message-body img'); 
                            const isSystem = el.classList.contains('system-message');

                            const rawName = nameEl ? nameEl.innerText.trim() : '未知';
                            const rawTime = timeEl ? timeEl.innerText.trim() : '';
                            
                            let role = '客服';
                            if (isSystem) role = '系统';
                            else if (rawName.includes('*') || rawName.includes('子')) role = '用户';
                            
                            let content = '';
                            let type = 'text';
                            if (imgEl) {
                                content = imgEl.src;
                                type = 'image';
                            } else if (contentEl) {
                                content = contentEl.innerText.trim();
                            }

                            return {
                                time: rawTime,
                                role: role,
                                name: rawName,
                                type: type,
                                content: content
                            };
                        });
                        allMessages.push(msgData);
                    }

                    // --- 翻页逻辑 ---
                    const nextBtn = page.locator('li[data-testid="beast-core-pagination-next"]');
                    const isVisible = await nextBtn.isVisible();
                    if (!isVisible) {
                        hasNextPage = false;
                        break;
                    }
                    const classList = await nextBtn.getAttribute('class');
                    if (classList && (classList.includes('disabled') || classList.includes('disable'))) {
                        hasNextPage = false;
                        console.log(`      ✅ 已到达最后一页。`);
                    } else {
                        await nextBtn.click();
                        await randomDelay(2000, 3000); 
                        pageCount++;
                    }
                }

                // --- 步骤 F: 保存数据与同步数据库 ---
                if (allMessages.length > 0) {
                    // 1. JSON 备份
                    const fileName = path.join(OUTPUT_DIR, `${orderID}_chat.json`);
                    fs.writeFileSync(fileName, JSON.stringify(allMessages, null, 2));
                    console.log(`   💾 本地备份: 已保存 ${allMessages.length} 条记录 -> ${fileName}`);

                    // 2. 数据库同步比对
                    console.log(`   🔄 正在与 chat_logs.db 比对并回写订单号...`);
                    const matchCount = syncToDatabase(orderID, allMessages);
                    if (matchCount > 0) {
                        console.log(`   ✅ 数据库同步成功: 关联了 ${matchCount} 条消息记录。`);
                    } else {
                        console.log(`   ⚠️ 数据库同步: 未找到匹配的历史记录 (可能是新抓取的数据尚未入库)。`);
                    }

                } else {
                    console.log(`   ⚠️ 该订单没有抓取到任何聊天记录。`);
                }

            } catch (err) {
                console.error(`   ❌ 处理订单 ${orderID} 时出错:`, err);
                await page.screenshot({ path: path.join(OUTPUT_DIR, `error_${orderID}.png`) });
            }

            await randomDelay(2000, 4000);
        }

    } catch (err) {
        console.error(`❌ 全局错误:`, err);
    } finally {
        console.log(`🎉 任务全部完成，3秒后关闭浏览器...`);
        // 关闭数据库连接
        if(sourceDb) sourceDb.close();
        if(targetDb) targetDb.close();
        
        await page.waitForTimeout(3000);
        await context.close();
    }
}

// 执行
runChatScraper();