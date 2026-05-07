// App3_Store_Operations/03-Expense_Sync.cjs
// 【架构升级】：已彻底剔除硬编码路径与 Playwright 引用，专注于营销结算明细抓取

const path = require('path');

// ======================= [增量模块：引入底层公共基座] =======================
const dbManager = require('../00_Core_Infrastructure/db_manager.cjs');

// ======================= [数据库初始化] =======================
function initDB() {
    // 调用基座的数据库实例
    const db = dbManager.getRawDbInstance();
    if (!db) {
        throw new Error("🚨 [致命错误] 无法获取基座数据库实例，请检查 env_config 配置。");
    }

    db.exec(`
        CREATE TABLE IF NOT EXISTS pdd_marketing_expense (
            outSn TEXT PRIMARY KEY, bizType INTEGER, cate2 TEXT, settleId INTEGER, 
            billType INTEGER, goodsId INTEGER, goodsName TEXT, goodsAmount INTEGER, 
            costPrice INTEGER, subsidyAmount INTEGER, expenseBatchSn TEXT, 
            payType INTEGER, payTime INTEGER, note TEXT, storeName TEXT, 
            insertTime DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    db.exec(`
        CREATE TABLE IF NOT EXISTS sync_task_log (
            chunk_key TEXT PRIMARY KEY, startStr TEXT, endStr TEXT,
            startSec INTEGER, endSec INTEGER, status TEXT, storeName TEXT,
            updateTime DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    return db;
}

// ======================= [辅助函数] =======================
const formatExactTime = (sec) => {
    const d = new Date(sec * 1000);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
};

function getPendingTasks(db, startYear, storeName) {
    console.log(`[${storeName}] 正在核对营销结算历史任务检查点日志...`);
    const chunks = [];
    let current = new Date(`${startYear}-01-01T00:00:00`);
    const now = new Date();
    const todayEndSec = Math.floor(now.getTime() / 1000);
    
    const allLogs = db.prepare('SELECT * FROM sync_task_log WHERE storeName = ?').all(storeName);
    
    while (current < now) {
        let nextMonth = new Date(current.getFullYear(), current.getMonth() + 1, 1);
        let endOfCurrentMonth = new Date(nextMonth.getTime() - 1000); 
        if (endOfCurrentMonth > now) endOfCurrentMonth = now;
        
        const startSec = Math.floor(current.getTime() / 1000);
        const endSec = Math.floor(endOfCurrentMonth.getTime() / 1000);
        chunks.push({
            startStr: formatExactTime(startSec),
            endStr: formatExactTime(endSec),
            startSec: startSec,
            endSec: endSec
        });
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
            if (!hasFragments) pendingTasks.push({ ...chunk, key: `${storeName}_${chunk.startSec}_${chunk.endSec}` });
        }
    }
    
    const fragmentedTasks = allLogs.filter(log => log.status === 'PENDING');
    for (const frag of fragmentedTasks) {
        if (!pendingTasks.some(t => t.key === frag.chunk_key)) {
            pendingTasks.push({
                startStr: frag.startStr, endStr: frag.endStr,
                startSec: frag.startSec, endSec: frag.endSec,
                key: frag.chunk_key
            });
        }
    }
    return pendingTasks.sort((a, b) => b.startSec - a.startSec);
}

// ======================= [核心业务函数] =======================
async function runUltimateScraper(homePage, storeName) {
    const db = initDB();
    const pendingTasks = getPendingTasks(db, 2022, storeName);
    
    if (pendingTasks.length === 0) {
        console.log(`[${storeName}] 所有营销结算历史数据已同步完毕！`);
        // ⚠️ 严格遵守 Monorepo 规范：移除 db.close()
        return;
    }

    let globalTotalFetched = 0;
    let globalTotalInserted = 0;
    let cashierPage = null;
    
    try {
        console.log(`\n[${storeName}] 🤖 开始执行【营销活动结算】明细抓取...`);
        
        // 1. 确保起点为主页
        await homePage.goto('https://mms.pinduoduo.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await homePage.waitForTimeout(2000);
        
        // 2. 进入对账中心
        const cashierLink = homePage.locator('a[href*="/cashier/finance/payment-bills"]').first();
        await cashierLink.waitFor({ state: 'visible', timeout: 30000 });
        
        const [newTab] = await Promise.all([
            homePage.context().waitForEvent('page', { timeout: 120000 }),
            cashierLink.click({ force: true })
        ]);
        cashierPage = newTab;
        await cashierPage.waitForLoadState('domcontentloaded');
        await cashierPage.bringToFront();

        console.log(`[${storeName}] 自动导航至【结算订单】模块...`);
        await cashierPage.locator('text="营销活动结算"').first().click();
        await cashierPage.waitForTimeout(1000);
        await cashierPage.locator('text="结算订单"').first().click();
        await cashierPage.waitForTimeout(3000);
        
        let currentIterPage = 1;
        let currentChunkStart = 0;
        let currentChunkEnd = 0;
        
        // 3. 底层 API 劫持与参数注入
        await cashierPage.route('**/queryExpenseOrderList*', async route => {
            const request = route.request();
            if (request.method() === 'POST') {
                try {
                    const postData = JSON.parse(request.postData() || '{}');
                    postData.page = currentIterPage;
                    postData.size = 100; 
                    postData.payTimeStart = currentChunkStart;
                    postData.payTimeEnd = currentChunkEnd;
                    await route.continue({ postData: JSON.stringify(postData) });
                } catch (e) { await route.continue(); }
            } else { await route.continue(); }
        });
        
        // 4. 预编译 SQLite 语句
        const insertStmt = db.prepare(`
            INSERT OR IGNORE INTO pdd_marketing_expense (
                outSn, bizType, cate2, settleId, billType, goodsId, goodsName, 
                goodsAmount, costPrice, subsidyAmount, expenseBatchSn, payType, payTime, note, storeName
            ) VALUES (
                @outSn, @bizType, @cate2, @settleId, @billType, @goodsId, @goodsName, 
                @amount, @costPrice, @subsidyAmount, @expenseBatchSn, @payType, @payTime, @note, @storeName
            )
        `);
        
        const updateTaskStmt = db.prepare(`
            INSERT OR REPLACE INTO sync_task_log (chunk_key, startStr, endStr, startSec, endSec, status, storeName)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        
        const queryBtnLocator = cashierPage.locator('button:has-text("查询")').first();
        console.log(`\n[${storeName}] 🤖 同步任务启动，开始执行区间遍历...`);

        // 5. 区块任务轮询执行
        while (pendingTasks.length > 0) {
            const task = pendingTasks.shift();
            console.log(`\n=================================================`);
            console.log(`📅 执行区块任务: ${task.startStr} 至 ${task.endStr}`);
            
            currentChunkStart = task.startSec;
            currentChunkEnd = task.endSec;
            currentIterPage = 1;
            let totalPagesForChunk = 1;
            let chunkTotalFetched = 0;
            let chunkTotalInserted = 0;
            let taskStatus = 'DONE';
            
            while (currentIterPage <= totalPagesForChunk) {
                try {
                    const [apiResponse] = await Promise.all([
                        cashierPage.waitForResponse(res => 
                            res.url().includes('queryExpenseOrderList') && 
                            res.request().method() === 'POST' && res.status() === 200,
                            { timeout: 30000 }
                        ),
                        queryBtnLocator.click({ force: true })
                    ]);
                    
                    const resJson = await apiResponse.json();
                    if (!resJson.success) throw new Error(`API报错: ${resJson.errorMsg}`);

                    const dtoList = resJson.result?.dtoList || resJson.result?.list || [];
                    
                    if (currentIterPage === 1) {
                        const totalRecords = resJson.result?.total || 0;
                        
                        // 裂变防爆逻辑
                        if (totalRecords >= 9500) {
                            if (currentChunkEnd - currentChunkStart <= 1) {
                                console.log(`[${storeName}] 🛑 触碰数据分页极限！同一秒内记录达到 ${totalRecords} 条，时间维度无法继续拆分。`);
                                console.log(`[${storeName}] ⚠️ 触发保护机制，将截取前 10000 条，放弃尾部数据以确保程序稳定运行...`);
                                totalPagesForChunk = 100;
                                taskStatus = 'TRUNCATED';
                            } else {
                                console.log(`[${storeName}] 🚨 逼近单次接口返回上限(${totalRecords}条)！正在执行时间区间的细粒度拆分（裂变）...`);
                                const midSec = Math.floor((currentChunkStart + currentChunkEnd) / 2);
                                
                                const key1 = `${storeName}_${currentChunkStart}_${midSec}`;
                                const key2 = `${storeName}_${midSec + 1}_${currentChunkEnd}`;
                                const str1End = formatExactTime(midSec);
                                const str2Start = formatExactTime(midSec + 1);

                                updateTaskStmt.run(key1, task.startStr, str1End, currentChunkStart, midSec, 'PENDING', storeName);
                                updateTaskStmt.run(key2, str2Start, task.endStr, midSec + 1, currentChunkEnd, 'PENDING', storeName);
                                
                                db.prepare('DELETE FROM sync_task_log WHERE chunk_key = ?').run(task.key);
                                pendingTasks.push({ key: key1, startStr: task.startStr, endStr: str1End, startSec: currentChunkStart, endSec: midSec });
                                pendingTasks.push({ key: key2, startStr: str2Start, endStr: task.endStr, startSec: midSec + 1, endSec: currentChunkEnd });

                                console.log(`[${storeName}] ✂️ 拆分完成！当前时间块已拆分为两个子任务。`);
                                taskStatus = 'FISSION';
                                break; 
                            }
                        } else {
                            totalPagesForChunk = Math.ceil(totalRecords / 100);
                            console.log(`[${storeName}] 当前区间共计: ${totalRecords} 条记录，预估需翻页: ${totalPagesForChunk} 次。`);
                        }
                        if (totalRecords === 0) break;
                    }

                    if (dtoList.length === 0) break;
                    
                    const transaction = db.transaction((items) => {
                        let insertedCount = 0;
                        for (const item of items) {
                            try { 
                                item.storeName = storeName; 
                                item.note = item.note || ''; 
                                item.amount = item.goodsAmount || item.amount || 0; 
                                const info = insertStmt.run(item);
                                insertedCount += info.changes; 
                            } catch (e) {}
                        }
                        return insertedCount;
                    });
                    
                    const actuallyInserted = transaction(dtoList);
                    chunkTotalFetched += dtoList.length;
                    chunkTotalInserted += actuallyInserted;
                    globalTotalFetched += dtoList.length;
                    globalTotalInserted += actuallyInserted;
                    
                    console.log(`[${storeName}] 第 ${currentIterPage}/${totalPagesForChunk} 页 | 截获: ${dtoList.length}，新增: ${actuallyInserted}`);
                    
                    await cashierPage.waitForTimeout(Math.floor(Math.random() * 1500) + 1500);
                    currentIterPage++;
                } catch (err) {
                    console.error(`[${storeName}] ❌ 执行时发生异常中断:`, err.message);
                    taskStatus = 'FAILED';
                    break; 
                }
            }
            
            // 更新日志状态
            if (taskStatus === 'DONE' || taskStatus === 'TRUNCATED') {
                const todayEndSec = Math.floor(new Date().getTime() / 1000);
                const finalStatus = (task.endSec >= todayEndSec - 86400 && taskStatus !== 'TRUNCATED') ? 'PENDING' : taskStatus;
                updateTaskStmt.run(task.key, task.startStr, task.endStr, task.startSec, task.endSec, finalStatus, storeName);
                console.log(`✅ 本区块任务完成，状态标记为: ${finalStatus}。本区新增落盘: ${chunkTotalInserted} 条。`);
            } else if (taskStatus === 'FAILED') {
                console.log(`⚠️ 区块任务失败，已保留任务点，将在后续流转中重试。`);
            }
        }

        console.log(`\n🎉 [${storeName}] 营销明细数据同步流转完毕！`);
        console.log(`📊 【最终运行报告】总截获: ${globalTotalFetched} 条 | 总新增: ${globalTotalInserted} 条`);

    } catch (e) {
        console.error(`[${storeName}] 发生全局严重错误:`, e);
        throw e; // 将异常向外抛给总控
    } finally {
        // ⚠️ 严格遵守 Monorepo 规范：不能执行 db.close()，以确保连接池在总控中常驻活跃
        // 但临时衍生的浏览器标签页必须关闭，释放内存
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
        throw new Error("🚨 [App3_Expense] 缺少必要参数: storeName");
    }
    
    const { storeName } = params;
    console.log(`\n🚀 [App3_Expense] 接收到总控指令，开始为【${storeName}】执行营销明细核对与落盘...`);

    // 直接调度核心爬虫逻辑
    await runUltimateScraper(page, storeName);
}

module.exports = {
    startApp
};