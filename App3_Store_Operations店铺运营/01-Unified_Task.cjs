// App3_Store_Operations/01-Unified_Task.cjs
// 【架构升级】：已剥离硬编码的数据库路径，全面接入 00_Core_Infrastructure 基座，并封装为 startApp 标准入口

const fs = require('fs/promises');
const path = require('path');
const xlsx = require('xlsx');
const AdmZip = require('adm-zip');

// ======================= [增量模块：引入底层公共基座] =======================
const dbManager = require('../00_Core_Infrastructure/db_manager.cjs');

// ======================= [路径与参数配置] =======================
// ❌ 已剔除硬编码的 CENTRAL_DB_PATH，交由基座统管

// --- [订单模块配置] ---
const ORDER_DOWNLOAD_FOLDER = path.join(__dirname, '..', '00_Shared_Downloads', '订单_订单查询');
const ORDER_ARCHIVE_FOLDER = path.join(ORDER_DOWNLOAD_FOLDER, '已导入');
const ORDER_LIST_URL = 'https://mms.pinduoduo.com/orders/list?msfrom=mms_sidenav&tab=0';
const EXPORT_RECORD_URL = 'https://mms.pinduoduo.com/orders/exportExcel?exportType=0';
const ORDER_CHECK_PAST_DAYS = 30;
const DB_ORDER_TABLE_NAME = 'pddorder';
const ORDER_PRIMARY_KEY = '订单号';
const ORDER_PAYMENT_DATE_HEADER = '支付日期';

// --- [推广模块配置] ---
const PROMOTION_DOWNLOAD_FOLDER = path.join(__dirname, '..', '00_Shared_Downloads', '推广_商品数据', '拼多多');
const PROMOTION_ARCHIVE_FOLDER = path.join(PROMOTION_DOWNLOAD_FOLDER, '已导入');
const PROMOTION_TARGET_URL_TEMPLATE = 'https://yingxiao.pinduoduo.com/goods/report/promotion/overView?beginDate={DATE}&endDate={DATE}';
const PROMOTION_CHECK_PAST_DAYS = 15; 
const DB_PROMOTION_TABLE_NAME = 'pdd_product_promotion'; 
const PROMOTION_DATE_HEADER = '统计日期';

const DOWNLOADS_PER_BATCH = 15;
const SHORT_DELAY_MIN_MS = 3000;
const SHORT_DELAY_MAX_MS = 7000;
const LONG_DELAY_MIN_MS = 35000;
const LONG_DELAY_MAX_MS = 65000;

const pddPromoNumericColumns = [
    "总花费(元)", "成交花费(元)", "交易额(元)", "实际投产比", "净交易额(元)", 
    "净实际投产比", "净成交笔数", "每笔净成交花费(元)", "净交易额占比", 
    "结算金额(元)", "结算投产比", "结算笔数", "退款率", "退单率", 
    "退款豁免率", "退单豁免率", "交易额结算率", "订单结算率", 
    "结算订单成本(元)", "成交笔数", "每笔成交花费(元)", "每笔成交金额(元)", 
    "直接交易额(元)", "间接交易额(元)", "直接成交笔数", "间接成交笔数", 
    "每笔直接成交金额(元)", "每笔间接成交金额(元)", "全站推广费比", 
    "曝光量", "点击量", "询单花费(元)", "询单量", "平均询单成本(元)", 
    "收藏花费(元)", "收藏量", "平均关注成本(元)", "实际成交花费(元)"
];

// ======================= [数据库连接] =======================
let globalDb = null;
function getDbConnection() {
    if (!globalDb) {
        try {
            // 【平滑迭代】：直接调用基座的数据库实例
            globalDb = dbManager.getRawDbInstance();
            if (!globalDb) throw new Error("获取到的底层数据库实例为空");
            globalDb.pragma('journal_mode = WAL'); 
        } catch (e) {
            console.error(`❌ 无法从基座获取数据库连接: ${e.message}`);
            throw e;
        }
    }
    return globalDb;
}

// ======================= [公共辅助函数] =======================
function dateStrToUnix(dateStr, isEnd = false) {
    const date = new Date(dateStr);
    if (isEnd) date.setHours(23, 59, 59, 999);
    else date.setHours(0, 0, 0, 0);
    return Math.floor(date.getTime() / 1000);
}

