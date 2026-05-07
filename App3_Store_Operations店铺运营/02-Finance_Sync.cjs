// App3_Store_Operations/02-Finance_Sync.cjs
// 【架构升级】：已彻底剔除 Playwright 和数据库路径的硬编码，专注于多账户财务流水的纯粹业务

const path = require('path');

// ======================= [增量模块：引入底层公共基座] =======================
const dbManager = require('../00_Core_Infrastructure/db_manager.cjs');

// ======================= [路径与配置] =======================
// ❌ 已剔除硬编码的 MAIN_DB_PATH，交由基座统管

const ACCOUNT_CONFIGS = [
    {
        accountName: '货款账户',
        tabSelector: null, 
        apiUrl: 'pagingQueryMallBalanceBillListForMms',
        payloadMap: { page: 'pageNum', size: 'pageSize', start: 'inclusiveBeginTime', end: 'exclusiveEndTime' },
        tableName: 'pdd_balance_bill',
        taskLogPrefix: 'BAL_' 
    },
    {
        accountName: '营销账户',
        tabSelector: '[data-testid="mmsRawMarketingBillQueryTpl"]', 
        apiUrl: 'queryMerchantMarketingBillList',
        payloadMap: { page: 'pageNum', size: 'pageSize', start: 'inclusiveStartBizAt', end: 'inclusiveEndBizAt' },
        tableName: 'pdd_marketing_balance_bill',
        taskLogPrefix: 'MKT_' 
    },
    {
        accountName: '保证金账户',
        tabSelector: 'div:has-text("保证金账户")', 
        apiUrl: 'queryMerchantDepositBillList',
        payloadMap: { page: 'pageNum', size: 'pageSize', start: 'inclusiveStartBizAt', end: 'inclusiveEndBizAt' },
        tableName: 'pdd_deposit_balance_bill',
        taskLogPrefix: 'DEP_' 
    }
];

