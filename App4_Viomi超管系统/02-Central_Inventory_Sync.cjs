// 02-Central_Inventory_Sync.cjs
// 【独立脚本】：拼多多在售商品 中央库存全自动查询与同步 (支持 S系列 组合编码智能拆包计算)
// 
// 架构升级日志：
// 1. [基座融合]：全面迁移至 CommonJS 规范，接入 db_manager 全局数据库单例。
// 2. [浏览器托管]：移除内建 Chromium，改由 app4 总控传入 context 进行操作。
// 3. [容错升级]：加入全局级别的运行崩溃快照保存机制。
// 4. [缓存提效]：新增本地 BOM 字典表，S码拆解只需抓取一次，后续毫秒级命中免查！
// 5. [UI 修复]：修复 Page 与 Locator 作用域混淆导致的致命连跳 Bug，加入强力路由注入导航。
// 6. [智能排重]：新增断点续传机制，智能过滤当日已查库存，只补漏网之鱼，防重复运行。

const path = require('path');
const fs = require('fs');
const readline = require('readline');

// ======================= [基座代码引入] =======================
const envConfig = require('../00_Core_Infrastructure/env_config.cjs'); 
const dbManager = require('../00_Core_Infrastructure/db_manager.cjs');

require('dotenv').config({ path: path.join(envConfig.ROOT, '.env') });

const VIOMI_USERNAME = process.env.VIOMI_USERNAME;
const VIOMI_PASSWORD = process.env.VIOMI_PASSWORD;

// 确保下载目录存在用于存放报错截图
if (!fs.existsSync(envConfig.DOWNLOADS_DIR)) fs.mkdirSync(envConfig.DOWNLOADS_DIR, { recursive: true });

const SOURCE_TABLE_NAME = 'pdd_goods_master';
const TARGET_TABLE_NAME = 'viomi_central_inventory';
const BOM_DICT_TABLE = 'viomi_bom_dict'; 

// ==============================================================================

function getLocalDateString(date) {
    if (!(date instanceof Date) || isNaN(date)) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function askQuestion(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => {
        rl.question(question, (answer) => {
            rl.close();
            resolve();
        });
    });
}

const delay = ms => new Promise(res => setTimeout(res, ms));

// ======================= [步骤1：智能分流 69码 (基座版)] =======================
function getTargetSkuCodesFromDB() {
    console.log(`\n🔍 准备从表 [${SOURCE_TABLE_NAME}] 中提取并分流挂载编码...`);
    let standardCodes = new Set();
    let comboCodes = new Set();
    
    try {
        const db = dbManager.getRawDbInstance(); 
        const stmt = db.prepare(`SELECT DISTINCT out_sku_sn FROM ${SOURCE_TABLE_NAME} WHERE out_sku_sn IS NOT NULL AND out_sku_sn != ''`);
        const rows = stmt.all();
        
        rows.forEach(row => {
            const code = String(row.out_sku_sn).trim();
            if (code.length >= 6) {
                if (code.toUpperCase().startsWith('S')) {
                    comboCodes.add(code);
                } else {
                    standardCodes.add(code);
                }
            }
        });
        
        console.log(`✅ 编码提取完毕：共挂载 ${standardCodes.size} 个单品码，${comboCodes.size} 个组合码 (需拆包)。`);
    } catch (e) {
        console.error(`❌ 从数据库提取 69 码失败: ${e.message}`);
    } 
    
    return { standardCodes: Array.from(standardCodes), comboCodes: Array.from(comboCodes) };
}

// ======================= [核心业务逻辑 (模块化导出)] =======================
/**
 * 模块入口：由 app4 总控传入统一上下文执行
 * @param {import('playwright').BrowserContext} context 
 */