async function randomDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    console.log(` -> 模拟操作，随机等待 ${delay / 1000} 秒...`);
    return new Promise(resolve => setTimeout(resolve, delay));
}

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

async function countdown(seconds, message) {
    for (let i = seconds; i > 0; i--) {
        process.stdout.write(`\r -> ⏳ ${message}: 还需等待 ${i} 秒...   `);
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log(`\n -> ⏰ 等待结束，恢复执行。`);
}

async function tryClosePopups(page) {
    try {
        // 以 SVG/Icon 为精准锚点，同时涵盖外层 wrapper，确保万无一失
        const closeSelectors = [
            // 策略 1：通过 SVG 向上溯源，精准定位到真正绑定了事件的父级 Wrapper Div
            'div:has(> svg[data-testid="beast-core-modal-icon-close"])',
            // 策略 2：兜底原有的 SVG 直指策略
            'svg[data-testid="beast-core-modal-icon-close"]',
            '.beast-core-modal-close',
            'button[aria-label="Close"]', 
            'button:has-text("知道了")', 
            'button:has-text("关闭")'
        ];

        for (const selector of closeSelectors) {
            const btns = page.locator(selector);
            const count = await btns.count();

            for (let i = 0; i < count; i++) {
                const btn = btns.nth(i);
                
                if (await btn.isVisible({ timeout: 500 })) {
                    console.log(` -> 🛡️ 检测到弹窗目标 [${selector}]，准备强力破解...`);
                    
                    try {
                        // 1. 先尝试最基础的强力点击
                        await btn.click({ force: true, timeout: 1000 }).catch(() => {});
                        await page.waitForTimeout(500);

                        // 2. 如果常规强力点击失效，触发底层事件防线
                        if (await btn.isVisible({ timeout: 500 })) {
                            console.log(` -> ⚠️ 常规点击遭拦截，启动底层原生 MouseEvent 强制注入...`);
                            
                            await btn.evaluate(node => {
                                // 派发标准鼠标左键点击事件
                                const clickEvent = new MouseEvent('click', {
                                    bubbles: true,
                                    cancelable: true,
                                    view: window,
                                    buttons: 1 
                                });
                                node.dispatchEvent(clickEvent);
                                
                                // 针对 React 特性：如果 node 是 svg，尝试直接对其父节点注入事件
                                if (node.tagName.toLowerCase() === 'svg' && node.parentNode) {
                                    node.parentNode.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                                }
                            });
                            
                            await page.waitForTimeout(800);
                        }

                        // 3. 终极验证与错误收集：如果依然没关掉，保存现场证据
                        if (await btn.isVisible({ timeout: 500 })) {
                            throw new Error("底层事件注入后，弹窗元素依然处于可视状态");
                        } else {
                            console.log(` -> ✅ 弹窗清除成功！`);
                        }

                    } catch (actionError) {
                        console.log(` -> ❌ 弹窗击碎失败: ${actionError.message}`);
                        // 触发容错机制：保存错误截图以供复盘，防止静默崩溃
                        const timestamp = new Date().getTime();
                        const errorImgPath = path.join(__dirname, `error_popup_block_${timestamp}.png`);
                        await page.screenshot({ path: errorImgPath, fullPage: true }).catch(() => {});
                        console.log(` -> 📸 现场已保存至: ${errorImgPath}`);
                    }
                }
            }
        }
    } catch (e) {
        console.log(` -> ❌ tryClosePopups 全局执行错误: ${e.message}`);
    }
}

async function moveFileToArchive(sourcePath, archiveDir, newFileName = null) {
    try {
        await fs.mkdir(archiveDir, { recursive: true });
        const fileName = newFileName || path.basename(sourcePath); 
        const destPath = path.join(archiveDir, fileName);
        await fs.rename(sourcePath, destPath);
        console.log(` ✅ 文件已归档至: ${destPath}`);
    } catch (e) {
        console.error(`❌ 文件归档失败 (${path.basename(sourcePath)}): ${e.message}`);
    }
}

// ======================= [订单报表核心逻辑] =======================
function formatPaymentDate(dateTimeStr) {
    if (!dateTimeStr) return null;
    const cleanStr = String(dateTimeStr).trim().split(/\s+/)[0];
    let match = cleanStr.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    match = cleanStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (match) {
        let part1 = parseInt(match[1]), part2 = parseInt(match[2]), yearStr = match[3];
        if (yearStr.length === 2) yearStr = '20' + yearStr;
        let month = part1 > 12 ? part2 : part1;
        let day = part1 > 12 ? part1 : part2;
        return `${yearStr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
}

function getDateFromOrderId(orderId) {
    if (!orderId || String(orderId).length < 6) return null;
    const prefix = String(orderId).trim().substring(0, 6);
    if (!/^\d+$/.test(prefix)) return null;
    return `20${prefix.substring(0, 2)}-${prefix.substring(2, 4)}-${prefix.substring(4, 6)}`;
}

async function importOrderFileWithSupport(filePath, storeName) {
    const db = getDbConnection();
    try {
        let finalExcelPath = filePath;
        let isTempFile = false;
        if (filePath.toLowerCase().endsWith('.zip')) {
            const zip = new AdmZip(filePath);
            const entry = zip.getEntries().find(e => e.entryName.endsWith('.xlsx') || e.entryName.endsWith('.csv'));
            if (!entry) throw new Error("ZIP 无效");
            const tempDir = path.join(ORDER_DOWNLOAD_FOLDER, 'temp_' + Date.now());
            await fs.mkdir(tempDir, { recursive: true });
            zip.extractEntryTo(entry, tempDir, false, true);
            finalExcelPath = path.join(tempDir, entry.entryName);
            isTempFile = true;
        }

        const workbook = xlsx.readFile(finalExcelPath);
        const rawData = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { raw: false });
        
        if (rawData.length > 0) {
            const beforeCount = db.prepare(`SELECT count(*) as c FROM "${DB_ORDER_TABLE_NAME}"`).get()?.c || 0;
            processOrderDataForDatabase(rawData, db, storeName);
            const afterCount = db.prepare(`SELECT count(*) as c FROM "${DB_ORDER_TABLE_NAME}"`).get()?.c || 0;
            console.log(` ✅ [订单] 入库处理完成。📊 库内总数: ${beforeCount} -> ${afterCount}`);
        }
        
        await fs.mkdir(ORDER_ARCHIVE_FOLDER, { recursive: true });
        await fs.rename(filePath, path.join(ORDER_ARCHIVE_FOLDER, path.basename(filePath)));
        if (isTempFile) await fs.rm(path.dirname(finalExcelPath), { recursive: true, force: true });
    } catch (e) {
        console.error(` ❌ [订单] 入库错误: ${e.message}`);
    }
}

function processOrderDataForDatabase(rawData, db, storeName) {
    const cleaned = rawData.map(row => {
        const obj = {};
        for (const k in row) obj[String(k).trim()] = row[k];
        obj['店铺名称'] = storeName; 
        return obj;
    });
    const rows = cleaned.map(row => {
        const nr = { ...row };
        nr[ORDER_PAYMENT_DATE_HEADER] = formatPaymentDate(row['支付时间']);
        return nr[ORDER_PRIMARY_KEY] && nr[ORDER_PAYMENT_DATE_HEADER] ? nr : null;
    }).filter(r => r);
    if (rows.length === 0) return 0;
    
    const headers = Object.keys(rows[0]); 
    const pk = ORDER_PRIMARY_KEY.replace(/[\s\.\-\/\\()]/g, '_');
    const cols = headers.map(h => h.replace(/[\s\.\-\/\\()]/g, '_'));

    db.transaction(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS "${DB_ORDER_TABLE_NAME}" ("${pk}" TEXT PRIMARY KEY)`);
        const exist = db.prepare(`PRAGMA table_info("${DB_ORDER_TABLE_NAME}")`).all().map(c => c.name);
        cols.forEach(c => { if(!exist.includes(c)) db.prepare(`ALTER TABLE "${DB_ORDER_TABLE_NAME}" ADD COLUMN "${c}" TEXT`).run(); });
    })();
    const finalCols = db.prepare(`PRAGMA table_info("${DB_ORDER_TABLE_NAME}")`).all().map(c => c.name);
    const stmt = db.prepare(`INSERT INTO "${DB_ORDER_TABLE_NAME}" (${finalCols.map(c=>`"${c}"`).join(',')}) VALUES (${finalCols.map(c=>`@${c}`).join(',')}) ON CONFLICT("${pk}") DO UPDATE SET ${finalCols.filter(c=>c!==pk).map(c=>`"${c}"=excluded."${c}"`).join(',')}`);
    let cnt = 0;
    db.transaction(() => {
        for (const r of rows) {
            const ins = {};
            finalCols.forEach(c => {
                const rawKey = headers.find(h => h.replace(/[\s\.\-\/\\()]/g, '_') === c);
                ins[c] = r[rawKey] !== undefined ? String(r[rawKey]) : null;
            });
            if (stmt.run(ins).changes > 0) cnt++;
        }
    })();
    return cnt;
}