// ======================= [数据库初始化] =======================
function initDB() {
    // 调用基座的数据库实例
    const db = dbManager.getRawDbInstance();
    if (!db) {
        throw new Error("🚨 [致命错误] 无法获取基座数据库实例，请检查 env_config 配置。");
    }

    db.exec(`
        CREATE TABLE IF NOT EXISTS pdd_balance_bill (
            billId TEXT PRIMARY KEY, mallId INTEGER, orderSn TEXT, amount INTEGER, createdAt INTEGER, 
            type INTEGER, classIdDesc TEXT, financeIdDesc TEXT, note TEXT, sourceBizNo TEXT, 
            billOutBizDesc TEXT, storeName TEXT, insertTime DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS pdd_marketing_balance_bill (
            flowId TEXT PRIMARY KEY, mallId INTEGER, orderSn TEXT, amount INTEGER, bizAt INTEGER, 
            createdAt INTEGER, note TEXT, accountingTypeDesc TEXT, billOutBizCode TEXT, 
            billOutBizDesc TEXT, flowTitle TEXT, storeName TEXT, insertTime DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS pdd_deposit_balance_bill (
            flowId TEXT PRIMARY KEY, mallId INTEGER, mallAcctType TEXT, bizType TEXT, flowType TEXT, 
            amount INTEGER, bizAt INTEGER, accountingTypeDesc TEXT, note TEXT, createdAt INTEGER, 
            billOutBizCode TEXT, billOutBizDesc TEXT, flowTitle TEXT, storeName TEXT, insertTime DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS sync_task_log_all (
            chunk_key TEXT PRIMARY KEY, account_type TEXT, startStr TEXT, endStr TEXT,
            startSec INTEGER, endSec INTEGER, status TEXT, storeName TEXT, updateTime DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
    return db;
}

// ======================= [辅助函数] =======================
const formatExactTime = (sec) => {
    const d = new Date(sec * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};

function getPendingTasks(db, accountConfig, startYear, storeName) {
    const prefix = accountConfig.taskLogPrefix;
    console.log(`[${storeName}] 正在核对【${accountConfig.accountName}】同步进度...`);
    const chunks = [];
    let current = new Date(`${startYear}-01-01T00:00:00`);
    const now = new Date();
    const todayEndSec = Math.floor(now.getTime() / 1000);
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 3600 * 1000);

    if (current < oneYearAgo) {
        current = oneYearAgo;
        console.log(`⚠️ [边界修正] 平台限制查询1年前冷数据，起点已自动重置为: ${formatExactTime(current.getTime()/1000)}`);
    }
    
    const allLogs = db.prepare('SELECT * FROM sync_task_log_all WHERE account_type = ? AND storeName = ?').all(accountConfig.accountName, storeName);
    
    while (current < now) {
        let nextMonth = new Date(current.getFullYear(), current.getMonth() + 1, 1);
        let endOfCurrentMonth = new Date(nextMonth.getTime() - 1000); 
        if (endOfCurrentMonth > now) endOfCurrentMonth = now;
        
        const startSec = Math.floor(current.getTime() / 1000);
        const endSec = Math.floor(endOfCurrentMonth.getTime() / 1000);
        chunks.push({ startStr: formatExactTime(startSec), endStr: formatExactTime(endSec), startSec, endSec });
        current = nextMonth;
    }

    const pendingTasks = [];
    for (const chunk of chunks.reverse()) {
        const exactMatch = allLogs.find(log => log.startSec === chunk.startSec && log.endSec === chunk.endSec);
        if (exactMatch) {
            if ((exactMatch.status !== 'DONE' && exactMatch.status !== 'TRUNCATED') || chunk.endSec >= todayEndSec - 86400) {
                pendingTasks.push({ ...chunk, key: exactMatch.chunk_key });
            }
        } else {
            const hasFragments = allLogs.some(log => log.startSec >= chunk.startSec && log.endSec <= chunk.endSec);
            if (!hasFragments) pendingTasks.push({ ...chunk, key: `${storeName}_${prefix}${chunk.startSec}_${chunk.endSec}` });
        }
    }
    
    const fragmentedTasks = allLogs.filter(log => log.status === 'PENDING' && log.account_type === accountConfig.accountName);
    for (const frag of fragmentedTasks) {
        if (!pendingTasks.some(t => t.key === frag.chunk_key)) {
            pendingTasks.push({ startStr: frag.startStr, endStr: frag.endStr, startSec: frag.startSec, endSec: frag.endSec, key: frag.chunk_key });
        }
    }
    return pendingTasks.sort((a, b) => b.startSec - a.startSec);
}

// ======================= [核心业务函数] =======================
async function runMultiAccountScraper(homePage, storeName) {
    const db = initDB();
    let cashierPage = null; 

    try {
        console.log(`\n[${storeName}] 🤖 接收指令，接管浏览器实例进入【财务对账中心】...`);
        
        // 1. 确保起点稳固
        await homePage.goto('https://mms.pinduoduo.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await homePage.waitForTimeout(2000);
        
        // 2. 定位并点击【对账中心】
        const cashierLink = homePage.locator('a[href*="/cashier/finance/payment-bills"]').first();
        await cashierLink.waitFor({ state: 'visible', timeout: 30000 });
        
        console.log(`🤖 环境安全，正在自动打开【对账中心】...`);
        
        // 3. 拦截新标签页并挂载
        const [newTab] = await Promise.all([
            homePage.context().waitForEvent('page', { timeout: 60000 }),
            cashierLink.click({ force: true })
        ]);
        cashierPage = newTab;
        await cashierPage.waitForLoadState('domcontentloaded');
        await cashierPage.bringToFront();
        await cashierPage.waitForTimeout(3000);

        const updateTaskStmt = db.prepare(`
            INSERT OR REPLACE INTO sync_task_log_all (chunk_key, account_type, startStr, endStr, startSec, endSec, status, storeName)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        // ======================= [外层多账户轮询] =======================
        for (const config of ACCOUNT_CONFIGS) {
            console.log(`\n=================================================================`);
            console.log(`🎯 准备接管并同步【${config.accountName}】数据流...`);
            
            const pendingTasks = getPendingTasks(db, config, 2022, storeName);
            if (pendingTasks.length === 0) {
                console.log(`[${config.accountName}] 历史记录已是最新状态，跳过同步。`);
                continue;
            }

            let currentIterPage = 1;
            let currentChunkStart = 0;
            let currentChunkEnd = 0;
            
            // 底层 API 劫持与参数注入
            const setupRoute = async (pageTarget) => {
                await pageTarget.route(`**/${config.apiUrl}*`, async route => {
                    const request = route.request();
                    if (request.method() === 'POST') {
                        try {
                            const postData = JSON.parse(request.postData() || '{}');
                            postData[config.payloadMap.page] = currentIterPage;
                            postData[config.payloadMap.size] = 100; 
                            postData[config.payloadMap.start] = currentChunkStart;
                            postData[config.payloadMap.end] = currentChunkEnd;
                            await route.continue({ postData: JSON.stringify(postData) });
                        } catch (e) { await route.continue(); }
                    } else { await route.continue(); }
                });
            };

            await setupRoute(cashierPage);

            if (config.tabSelector) {
                console.log(`🖱️ 正在自动切换至【${config.accountName}】面板...`);
                try {
                    await cashierPage.locator(config.tabSelector).last().click({ force: true, timeout: 10000 });
                    await cashierPage.waitForTimeout(2000);
                } catch (e) {
                    console.log(`⚠️ 初始切换 ${config.accountName} 失败，尝试重试...`);
                    continue; 
                }
            }

            let insertStmt;
            if (config.accountName === '货款账户') {
                insertStmt = db.prepare(`INSERT OR IGNORE INTO pdd_balance_bill (billId, mallId, orderSn, amount, createdAt, type, classIdDesc, financeIdDesc, note, sourceBizNo, billOutBizDesc, storeName) VALUES (@billId, @mallId, @orderSn, @amount, @createdAt, @type, @classIdDesc, @financeIdDesc, @note, @sourceBizNo, @billOutBizDesc, @storeName)`);
            } else if (config.accountName === '营销账户') {
                insertStmt = db.prepare(`INSERT OR IGNORE INTO pdd_marketing_balance_bill (flowId, mallId, orderSn, amount, bizAt, createdAt, note, accountingTypeDesc, billOutBizCode, billOutBizDesc, flowTitle, storeName) VALUES (@flowId, @mallId, @orderSn, @amount, @bizAt, @createdAt, @note, @accountingTypeDesc, @billOutBizCode, @billOutBizDesc, @flowTitle, @storeName)`);
            } else if (config.accountName === '保证金账户') {
                insertStmt = db.prepare(`INSERT OR IGNORE INTO pdd_deposit_balance_bill (flowId, mallId, mallAcctType, bizType, flowType, amount, bizAt, accountingTypeDesc, note, createdAt, billOutBizCode, billOutBizDesc, flowTitle, storeName) VALUES (@flowId, @mallId, @mallAcctType, @bizType, @flowType, @amount, @bizAt, @accountingTypeDesc, @note, @createdAt, @billOutBizCode, @billOutBizDesc, @flowTitle, @storeName)`);
            }

            let queryBtnLocator = cashierPage.locator('button:has-text("查询")').first();

            // ======================= [内层区块抓取] =======================
            while (pendingTasks.length > 0) {
                const task = pendingTasks.shift();
                console.log(`\n📅 ${config.accountName} 区块: ${task.startStr} 至 ${task.endStr}`);
                
                currentChunkStart = task.startSec;
                currentChunkEnd = task.endSec;
                const todayEndSec = Math.floor(new Date().getTime() / 1000);
                
                // 增量提速裁切逻辑
                if (task.endSec >= todayEndSec - 86400) {
                    let maxTimeRow;
                    if (config.accountName === '货款账户') maxTimeRow = db.prepare('SELECT MAX(createdAt) as maxTime FROM pdd_balance_bill').get();
                    else if (config.accountName === '营销账户') maxTimeRow = db.prepare('SELECT MAX(bizAt) as maxTime FROM pdd_marketing_balance_bill').get();
                    else if (config.accountName === '保证金账户') maxTimeRow = db.prepare('SELECT MAX(bizAt) as maxTime FROM pdd_deposit_balance_bill').get();
                    
                    if (maxTimeRow && maxTimeRow.maxTime && maxTimeRow.maxTime > currentChunkStart) {
                        const safeStart = maxTimeRow.maxTime - 86400;
                        if (safeStart > currentChunkStart) {
                            currentChunkStart = safeStart;
                            console.log(`[⏳ 提速运行] 探明水位线，裁切活跃区间，从 ${formatExactTime(currentChunkStart)} 精准接续。`);
                        }
                    }
                }

                currentIterPage = 1;
                let totalPagesForChunk = 1;
                let taskStatus = 'DONE'; 
                let chunkTotalInserted = 0;
                
                while (currentIterPage <= totalPagesForChunk) {
                    try {
                        const [apiResponse] = await Promise.all([
                            cashierPage.waitForResponse(res => res.url().includes(config.apiUrl) && res.status() === 200, { timeout: 30000 }),
                            queryBtnLocator.click({ force: true })
                        ]);
                        
                        const resJson = await apiResponse.json();
                        if (!resJson.success) throw new Error(`API明确返回错误: ${resJson.errorMsg}`);

                        const dtoList = resJson.result?.billList || resJson.result?.dataList || resJson.result?.list || [];
                        
                        if (currentIterPage === 1) {
                            const totalRecords = resJson.result?.total || 0;
                            if (totalRecords >= 9500) {
                                if (currentChunkEnd - currentChunkStart <= 1) {
                                    totalPagesForChunk = 100;
                                    taskStatus = 'TRUNCATED';
                                } else {
                                    const midSec = Math.floor((currentChunkStart + currentChunkEnd) / 2);
                                    const key1 = `${storeName}_${config.taskLogPrefix}${currentChunkStart}_${midSec}`;
                                    const key2 = `${storeName}_${config.taskLogPrefix}${midSec + 1}_${currentChunkEnd}`;
                                    updateTaskStmt.run(key1, config.accountName, task.startStr, formatExactTime(midSec), currentChunkStart, midSec, 'PENDING', storeName);
                                    updateTaskStmt.run(key2, config.accountName, formatExactTime(midSec + 1), task.endStr, midSec + 1, currentChunkEnd, 'PENDING', storeName);
                                    db.prepare('DELETE FROM sync_task_log_all WHERE chunk_key = ?').run(task.key);
                                    pendingTasks.push({ key: key1, startStr: task.startStr, endStr: formatExactTime(midSec), startSec: currentChunkStart, endSec: midSec });
                                    pendingTasks.push({ key: key2, startStr: formatExactTime(midSec + 1), endStr: task.endStr, startSec: midSec + 1, endSec: currentChunkEnd });
                                    taskStatus = 'FISSION';
                                    break;
                                }
                            } else {
                                totalPagesForChunk = Math.ceil(totalRecords / 100);
                            }
                            if (totalRecords === 0) break;
                        }
                        
                        if (dtoList.length === 0) break;
                        
                        const actuallyInserted = db.transaction((items) => {
                            let insertedCount = 0;
                            for (const item of items) {
                                try { 
                                    item.storeName = storeName; 
                                    item.classIdDesc = item.classIdDesc || ''; item.financeIdDesc = item.financeIdDesc || '';
                                    item.note = item.note || ''; item.sourceBizNo = item.sourceBizNo || '';
                                    item.billOutBizDesc = item.billOutBizDesc || ''; item.accountingTypeDesc = item.accountingTypeDesc || '';
                                    item.flowTitle = item.flowTitle || ''; item.billOutBizCode = item.billOutBizCode || '';
                                    item.orderSn = item.orderSn || ''; item.mallAcctType = item.mallAcctType || '';
                                    item.bizType = item.bizType || ''; item.flowType = item.flowType || '';

                                    insertedCount += insertStmt.run(item).changes;
                                } catch (e) {}
                            }
                            return insertedCount;
                        })(dtoList);
                        
                        chunkTotalInserted += actuallyInserted;
                        console.log(`[${config.accountName}] 第 ${currentIterPage}/${totalPagesForChunk} 页 | 截获: ${dtoList.length}，新增落盘: ${actuallyInserted}`);
                        
                        await cashierPage.waitForTimeout(Math.floor(Math.random() * 1500) + 1500);
                        currentIterPage++;
                    } catch (err) {
                        if (err.message.includes('1年') || err.message.includes('一年')) {
                            console.log(`🤖 判定：此区块已被官方冷数据墙拦截，停止抓取并跳过。`);
                            taskStatus = 'EXPIRED'; 
                            break; 
                        } else {
                            console.error(`\n❌ [会话异常预警] 检测到运行异常:`, err.message);
                            taskStatus = 'FAILED';
                            break; 
                        }
                    }
                } 
                
                // 异常重试机制
                if (taskStatus === 'FAILED') {
                    console.log(`⚠️ 启动重连机制，保护当前进度...`);
                    pendingTasks.unshift(task);
                    try {
                        if (cashierPage) await cashierPage.close().catch(()=>{});
                        await homePage.bringToFront();
                        console.log(`🔄 正在刷新后台主页，重置安全 Token...`);
                        await homePage.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
                        await homePage.waitForTimeout(5000);
                        
                        const newCashierLink = homePage.locator('a[href*="/cashier/finance/payment-bills"]').first();
                        await newCashierLink.click();
                        
                        cashierPage = await homePage.context().waitForEvent('page', { timeout: 60000 });
                        await cashierPage.waitForLoadState('domcontentloaded');
                        await cashierPage.bringToFront();
                        await cashierPage.waitForTimeout(3000);
                        
                        await setupRoute(cashierPage);
                        if (config.tabSelector) {
                            console.log(`🖱️ 会话重建完毕，重新切回【${config.accountName}】...`);
                            await cashierPage.locator(config.tabSelector).last().click({ force: true, timeout: 10000 });
                            await cashierPage.waitForTimeout(3000);
                        }
                        queryBtnLocator = cashierPage.locator('button:has-text("查询")').first();
                        console.log(`✅ 会话恢复成功，重新发起同步请求。\n`);
                    } catch (reconnectErr) {
                        console.error(`🚨 恢复会话失败，终止当前账户任务。`);
                        break; 
                    }
                } else if (taskStatus === 'DONE' || taskStatus === 'TRUNCATED' || taskStatus === 'EXPIRED') {
                    let finalStatus = taskStatus;
                    if (taskStatus === 'EXPIRED') {
                        finalStatus = 'DONE';
                    } else if (task.endSec >= Math.floor(new Date().getTime() / 1000) - 86400 && taskStatus !== 'TRUNCATED') {
                        finalStatus = 'PENDING';
                    }
                    
                    updateTaskStmt.run(task.key, config.accountName, task.startStr, task.endStr, task.startSec, task.endSec, finalStatus, storeName);
                    console.log(`✅ 日志戳已更新为: ${finalStatus}。本区新增落盘: ${chunkTotalInserted} 条。`);
                }
            } 
            
            if (cashierPage && !cashierPage.isClosed()) {
                await cashierPage.unroute(`**/${config.apiUrl}*`).catch(()=>{});
            }
        } 

        console.log(`\n🎉 [${storeName}] 所有账户流水同步完毕，对账数据落盘完成。`);
    } catch (e) {
        console.error(`[财务同步全局致命错误]:`, e);
        throw e; // 抛出异常供外部总控捕获
    } finally {
        // ⚠️ 严格遵守 Monorepo 规范：此处绝不调用 db.close()，保持连接池活跃供后续脚本使用
        if (cashierPage && !cashierPage.isClosed()) {
            await cashierPage.close().catch(()=>{});
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
        throw new Error("🚨 [App3_Finance] 缺少必要参数: storeName");
    }
    
    const { storeName } = params;
    console.log(`\n🚀 [App3_Finance] 接收到总控指令，开始执行【${storeName}】的财务流水同步...`);

    // 直接调度核心爬虫逻辑
    await runMultiAccountScraper(page, storeName);
}

module.exports = {
    startApp
};