async function run(context) {
    console.log('\n======================================================');
    console.log('--- [模块 02] 启动中央库存查询任务 (搭载 智能排重 与 字典缓存引擎) ---');
    
    if (!VIOMI_USERNAME || !VIOMI_PASSWORD) { 
        console.error('❌ 错误：请检查 .env 文件，未读取到账号密码。'); return; 
    }

    const { standardCodes, comboCodes } = getTargetSkuCodesFromDB();
    if (standardCodes.length === 0 && comboCodes.length === 0) {
        console.log('ℹ️ 未获取到需要查询的编码，任务结束。'); return;
    }

    const db = dbManager.getRawDbInstance();

    // 1. 确保核心表存在，以便后续可以进行读取校验
    db.prepare(`
        CREATE TABLE IF NOT EXISTS ${BOM_DICT_TABLE} (
            combo_code TEXT,      
            sub_code TEXT,        
            require_qty INTEGER,  
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (combo_code, sub_code)
        )
    `).run();

    db.prepare(`
        CREATE TABLE IF NOT EXISTS ${TARGET_TABLE_NAME} (
            查询日期 TEXT, 商品69码 TEXT, 仓库名称 TEXT,
            可用库存 INTEGER, 占用库存 INTEGER, 冻结库存 INTEGER, 
            在途库存 INTEGER, 实物库存 INTEGER, 总库存 INTEGER,
            PRIMARY KEY (查询日期, 商品69码, 仓库名称)
        )
    `).run();

    // ==============================================================
    // 🛡️ 智能排重：检查今日已落盘的数据，实现断点续传与防重复
    // ==============================================================
    const todayStr = getLocalDateString(new Date());
    const syncedRows = db.prepare(`SELECT DISTINCT 商品69码 FROM ${TARGET_TABLE_NAME} WHERE 查询日期 = ?`).all(todayStr);
    const syncedCodes = new Set(syncedRows.map(r => String(r['商品69码']).trim()));

    // 过滤掉今天已经查过的码
    let pendingStandardCodes = standardCodes.filter(c => !syncedCodes.has(c));
    let pendingComboCodes = comboCodes.filter(c => !syncedCodes.has(c));

    if (pendingStandardCodes.length === 0 && pendingComboCodes.length === 0) {
        console.log(`\n✅ 智能拦截：今日挂载的所有商品（${standardCodes.length}个单品, ${comboCodes.length}个组合装）的库存均已同步完毕，无需重复执行查询！`);
        return; // 直接光速结束，不启动浏览器
    }

    console.log(`\n📉 断点过滤完毕：今日已查过 ${syncedCodes.size} 个，剩余需补查 ${pendingStandardCodes.length} 个单品，${pendingComboCodes.length} 个组合码。`);

    // ==============================================================
    // 🧠 缓存检查：在启动浏览器前，先检查本地字典库
    // ==============================================================
    console.log(`\n🧠 正在匹配本地 BOM 组合字典...`);
    const comboMappings = {}; 
    const uncachedComboCodes = []; 
    const queryBomStmt = db.prepare(`SELECT sub_code, require_qty FROM ${BOM_DICT_TABLE} WHERE combo_code = ?`);
    
    // 只处理待查的组合码
    for (const sCode of pendingComboCodes) {
        const bomRows = queryBomStmt.all(sCode);
        if (bomRows.length > 0) {
            comboMappings[sCode] = bomRows.map(r => ({ code: r.sub_code, qty: r.require_qty }));
            bomRows.forEach(r => {
                // 如果子商品今天没查过，且还没放入待查列表，就加进去去查网上的库存
                if (!syncedCodes.has(r.sub_code) && !pendingStandardCodes.includes(r.sub_code)) {
                    pendingStandardCodes.push(r.sub_code);
                }
            });
            console.log(`   ✅ 缓存命中: ${sCode} -> [${bomRows.map(r => `${r.sub_code} x${r.require_qty}`).join(', ')}]`);
        } else {
            uncachedComboCodes.push(sCode);
        }
    }
    
    // 如果只需要进行本地运算组合（比如新增了组合码，但子商品查过了），此时就不需要进网页了
    const needBrowser = (uncachedComboCodes.length > 0 || pendingStandardCodes.length > 0);
    
    let page = null;
    if (needBrowser) {
        page = await context.newPage();
        
        try {
            console.log('➡️ 正在访问云米超级管理系统 (su.viomi.com.cn)...');
            await page.goto('https://su.viomi.com.cn/super/#/home');
            
            const inventoryBtn = page.locator('div.outer').filter({ hasText: '中央库存' });
            const productHubBtn = page.locator('div.outer').filter({ hasText: '商品中台' });
            const loginBtn = page.locator('button:has-text("登录"), button:has-text("登 录")').first();

            console.log('➡️ 智能探测环境状态...');
            try {
                await Promise.race([
                    inventoryBtn.waitFor({ state: 'visible', timeout: 30000 }),
                    loginBtn.waitFor({ state: 'visible', timeout: 30000 })
                ]);
            } catch (e) { }

            if (await loginBtn.isVisible() && !(await inventoryBtn.isVisible())) {
                console.log('⚠️ 遭遇登录墙，执行自动登录...');
                try {
                    const userBox = page.locator('input[placeholder*="账号"], input[type="text"]').first();
                    const passBox = page.locator('input[placeholder*="密码"], input[type="password"]').first();
                    await userBox.fill(VIOMI_USERNAME);
                    await passBox.fill(VIOMI_PASSWORD);
                    await loginBtn.click({ force: true });
                    await inventoryBtn.waitFor({ state: 'visible', timeout: 45000 });
                } catch (e) {
                    console.warn(`⚠️ 自动登录失败: ${e.message}`);
                }
            }

            if (!(await inventoryBtn.isVisible())) {
                console.error('❌ 未找到授权主页入口，退出。');
                return;
            }

            // ==============================================================
            // 阶段一：仅针对【未缓存】的 S 码进入【商品中台】进行拆包
            // ==============================================================
            if (uncachedComboCodes.length > 0) {
                console.log(`\n📦 发现 ${uncachedComboCodes.length} 个未知的组合商品，正在进入【商品中台】进行提取并缓存...`);
                const [hubPage] = await Promise.all([
                    context.waitForEvent('page'),
                    productHubBtn.click({ force: true })
                ]);
                await hubPage.waitForLoadState('networkidle');

                try {
                    await hubPage.locator('text="商品数据"').locator('visible=true').first().click({ force: true });
                    await delay(500);
                    await hubPage.locator('text="组合商品"').locator('visible=true').first().click({ force: true });
                    await delay(2000); 
                } catch(e) {
                    console.warn('⚠️ 左侧菜单被遮挡或加载失败，启动前端路由穿透...');
                    await hubPage.evaluate(() => window.location.hash = '/combineProduct');
                    await delay(2500);
                }

                const insertBomStmt = db.prepare(`INSERT OR REPLACE INTO ${BOM_DICT_TABLE} (combo_code, sub_code, require_qty) VALUES (?, ?, ?)`);

                for (const sCode of uncachedComboCodes) {
                    console.log(`   🪛 正在UI拆解新组合码: ${sCode}`);
                    try {
                        const searchTypeSelect = hubPage.locator('.el-select').first().locator('input.el-input__inner');
                        await searchTypeSelect.click({ force: true });
                        await delay(500); 

                        const option69 = hubPage.locator('li.el-select-dropdown__item').getByText('69码', { exact: true });
                        if (await option69.count() > 0) {
                            await option69.locator('visible=true').first().click({ force: true });
                        } else {
                            await hubPage.locator('li.el-select-dropdown__item').filter({ hasText: '69码' }).locator('visible=true').first().click({ force: true });
                        }
                        
                        const searchInput = hubPage.locator('input[placeholder*="逗号分隔"], input[placeholder*="多个请使用"]').locator('visible=true').first();
                        await searchInput.click({ force: true }); 
                        await searchInput.fill('');
                        await searchInput.fill(sCode);
                        
                        await searchInput.evaluate(node => node.dispatchEvent(new Event('input', { bubbles: true }))); 
                        await searchInput.press('Enter');
                        
                        await hubPage.getByRole('button', { name: /搜.*索/ }).click({ force: true });
                        await delay(1500);

                        const editBtn = hubPage.locator('button:has-text("编辑"), a:has-text("编辑"), span:has-text("编辑")').first();
                        
                        try {
                            await editBtn.waitFor({ state: 'attached', timeout: 5000 });
                            await editBtn.evaluate(node => node.click());
                            console.log('      👉 已通过底层指令弹开编辑页，等待数据渲染...');
                            await delay(2500); 
                        } catch (e) {
                            console.log(`      ⚠️ 未找到 ${sCode} 的编辑入口，可能商品已失效。`);
                            continue;
                        }

                        const subItems = await hubPage.evaluate(() => {
                            const rows = Array.from(document.querySelectorAll('.el-dialog__body .el-table__row, .el-drawer__body .el-table__row, .el-table__body-wrapper .el-table__row'));
                            const results = [];
                            
                            rows.forEach(row => {
                                const cells = row.querySelectorAll('td');
                                if (cells.length >= 5) {
                                    const rawCode = cells[3]?.innerText?.trim() || '';
                                    let rawQty = cells[4]?.innerText?.trim();
                                    if (!rawQty || rawQty === '') rawQty = cells[4]?.querySelector('input')?.value;
                                    
                                    if (rawCode && rawCode.length >= 6) {
                                        results.push({ code: rawCode.replace(/\D/g, ''), qty: parseInt(rawQty) || 1 });
                                    }
                                }
                            });
                            return results;
                        });

                        if (subItems.length > 0) {
                            comboMappings[sCode] = subItems;
                            console.log(`      ✅ 拆解成功！包含子商品: ${subItems.map(s => `[${s.code} x ${s.qty}]`).join(', ')}`);
                            subItems.forEach(item => {
                                // 智能补录：如果这个子码今天没查过，放进列表准备去网上查
                                if (!syncedCodes.has(item.code) && !pendingStandardCodes.includes(item.code)) {
                                    pendingStandardCodes.push(item.code);
                                }
                            });

                            const writeTx = db.transaction(() => {
                                subItems.forEach(item => insertBomStmt.run(sCode, item.code, item.qty));
                            });
                            writeTx();
                            console.log(`      💾 已写入本地字典缓存，下次免查！`);
                        } else {
                            console.log(`      ⚠️ 未能提取到 ${sCode} 的子商品行，请检查弹窗内 DOM 结构。`);
                        }

                        const closeBtn = hubPage.locator('.el-dialog__headerbtn, button:has-text("返回"), button:has-text("取 消")').first();
                        try { if (await closeBtn.count() > 0) await closeBtn.evaluate(node => node.click()); } catch(e) {}
                        await delay(1000);

                    } catch (e) {
                        console.error(`      ❌ 拆解 ${sCode} 失败: ${e.message}`);
                    }
                }
                await hubPage.close().catch(() => {});
            }

            // ==============================================================
            // 阶段二：进入【中央库存】仅查询漏查的普通单品
            // ==============================================================
            if (pendingStandardCodes.length > 0) {
                console.log(`\n🏢 进入【中央库存】，准备查询 ${pendingStandardCodes.length} 个缺漏单品的物理库存...`);
                const [invPage] = await Promise.all([
                    context.waitForEvent('page'),
                    page.locator('div.outer').filter({ hasText: '中央库存' }).click({ force: true })
                ]);
                await invPage.waitForLoadState('networkidle');

                try {
                    await invPage.locator('text="库存管理"').locator('visible=true').first().click({ force: true });
                    await delay(500);
                    await invPage.locator('text="库存查询"').locator('visible=true').first().click({ force: true });
                    await delay(2000);
                } catch (e) {
                    console.warn('⚠️ 左侧菜单被遮挡或加载失败，启动前端路由穿透...');
                    await invPage.evaluate(() => window.location.hash = '/warehouse');
                    await delay(2500);
                }

                global.basicInventoryData = {}; 

                for (const code of pendingStandardCodes) {
                    try {
                        process.stdout.write(`   ➡️ 查库存: ${code} ... `);
                        const inputSelector = 'input[placeholder*="商品69码"]';
                        const sInput = invPage.locator(inputSelector).first();
                        
                        await sInput.click({ force: true });
                        await sInput.fill('');
                        await sInput.fill(code);
                        
                        await sInput.evaluate(node => node.dispatchEvent(new Event('input', { bubbles: true }))); 
                        await sInput.press('Enter');
                        
                        await invPage.locator('button').filter({ hasText: /搜.*索|查.*询/ }).first().click({ force: true });
                        
                        await invPage.waitForSelector('.el-loading-mask', { state: 'hidden', timeout: 6000 }).catch(() => {});
                        await delay(1200);

                        const currentProductData = await invPage.evaluate(() => {
                            const rows = Array.from(document.querySelectorAll('.el-table__body-wrapper .el-table__body tr.el-table__row'));
                            const rawData = rows.map(row => {
                                const cells = row.querySelectorAll('td');
                                const getText = (idx) => cells[idx]?.innerText?.trim() || '0';
                                return {
                                    warehouse: cells[0]?.innerText?.trim() || '', 
                                    available: parseInt(getText(1)) || 0,
                                    occupied: parseInt(getText(2)) || 0,
                                    frozen: parseInt(getText(3)) || 0,
                                    intransit: parseInt(getText(4)) || 0,
                                    physical: parseInt(getText(5)) || 0,
                                    total: parseInt(getText(6)) || 0
                                };
                            });
                            return rawData.filter(item => item.warehouse !== '生产调试共享仓（请勿动）');
                        });

                        if (currentProductData.length > 0) {
                            global.basicInventoryData[code] = currentProductData;
                            console.log(`✅ [有货] (${currentProductData.length}个仓)`);
                        } else {
                            console.log(`⚠️ [无货/检索失败]`);
                        }
                    } catch (err) {
                        console.log(`❌ [异常结束] ${err.message}`);
                    }
                }
                await invPage.close().catch(() => {});
            }

        } catch (error) {
            console.error('❌ [模块 02] 网页操作时发生致命崩溃:', error.message);
            const errorScreenshot = path.join(envConfig.DOWNLOADS_DIR, `Crash_App02_${Date.now()}.png`);
            await page.screenshot({ path: errorScreenshot, fullPage: true }).catch(() => {});
            console.log(`📸 致命崩溃截图已保留至: ${errorScreenshot}`);
            return; // 网页操作崩溃了就不再进行下面入库了
        }
    } else {
        // 如果不需要走浏览器，依然要初始化一下这个全局变量用于存放库存供后续计算
        global.basicInventoryData = {};
    }

    // ==============================================================
    // 阶段三：木桶效应核算与数据库持久化 (缝合本地数据)
    // ==============================================================
    try {
        console.log(`\n🧠 开始进行 BOM 木桶运算及数据库落盘...`);
        const insertStmt = db.prepare(`
            INSERT OR REPLACE INTO ${TARGET_TABLE_NAME} 
            (查询日期, 商品69码, 仓库名称, 可用库存, 占用库存, 冻结库存, 在途库存, 实物库存, 总库存)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        let finalInsertCount = 0;

        const transaction = db.transaction(() => {
            // 1. 写入今天网上刚拉下来的普通单品库存
            if (global.basicInventoryData) {
                for (const [code, whList] of Object.entries(global.basicInventoryData)) {
                    whList.forEach(wh => {
                        insertStmt.run(todayStr, code, wh.warehouse, wh.available, wh.occupied, wh.frozen, wh.intransit, wh.physical, wh.total);
                        finalInsertCount++;
                    });
                }
            }

            // 2. 计算待查组合商品的库存
            for (const [sCode, subItems] of Object.entries(comboMappings)) {
                let minComboAvailable = 999999;
                let minComboPhysical = 999999;

                for (const item of subItems) {
                    const requiredQty = item.qty;
                    const childCode = item.code;
                    let childTotalAvailable = 0;
                    let childTotalPhysical = 0;
                    
                    // 【缝合黑科技】：如果这趟没有去网上抓这个子件，说明它今天已经被查过落盘了，直接从本地 SQLite 读！
                    if (!global.basicInventoryData[childCode]) {
                        const localDbData = db.prepare(`SELECT 仓库名称, 可用库存, 实物库存 FROM ${TARGET_TABLE_NAME} WHERE 商品69码 = ? AND 查询日期 = ?`).all(childCode, todayStr);
                        if (localDbData.length > 0) {
                            global.basicInventoryData[childCode] = localDbData.map(r => ({
                                warehouse: r['仓库名称'],
                                available: r['可用库存'],
                                physical: r['实物库存']
                            }));
                        }
                    }

                    if (global.basicInventoryData[childCode]) {
                        global.basicInventoryData[childCode].forEach(wh => {
                            childTotalAvailable += wh.available;
                            childTotalPhysical += wh.physical;
                        });
                    }
                    
                    const supportComboAvailable = Math.floor(childTotalAvailable / requiredQty);
                    const supportComboPhysical = Math.floor(childTotalPhysical / requiredQty);
                    
                    if (supportComboAvailable < minComboAvailable) minComboAvailable = supportComboAvailable;
                    if (supportComboPhysical < minComboPhysical) minComboPhysical = supportComboPhysical;
                }

                if (minComboAvailable === 999999) minComboAvailable = 0;
                if (minComboPhysical === 999999) minComboPhysical = 0;

                insertStmt.run(
                    todayStr, 
                    sCode, 
                    '虚拟组合运算仓', 
                    minComboAvailable, 
                    0, 0, 0, 
                    minComboPhysical, 
                    minComboAvailable
                );
                finalInsertCount++;
                console.log(`   🔗 组合核算入库: ${sCode} -> 理论可卖：${minComboAvailable} 套 (实物支撑：${minComboPhysical} 套)`);
            }
        });

        transaction();
        
        if (finalInsertCount > 0) {
            console.log(`\n🎉 增量同步完毕！共向中央库存表追加了 ${finalInsertCount} 条新记录。`);
        }
    } catch(err) {
        console.error('❌ [模块 02] 数据落盘时发生崩溃:', err.message);
    } finally {
        if (page && !page.isClosed()) await page.close().catch(() => {});
        console.log('🔚 模块 02 执行节点结束。');
    }
}

module.exports = { run };