async function getMissingOrderDates(daysAgo, storeName) {
    const db = getDbConnection();
    const needed = new Set();
    const today = new Date();
    for(let i=1; i<=daysAgo; i++) {
        const d = new Date();
        d.setDate(today.getDate()-i);
        needed.add(formatDate(d));
    }
    try {
        const check = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(DB_ORDER_TABLE_NAME);
        if(!check) return needed;
        const sql = `SELECT "${ORDER_PRIMARY_KEY}" FROM "${DB_ORDER_TABLE_NAME}" WHERE "店铺名称" = ?`;
        const rows = db.prepare(sql).all(storeName);
        const exist = new Set();
        rows.forEach(r => {
            const dateStr = getDateFromOrderId(r[ORDER_PRIMARY_KEY]);
            if (dateStr) exist.add(dateStr);
        });
        return new Set([...needed].filter(d => !exist.has(d)));
    } catch(e) { 
        return needed;
    }
}

function groupConsecutiveDates(set) {
    const arr = Array.from(set).sort();
    if(!arr.length) return [];
    const ranges = [];
    let start = arr[0], end = arr[0];
    for(let i=1; i<arr.length; i++) {
        const next = new Date(end);
        next.setDate(next.getDate()+1);
        if(formatDate(next) === arr[i]) end = arr[i];
        else { ranges.push({start, end}); start = arr[i]; end = arr[i]; }
    }
    ranges.push({start, end});
    return ranges;
}

async function pddOrderTask(page, storeName) {
    console.log(`\n--- 📦 [任务 1/2] 启动【订单报表】同步 (回溯 ${ORDER_CHECK_PAST_DAYS} 天) ---`);
    await fs.mkdir(ORDER_DOWNLOAD_FOLDER, { recursive: true }).catch(()=>{});
    
    const missing = await getMissingOrderDates(ORDER_CHECK_PAST_DAYS, storeName);
    if (!missing.size) return console.log("✅ 订单数据库最新。");
    const ranges = groupConsecutiveDates(missing);
    console.log(` -> 订单缺失 ${missing.size} 天，分 ${ranges.length} 批执行。`);
    
    for (const range of ranges) {
        let attempt = 0;
        while (attempt < 2) {
            attempt++;
            try {
                console.log(`\n[订单执行] 处理: ${range.start} 至 ${range.end} (第 ${attempt} 次尝试)`);
                await page.goto(ORDER_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await tryClosePopups(page);
                // 替换掉 await page.waitForTimeout(2000);
await page.waitForTimeout(Math.floor(Math.random() * 2000) + 1500); // 1.5秒 - 3.5秒随机
                
                const startUnix = dateStrToUnix(range.start, false);
                const endUnix = dateStrToUnix(range.end, true);
                console.log(` -> 💉 准备劫持发包，注入底层时间范围: ${range.start} 至 ${range.end}`);
                
                const routeHandler = async route => {
                    const request = route.request();
                    if (request.method() === 'POST') {
                        try {
                            const postData = JSON.parse(request.postData());
                            postData.groupStartTime = startUnix;
                            postData.groupEndTime = endUnix;
                            await route.continue({ postData: JSON.stringify(postData) });
                        } catch (e) { await route.continue(); }
                    } else { await route.continue(); }
                };

                await page.route('**/mars/shop/recentOrders/export/task/add', routeHandler);
                try {
                    await page.getByRole('button', { name: '批量导出' }).click();
                    // 替换掉 await page.waitForTimeout(2000);
                    await page.waitForTimeout(Math.floor(Math.random() * 2000) + 1500); // 1.5秒 - 3.5秒随机
                    await page.getByRole('button', { name: '生成报表', exact: true }).click();
                    await page.waitForTimeout(2000);
                    
                    // ==========================================================
                    // 🚨 防线：安全/短信验证码拦截器
                    // ==========================================================
                    const securityModal = page.locator('.beast-core-modal, .ant-modal, div[role="dialog"]').filter({ hasText: /验证码|安全验证|手机验证/ }).first();
                    if (await securityModal.isVisible({ timeout: 3000 }).catch(() => false)) {
                        process.stdout.write('\x07'); // 触发系统提示音 (滴一声)
                        console.log(`\n🚨🚨🚨 [高危警报] 触发平台风控，需要【短信/安全验证】！`);
                        console.log(`📲 请立即在弹出的浏览器窗口中完成验证！(脚本已挂起，静默等待...)`);
                        
                        await securityModal.waitFor({ state: 'hidden', timeout: 0 });
                        console.log(`✅ 验证弹窗已解除！脚本恢复执行。`);
                        await page.waitForTimeout(3000); 
                    }
                    // ==========================================================

                } finally {
                    await page.unroute('**/mars/shop/recentOrders/export/task/add', routeHandler);
                }

                const errorToast = page.locator('.ant-message-notice, .beast-core-modal-content').filter({ hasText: /频繁|间隔|稍后|导出中/ }).first();
                if (await errorToast.isVisible({ timeout: 5000 })) {
                    console.log(`\n🚨 触发频率限制保护！`);
                    await countdown(310, "订单系统冷却中");
                    throw new Error("Frequency limit triggered");
                }

                await page.goto(EXPORT_RECORD_URL, { waitUntil: 'domcontentloaded' });
                let file = null;
                const firstDownloadBtn = page.locator('button:has-text("下载报表")').first();
                
                try {
                    await firstDownloadBtn.waitFor({ state: 'visible', timeout: 100000 });
                } catch (e) {
                    const refreshBtn = page.getByText('刷新').or(page.getByText('查询')).first();
                    if (await refreshBtn.isVisible()) {
                        await refreshBtn.click({ force: true });
                        await page.waitForTimeout(3000);
                        await firstDownloadBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
                    }
                }

                if (await firstDownloadBtn.isVisible()) {
                    try {
                        const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
                        await firstDownloadBtn.click({ force: true });
                        const down = await downloadPromise;
                        file = path.join(ORDER_DOWNLOAD_FOLDER, down.suggestedFilename());
                        await down.saveAs(file);
                        console.log(` ✅ 下载成功: ${path.basename(file)}`);
                    } catch (e) {
                        console.error(` -> ❌ 未触发下载:`, e.message);
                    }
                }

                if (!file) throw new Error("未能获取订单报表文件。");
                await importOrderFileWithSupport(file, storeName);
                break; 
            } catch (error) {
                console.error(`\n❌ 订单处理失败: ${error.message}`);
                if (attempt < 2) await page.waitForTimeout(3000);
            }
        }
    }
}

// ======================= [推广报表核心逻辑] =======================
async function savePddPromotionReportToDatabase(csvPath, dateStr, storeName) {
    console.log(`\n--- [数据库导入] 开始处理推广报表文件: ${path.basename(csvPath)} ---`);
    const db = getDbConnection();
    try {
        const workbook = xlsx.readFile(csvPath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        let rawData = xlsx.utils.sheet_to_json(worksheet, { raw: false });
        if (rawData.length === 0) return console.log(`文件数据为空，跳过导入。`);

        const toNumeric = (val) => {
            if (val === null || val === undefined || val === "-") return null;
            const num = parseFloat(String(val).replace(/[,%]/g, ''));
            return isNaN(num) ? null : num;
        };
        const processedData = rawData.map(row => {
            const finalRow = {};
            for (const key in row) finalRow[key.trim()] = row[key];
            finalRow['统计日期'] = dateStr;
            finalRow['店铺名称'] = storeName; 
            pddPromoNumericColumns.forEach(col => {
                if (finalRow.hasOwnProperty(col)) {
                   if (col === '点击率(%)') finalRow[col] = toNumeric(finalRow[col]) / 100;
                   else finalRow[col] = toNumeric(finalRow[col]);
                }
            });
            return finalRow;
        }).filter(row => row['商品ID'] !== '-' && row['统计日期']);
        
        if (processedData.length === 0) return;

        const currentFileHeaders = Object.keys(processedData[0]);
        const primaryKeys = ['统计日期', '商品ID', '店铺名称'].map(h => h.replace(/[\s\.\-\/\\()]/g, '_'));
        const getColumnType = (header) => pddPromoNumericColumns.includes(header) ? 'REAL' : 'TEXT';
        
        const tableInfo = db.prepare(`PRAGMA table_info("${DB_PROMOTION_TABLE_NAME}")`).all();
        if (tableInfo.length === 0) {
            db.exec(`
                CREATE TABLE "${DB_PROMOTION_TABLE_NAME}" (
                    ${currentFileHeaders.map(h => `"${h.replace(/[\s\.\-\/\\()]/g, '_')}" ${getColumnType(h)}`).join(', ')},
                    PRIMARY KEY (${primaryKeys.map(k => `"${k}"`).join(', ')})
                );
            `);
        } else {
            const existingColumns = tableInfo.map(col => col.name);
            const newHeaders = currentFileHeaders.filter(h => !existingColumns.includes(h.replace(/[\s\.\-\/\\()]/g, '_')));
            if (newHeaders.length > 0) {
                db.transaction(() => {
                    for (const header of newHeaders) {
                        const sanitizedHeader = header.replace(/[\s\.\-\/\\()]/g, '_');
                        db.prepare(`ALTER TABLE "${DB_PROMOTION_TABLE_NAME}" ADD COLUMN "${sanitizedHeader}" ${getColumnType(header)}`).run();
                    }
                })();
            }
        }

        const finalTableColumns = db.prepare(`PRAGMA table_info("${DB_PROMOTION_TABLE_NAME}")`).all().map(col => col.name);
        const columnsToUpdate = finalTableColumns.filter(h => !primaryKeys.includes(h));
        
        const insertQuery = `
            INSERT INTO "${DB_PROMOTION_TABLE_NAME}" (${finalTableColumns.map(h => `"${h}"`).join(', ')})
            VALUES (${finalTableColumns.map(h => `@${h}`).join(', ')})
            ON CONFLICT(${primaryKeys.map(k => `"${k}"`).join(', ')}) DO UPDATE SET
            ${columnsToUpdate.map(h => `"${h}" = excluded."${h}"`).join(', ')};
        `;
        const insertStmt = db.prepare(insertQuery);

        db.transaction((rows) => {
            for (const row of rows) {
                const dataToInsert = {};
                const sanitizedCurrentRow = {};
                for(const key in row) sanitizedCurrentRow[key.replace(/[\s\.\-\/\\()]/g, '_')] = row[key];
                for (const tableCol of finalTableColumns) {
                    dataToInsert[tableCol] = sanitizedCurrentRow.hasOwnProperty(tableCol) ? sanitizedCurrentRow[tableCol] : null;
                }
                insertStmt.run(dataToInsert);
            }
        })(processedData);
        console.log(`✅ [导入成功] 推广报表 [${path.basename(csvPath)}] ${processedData.length} 条数据同步完成。`);

    } catch (e) {
        console.error(`❌ [导入失败] 处理推广报表时发生错误:`, e.message);
    }
}

async function getMissingPromotionDates(daysAgo, storeName) {
    console.log(`\n🔍 正在查询数据库寻找 [${storeName}] 缺失的推广报表日期...`);
    const db = getDbConnection();
    const existingDates = new Set();
    const requiredDates = new Set();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - daysAgo);

    let currentDate = new Date(startDate);
    while (currentDate < today) {
        requiredDates.add(formatDate(currentDate));
        currentDate.setDate(currentDate.getDate() + 1);
    }
    if (requiredDates.size === 0) return new Set();
    
    try {
        const promotionDateSanitized = PROMOTION_DATE_HEADER.replace(/[\s\.\-\/\\()]/g, '_');
        const tableInfo = db.prepare(`PRAGMA table_info("${DB_PROMOTION_TABLE_NAME}")`).all();
        const columnExists = tableInfo.some(col => col.name === promotionDateSanitized);
        if (!columnExists) return requiredDates;

        const minDate = formatDate(startDate);
        const query = `
            SELECT DISTINCT "${promotionDateSanitized}" 
            FROM "${DB_PROMOTION_TABLE_NAME}" 
            WHERE "${promotionDateSanitized}" >= ?
            AND ("店铺名称" = ? OR "店铺名称" IS NULL);
        `;
        const rows = db.prepare(query).all(minDate, storeName);
        for (const row of rows) {
            const dateStr = row[promotionDateSanitized];
            if (dateStr && requiredDates.has(dateStr)) existingDates.add(dateStr);
        }
    } catch (e) {
        return requiredDates;
    }

    const missingDatesSet = new Set(Array.from(requiredDates).filter(date => !existingDates.has(date)));
    console.log(` -> 数据库已存 ${existingDates.size} 天，缺失 ${missingDatesSet.size} 天。`);
    return missingDatesSet;
}

async function pddPromotionTask(page, storeName) {
    console.log(`\n--- 📈 [任务 2/2] 启动【推广报表】抓取 (基于数据库查漏) ---`);
    await fs.mkdir(PROMOTION_DOWNLOAD_FOLDER, { recursive: true }).catch(()=>{});

    const datesMissingInDB = await getMissingPromotionDates(PROMOTION_CHECK_PAST_DAYS, storeName);
    const datesToDownload = Array.from(datesMissingInDB).sort();
    if (datesToDownload.length === 0) {
        console.log(`✅ [${storeName}] 的推广报表数据已在数据库中完整，无需操作。`);
        return;
    }
    
    console.log(`\n发现 ${datesToDownload.length} 个需要下载的推广日期。`);
    let downloadCounter = 0;
    const successfulDownloads = [];
    
    for (const dateStr of datesToDownload) {
        try {
            console.log(`\n[推广执行] 抓取日期: ${dateStr}`);
            const targetUrl = PROMOTION_TARGET_URL_TEMPLATE.replace(/{DATE}/g, dateStr);
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await tryClosePopups(page);
            const downloadButton = page.getByRole('button', { name: '下载' }).nth(1);
            await downloadButton.waitFor({ state: 'visible', timeout: 30000 });

            console.log(' -> 准备点击下载推广数据...');
            const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: 30000 }),
                downloadButton.click(),
            ]);
            
            const fileName = `pdd_promotion_report_${storeName}_${dateStr}.csv`;
            const filePath = path.join(PROMOTION_DOWNLOAD_FOLDER, fileName);

            await download.saveAs(filePath);
            console.log(`✅ [成功] 推广报表已保存。`);
            successfulDownloads.push({ path: filePath, date: dateStr });
            downloadCounter++;
            
            if (downloadCounter > 0 && downloadCounter % DOWNLOADS_PER_BATCH === 0) {
                await randomDelay(LONG_DELAY_MIN_MS, LONG_DELAY_MAX_MS);
            } else {
                await randomDelay(SHORT_DELAY_MIN_MS, SHORT_DELAY_MAX_MS);
            }
        } catch (error) {
            console.error(`❌ [失败] 处理推广日期 ${dateStr} 时跳过: ${error.message}`);
        }
    }
    
    if (successfulDownloads.length > 0) {
        console.log(`\n--- 正在将 ${successfulDownloads.length} 个推广文件导入数据库 ---`);
        for (const file of successfulDownloads) {
            await savePddPromotionReportToDatabase(file.path, file.date, storeName);
            await moveFileToArchive(file.path, PROMOTION_ARCHIVE_FOLDER, path.basename(file.path));
        }
    }
}

// ======================= [符合 Monorepo 规范的统一总控入口] =======================
/**
 * 业务总控启动器
 * @param {Object} page - 由 browser_manager.cjs 统一分配的 Playwright Page 对象
 * @param {Object} params - 全局传入的配置对象，需包含 storeName
 */
async function startApp(page, params) {
    if (!params || !params.storeName) {
        throw new Error("🚨 缺少必要参数: storeName");
    }
    
    const { storeName } = params;
    console.log(`\n🚀 [App3] 接收到总控指令，开始执行【${storeName}】的后台数据流转...`);

    try {
        // 调用顺序执行
        await pddOrderTask(page, storeName);
        await pddPromotionTask(page, storeName);
        
        console.log(`\n✅ [App3] 【${storeName}】的所有报表任务已执行完毕。`);
    } catch (error) {
        console.error(`\n❌ [App3] 执行过程中发生致命错误:`, error);
        throw error; // 将错误向上抛给 Global_Runner 决定是否挂起或跳过
    }
}

module.exports = {
    startApp
};