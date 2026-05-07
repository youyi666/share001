// App3_Store_Operations/04-Price_Guard.cjs
// 【架构升级】：接入基座数据库调度，剥离硬编码，规范后台日志输出

const path = require('path');
const fs = require('fs');
const readline = require('readline');

// ======================= [增量模块：引入底层公共基座] =======================
const dbManager = require('../00_Core_Infrastructure/db_manager.cjs');

// ======================= [全局配置区域] =======================
const STRATEGY = 'conservative';
const MAX_PRICE_DROP_LIMIT = 0.3; 

// ======================= [辅助函数] =======================

/**
 * 异常日志持久化写入 CSV (按店铺隔离)
 */
function logErrorToCSV(storeName, id, name, errorMsg) {
    const time = new Date().toLocaleString();
    const safeName = name ? name.replace(/,/g, ' ') : '未知'; 
    const safeError = errorMsg.replace(/,/g, ' ').replace(/\n/g, ' ');
    const row = `"${storeName}","${time}","${id}","${safeName}","${safeError}"\n`;
    
    const ERROR_CSV_PATH = path.join(__dirname, `error_tasks_${storeName}.csv`);
    if (!fs.existsSync(ERROR_CSV_PATH)) {
        fs.writeFileSync(ERROR_CSV_PATH, '\uFEFF"店铺","时间","商品ID","商品名称","失败原因"\n');
    }
    fs.appendFileSync(ERROR_CSV_PATH, row);
}

/**
 * 成功调价持久化写入 CSV (按店铺隔离)
 */
// 【增量修改】：函数签名末尾新增 rivalPlatform 和 rivalTarget，并赋予默认值防错
function logSuccessToCSV(storeName, id, name, oldPrice, newPrice, rivalPrice, limitPrice, strategyUsed, rivalPlatform = '未知', rivalTarget = '未知') {
    const time = new Date().toLocaleString();
    const safeName = name ? name.replace(/,/g, ' ') : '未知';
    
    // 【增量修改】：保留原有文案，仅在末尾平滑追加平台和目标信息
    const basis = `竞对极低价:${rivalPrice} | 设定的底线价:${limitPrice} | 采用策略:${strategyUsed} | 跟价平台:${rivalPlatform} | 跟价目标:${rivalTarget}`;
    
    const row = `"${storeName}","${time}","${id}","${safeName}","${oldPrice}","${newPrice}","${basis}"\n`;
    
    const SUCCESS_CSV_PATH = path.join(__dirname, `success_tasks_${storeName}.csv`);
    if (!fs.existsSync(SUCCESS_CSV_PATH)) {
        fs.writeFileSync(SUCCESS_CSV_PATH, '\uFEFF"店铺","执行时间","商品ID","商品名称","改前线上价","修改后价格","调价依据"\n');
    }
    fs.appendFileSync(SUCCESS_CSV_PATH, row);
}

// 终端交互：降价幅度过大时人工确认
function askConfirmation(message) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(`\x1b[41m\x1b[37m ⚠️ ${message} \x1b[0m (y/n): `, answer => {
        rl.close();
        resolve(answer.toLowerCase() === 'y');
    }));
}

function calculateProposedPrice(rivalPrice, strategy) {
    if (strategy === 'aggressive') return (rivalPrice - 0.01).toFixed(2);
    if (strategy === 'equal') return rivalPrice.toFixed(2);
    return (Math.floor(rivalPrice / 10) * 10 + 9).toFixed(2);
}

/**
 * 拼多多专用的强力关闭弹窗工具
 */
async function tryClosePopups(page) {
    const closeSelectors = [
        '[data-testid="beast-core-modal-icon-close"]',
        '.beast-core-modal-close',
        'button:has-text("知道了")',
        'button:has-text("关闭")',
        '.ant-modal-close'
    ];
    for (const selector of closeSelectors) {
        try {
            const btn = page.locator(selector).first();
            if (await btn.isVisible({ timeout: 500 })) {
                console.log(` -> 🛡️ 发现弹窗遮罩，尝试关闭...`);
                await btn.click({ force: true });
                await page.waitForTimeout(300);
            }
        } catch (e) {}
    }
}

// ======================= [核心业务：促销活动配置] =======================
async function configureActivityPage(page1, targetPriceStr, isPriceMatch, startDateObj = new Date()) {
    const startDayStr = startDateObj.getDate().toString();
    const endDateObj = new Date(startDateObj);
    endDateObj.setDate(startDateObj.getDate() + 6);
    const endDayStr = endDateObj.getDate().toString();
    const isCrossMonth = startDateObj.getMonth() !== endDateObj.getMonth();

    try {
        const datePicker = page1.getByTestId('beast-core-rangePicker-htmlInput');
        const hasDatePicker = await datePicker.isVisible({ timeout: 1500 }).catch(() => false);

        if (hasDatePicker) {
            console.log(` -> 📅 检测到【限时促销】，正在精准配置：今日起 7 天 (${startDayStr}号 至 ${endDayStr}号)...`);
            await datePicker.click({ force: true });
            await page1.waitForTimeout(500);

            const dropDownRoot = page1.getByTestId('beast-core-rangePicker-dropdown-contentRoot');

            // 🔧 [核心防爆逻辑]: 启发式精准点击算法，彻底解决多月重叠导致的超期报错
            async function clickDateCell(panel, dayStr) {
                const cells = panel.getByText(dayStr, { exact: true });
                const dayNum = parseInt(dayStr, 10);
                // 大于15号一定在日历下方，取 last() 避开上个月的置灰项
                // 小于等于15号一定在日历上方，取 first() 避开下个月的置灰项
                if (dayNum > 15) {
                    await cells.last().click({ force: true });
                } else {
                    await cells.first().click({ force: true });
                }
                await page1.waitForTimeout(400);
            }

            // 获取左右日历面板 (拼多多标准弹窗通常包含本月和下个月两个面板)
            const panels = dropDownRoot.locator('.beast-core-rangePicker-panel');
            const panelCount = await panels.count();
            
            let leftPanel = dropDownRoot;
            let rightPanel = dropDownRoot;
            if (panelCount >= 2) {
                leftPanel = panels.nth(0);
                rightPanel = panels.nth(1);
            }

            // 1. 开始日期：永远点击左侧(本月)面板
            await clickDateCell(leftPanel, startDayStr);

            // 2. 结束日期：跨月点右面板，同月点左面板 (废弃极易出错的翻页按钮逻辑)
            if (isCrossMonth) {
                console.log(` -> ⚠️ 促销期跨月，锁定右侧(下月)面板点击 ${endDayStr}号...`);
                await clickDateCell(rightPanel, endDayStr);
            } else {
                await clickDateCell(leftPanel, endDayStr);
            }

            const confirmBtn = dropDownRoot.getByRole('button', { name: '确认' });
            await confirmBtn.click({ force: true });
            console.log(' -> ✅ 7天有效日期范围配置已完美提交。');
            await page1.waitForTimeout(500);

        } else {
            console.log(' -> 📦 检测到【限量促销】(无日期输入框)，跳过时间配置...');
        }
    } catch (error) {
        console.error(' -> ❌ 日期配置环节发生异常:', error.message);
        const errorImagePath = `error_datepicker_crash_${Date.now()}.png`;
        try {
            await page1.screenshot({ path: errorImagePath, fullPage: true });
            console.log(` -> 📸 现场已保存至截图: ${errorImagePath}`);
        } catch (imgErr) {}
    }

    if (!isPriceMatch) {
        console.log(` -> 🔄 切换模式并注入目标价格: ${targetPriceStr}`);
        await page1.getByTestId('beast-core-table-header-tr').getByTestId('beast-core-icon-down').click();
        await page1.locator('[data-testid="beast-core-portal"]').getByText('活动价(元)', { exact: true }).click();
        await page1.waitForTimeout(800);
        
        const priceInput = page1.getByTestId('beast-core-table-body-tr').getByTestId('beast-core-inputNumber-htmlInput');
        await priceInput.click({ force: true });
        await priceInput.fill(targetPriceStr);
        
        // 底层数据双向绑定事件注入，防止页面值和 React 内部状态脱节
        await priceInput.evaluate(node => {
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
            node.dispatchEvent(new Event('blur', { bubbles: true }));
        });
        await page1.keyboard.press('Tab');
        await page1.waitForTimeout(800);

        const errorLocator = page1.locator('div[class*="Message_error"]').filter({ hasText: /建议优惠区间参考/ }).first();
        const fallbackLocator = page1.locator('text=/建议优惠区间参考/').first();

        if (await errorLocator.isVisible() || await fallbackLocator.isVisible()) {
            const errorText = await (await errorLocator.isVisible() ? errorLocator : fallbackLocator).innerText();
            throw new Error(`平台红线拦截 - ${errorText.trim()}`);
        }
        
        try {
            console.log('   🕵️ [安全校验] 检查附加折扣勾选状态...');
            const checkedIcon = page1.locator('#surpriseCouponCheck').getByTestId('beast-core-icon-check').first();
            if (await checkedIcon.isVisible({ timeout: 1500 })) {
                console.log('   ⚠️ [安全拦截] 检测到默认勾选“额外95折”，正在取消勾选...');
                await checkedIcon.click({ force: true });
                await page1.waitForTimeout(500);
                
                if (!await checkedIcon.isVisible({ timeout: 500 })) {
                    console.log('   ✅ “额外95折”已成功取消。');
                } else {
                    console.log('   ⚠️ 取消动作未生效，请后续核查。');
                }
            } else {
                console.log('   🛡️ 状态安全：“额外95折”未勾选。');
            }
        } catch (e) {
            console.log(`   ⚠️ [警告] 扫描“额外95折”时发生异常，跳过检查: ${e.message}`);
        }
    }

    await page1.getByRole('button', { name: '创建' }).click({ force: true });
    await page1.waitForTimeout(1000);
    const postClickError = page1.locator('div[class*="Message_error"]').filter({ hasText: /建议优惠区间参考/ }).first();
    if (await postClickError.isVisible()) {
        const postErrorText = await postClickError.innerText();
        throw new Error(`创建失败，触发平台规则 - ${postErrorText.trim()}`);
    }
}

// ======================= [核心业务控制流] =======================
async function runPriceChangeTask(page, storeName) {
    console.log(`\n🚀 --- 价格监控与自动调价模块 - 当前店铺: ${storeName} ---`);
    const db = dbManager.getRawDbInstance();
    if (!db) throw new Error("🚨 无法获取基座数据库实例");

    // 🔧 [增量模块] 建立 店铺名 与 数据库 Platform 标识的映射字典
    const storeToPlatformMap = {
        '云米拼多多官方旗舰店': '拼多多',
        '云米拼多多专卖店_新店': '拼多多2'
    };
    // 自动翻译：拿不到就默认兜底为 '拼多多'
    const targetDbPlatform = storeToPlatformMap[storeName] || '拼多多';
    console.log(`   🔗 矩阵路由已匹配: [${storeName}] -> 对应数据库标识 [${targetDbPlatform}]`);

    const today = new Date();
    // 🔧 [核心修正] 仅提取属于当前 targetDbPlatform 的商品，防止跨店提取
    // 【增量修改】：在 SELECT 语句中新增 status 字段，以便读取上游打标状态
    // 🔧 [终极桥梁构建] 仅提取本店商品，并通过 platform_sku_id 跨表关联 pdd_goods_master，提取权威 69 码
    const pddProducts = db.prepare(`
        SELECT DISTINCT 
            ph.true_sku_id, 
            ph.platform_sku_id, 
            ph.product_name, 
            ph.status,
            pm.out_sku_sn as barcode_69  -- 🌟 核心：从总表提取 69 码作为比价桥梁
        FROM price_history ph
        LEFT JOIN pdd_goods_master pm ON ph.platform_sku_id = pm.sku_id
        WHERE ph.platform = ? 
        AND ph.record_time LIKE (
            SELECT substr(MAX(record_time), 1, 10) || '%' 
            FROM price_history 
            WHERE platform = ?
        )
    `).all(targetDbPlatform, targetDbPlatform);
    console.log(`   📊 [数据准备] 本店共有 ${pddProducts.length} 个待核准商品。`);

    const mappingCheckMap = {};
    for (const product of pddProducts) {
        if (!mappingCheckMap[product.true_sku_id]) {
            mappingCheckMap[product.true_sku_id] = new Set();
        }
        // 使用真正的 69 码进行合规性校验
        if (product.barcode_69) {
            mappingCheckMap[product.true_sku_id].add(product.barcode_69);
        }
    }

    try {
        await page.goto('https://mms.pinduoduo.com/tool/promotion?tool_full_channel=10921_77271', { waitUntil: 'domcontentloaded' });
        if (page.url().includes('login')) {
            console.log(` -> 🔑 [${storeName}] 等待完成登录校验...`);
            await page.waitForURL(url => !url.href.includes('login'), { timeout: 300000 });
        }

        for (const product of pddProducts) {
            try {
                const goodsId = product.true_sku_id;
                console.log(`\n🔎 [检测中] ${product.product_name || '未知'} (ID: ${goodsId})`);
                
                // ======================= [增量模块：数据库状态前置拦截] =======================
                // 比照数据库 status 列，若包含百亿补贴等高优活动则安全跳过，防止误操作
                if (product.status && product.status.includes('百亿补贴')) {
                    console.log(`   🛑 [保护机制] 检测到数据库状态为【${product.status}】，涉及百亿补贴，放弃 UI 交互，安全跳过。`);
                    continue; 
                }
                // ============================================================================
                
                // SKUs 映射合规性校验
                if (mappingCheckMap[product.true_sku_id].size > 1) {
                    const conflictSkus = Array.from(mappingCheckMap[product.true_sku_id]).join(', ');
                    throw new Error(`[映射异常] 该系统商品绑定了多个抓取条码 (${conflictSkus})，存在乱价风险，停止调价。`);
                }

                // ======================= [增量修改：跨平台跟价隔离逻辑] =======================
                // ======================= [增量修改：跨平台跟价隔离逻辑] =======================
                // ======================= [增量修改：跨平台跟价隔离逻辑] =======================
                // ======================= [增量修改：跨平台跟价隔离逻辑] =======================
                // 提取当前店铺的基础平台名称
                const basePlatform = targetDbPlatform.replace(/[0-9]+$/, '');
                
                // 🛑 [桥梁校验] 如果该商品在总表里没找到对应的 69 码，直接跳过，防止乱查
                if (!product.barcode_69 || product.barcode_69.trim() === '') {
                    console.log(`   ⚠️ 无法在总表中找到 platform_sku_id[${product.platform_sku_id}] 映射的 69 码(out_sku_sn)，跳过跟价。`);
                    continue;
                }

                // 🔧 [彻底修复] 使用翻译出的 69 码 (barcode_69) 去匹配京东等平台的 sku_id！
                const rival = db.prepare(`
                    SELECT price as min_price, limit_price, platform, product_name, url 
                    FROM price_history 
                    WHERE sku_id = ? 
                    AND platform NOT LIKE ? 
                    AND price > 100 
                    AND record_time LIKE (
                        SELECT substr(MAX(record_time), 1, 10) || '%' 
                        FROM price_history 
                        WHERE sku_id = ? 
                        AND platform NOT LIKE ?
                        AND price > 100  
                    )
                    ORDER BY price ASC 
                    LIMIT 1
                `).get(product.barcode_69, `${basePlatform}%`, product.barcode_69, `${basePlatform}%`);
                // ==============================================================================

                // 判断逻辑与执行 continue
                if (!rival?.min_price) { 
                    console.log(`   ⏭️  24h内无有效竞对价格比对基准，跳过。`);
                    continue; 
                }

                const proposedPriceStr = calculateProposedPrice(rival.min_price, STRATEGY);
                const proposedPriceNum = parseFloat(proposedPriceStr);
                const limitPrice = rival.limit_price || 0;
                
                if (limitPrice > 0 && (limitPrice - proposedPriceNum) / limitPrice > MAX_PRICE_DROP_LIMIT) {
                    const drop = (((limitPrice - proposedPriceNum) / limitPrice) * 100).toFixed(1);
                    // 注意：在全自动化且无终端交互的服务器环境中，若需彻底无人值守，建议移除 askConfirmation
                    if (!await askConfirmation(`[${storeName}] 降价幅度(${drop}%)超过设定阈值！是否继续执行调价？`)) continue;
                }

                await tryClosePopups(page);

                const searchInput = page.locator('input[data-testid="beast-core-input-htmlInput"]').filter({ hasNot: page.locator('#usernameId') }).and(page.locator('[placeholder*="ID"]')).first();
                await searchInput.fill(''); 
                await searchInput.fill(goodsId);
                
                console.log('   📡 正在向服务器发送查询请求，等待底层数据返回...');
                const [queryResponse] = await Promise.all([
                    page.waitForResponse(res => res.url().includes('/libra-backend/mms/activity/marketing/query') && res.status() === 200, { timeout: 10000 }),
                    page.getByText('查询', { exact: true }).click()
                ]);
                
                const queryData = await queryResponse.json();
                const activityList = queryData?.result?.marketing_activity_list || [];
                if (activityList.length > 0) {
                    console.log(`   📦 [接口数据] 获取到历史活动记录:`, JSON.stringify(activityList[0]).substring(0, 150) + '...');
                }

                await page.waitForTimeout(300);
                
                let firstRow = page.locator('tr[data-testid="beast-core-table-body-tr"]').first();
                let needCreateFromScratch = false;
                let currentPriceNum = 0;
                
                if (!await firstRow.isVisible()) { 
                    console.log(`   💡 未匹配到历史活动，开始新建流程...`);
                    needCreateFromScratch = true;
                } else {
                    const headers = await page.locator('[data-testid="beast-core-table-header-tr"]').first().locator('th').allInnerTexts();
                    const priceIdx = headers.findIndex(t => t.includes('活动价(元)'));
                    const actionIdx = headers.findIndex(t => t.includes('操作'));

                    let rawPrice = await firstRow.locator('td').nth(priceIdx).innerText();
                    currentPriceNum = parseFloat(rawPrice.match(/\d+\.\d+/)?.[0] || "0");
                    let actionCell = firstRow.locator('td').nth(actionIdx);

                    const isOngoing = await actionCell.locator('a', { hasText: '结束' }).isVisible();
                    if (isOngoing && currentPriceNum > proposedPriceNum) {
                        console.log(`   📉 线上价格需调整，正在结束旧活动...`);
                        await actionCell.locator('a', { hasText: '结束' }).click({ force: true });
                        await page.locator('button:has-text("确认结束"), .beast-core-modal-footer button').first().click({ force: true });
                        await page.locator('a:has-text("直接结束")').click({ force: true });
                        await page.waitForTimeout(3000);
                        
                        console.log(`   ✅ 旧活动已结束，准备创建新活动...`);
                        needCreateFromScratch = true;
                    } else if (isOngoing && currentPriceNum <= proposedPriceNum) {
                        console.log(`   🛡️ 当前线上价格符合策略要求，跳过。`);
                    } else if (!isOngoing) {
                        console.log(`   💡 历史活动已失效，准备创建新活动...`);
                        needCreateFromScratch = true;
                    }
                }

                if (needCreateFromScratch) {
                    console.log('   🛠️ 启动【限时促销】标准配置流程...');
                    await page.getByRole('button', { name: '立即创建' }).first().click({ force: true });
                    
                    const promoRadio = page.locator('label').filter({ hasText: '限时促销在规定时间内对商品进行打折销售，时间结束后恢复原价' }).first();
                    await promoRadio.waitFor({ state: 'visible', timeout: 15000 });
                    await promoRadio.getByTestId('beast-core-icon-radio-circle_filled').click({ force: true });
                    await page.waitForTimeout(500);
                    
                    await page.getByRole('button', { name: '选择商品' }).first().click({ force: true });
                    await page.waitForTimeout(1000); 
                    
                    console.log('   🔍 正在弹窗中搜寻指定商品...');
                    const modalSearchInput = page.getByTestId('beast-core-modal-body').getByTestId('beast-core-input-htmlInput').first();
                    await modalSearchInput.waitFor({ state: 'visible', timeout: 10000 });
                    await modalSearchInput.click({ force: true });
                    await modalSearchInput.fill(goodsId);
                    
                    const modalSearchBtn = page.getByText('查询', { exact: true }).first();
                    await modalSearchBtn.click({ force: true });
                    await page.waitForTimeout(2000); 

                    console.log('   🖱️ 选中目标商品...');
                    const checkIcon = page.getByTestId('beast-core-table-body-tr').first().getByTestId('beast-core-icon-check').first();
                    await checkIcon.waitFor({ state: 'visible', timeout: 10000 });
                    await checkIcon.click({ force: true }); 
                    await page.waitForTimeout(500);
                    
                    await page.getByRole('button', { name: '确认选择' }).first().click({ force: true });
                    await page.waitForTimeout(1500);
                    
                    await configureActivityPage(page, proposedPriceStr, false, today);
                    console.log(`   ✨ 商品 ID ${goodsId} 价格变更指令执行完毕。`);
                    
                    const oldPriceRecord = currentPriceNum > 0 ? currentPriceNum : '无活动/新上架';
                    
                    // 【增量修改】：在原函数调用末尾追加传入平台与目标标识
                    logSuccessToCSV(
                        storeName, 
                        goodsId, 
                        product.product_name, 
                        oldPriceRecord, 
                        proposedPriceStr, 
                        rival.min_price, 
                        rival.limit_price || '未设置',
                        STRATEGY,
                        rival.platform,                               // 新增：竞对平台
                        rival.url || rival.product_name || '未知ID'   // 新增：竞对链接或名称作为目标标识
                    );
                    console.log(`   📝 [操作日志] 变更记录已归档至 success_tasks_${storeName}.csv`);
                    console.log(`   🔙 返回活动列表主页面...`);
                    
                    try {
                        const successCloseBtn = page.getByTestId('beast-core-modal-inner').getByTestId('beast-core-button').first();
                        if (await successCloseBtn.isVisible({ timeout: 2000 })) {
                            await successCloseBtn.click({ force: true });
                        }
                    } catch(e) {}

                    await page.waitForTimeout(1000);
                    await page.goto('https://mms.pinduoduo.com/tool/promotion?tool_full_channel=10921_77271', { waitUntil: 'domcontentloaded' });
                    await page.waitForTimeout(2000);
                }

                if (page.url().includes('tool_full_channel=10921_77271')) {
                    console.log('   🧹 清理页面临时状态...');
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(500);
                    const leftoverPopup = page.locator('[data-testid="beast-core-modal-icon-close"], .beast-core-modal-close, button:has-text("取消"), button:has-text("关闭")').filter({ visible: true }).first();
                    if (await leftoverPopup.isVisible()) {
                        await leftoverPopup.click({ force: true });
                        await page.waitForTimeout(500);
                    }
                }

            } catch (itemError) {
                const errMsg = itemError.message.slice(0, 100);
                console.error(`   ⚠️ [单品调价中断] 跳过 ID: ${product.true_sku_id} | 原因: ${errMsg}`);
                
                logErrorToCSV(storeName, product.true_sku_id, product.product_name, errMsg);
                
                const allPages = page.context().pages();
                if (allPages.length > 1) {
                    await allPages[allPages.length - 1].close();
                    await page.bringToFront();
                }

                console.log('   🚨 [异常防御] 流程阻塞，正在重置页面状态...');
                try {
                    await page.goto('https://mms.pinduoduo.com/tool/promotion?tool_full_channel=10921_77271', { 
                        waitUntil: 'domcontentloaded', 
                        timeout: 30000 
                    });
                    await page.waitForTimeout(2500);
                    console.log('   ✅ [状态重置] 页面恢复响应，继续后续任务。');
                } catch (gotoError) {
                    console.error(`   ❌ [重置失败] 跳转超时: ${gotoError.message}，尝试刷新页面...`);
                    await page.reload({ waitUntil: 'domcontentloaded' });
                    await page.waitForTimeout(3000);
                }
            }
        } // 循环结束
    } catch (globalError) {
        console.error(`❌ 全局运行异常: ${globalError.message}`);
        throw globalError;
    } finally {
        // ⚠️ 严格遵守 Monorepo 规范：不能执行 db.close()
        console.log(`\n🎊 --- 批量调价引擎运行结束 [${storeName}] ---`);
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
        throw new Error("🚨 [App3_PriceGuard] 缺少必要参数: storeName");
    }
    
    const { storeName } = params;
    console.log(`\n🚀 [App3_PriceGuard] 接收到总控指令，开始执行【${storeName}】的价格自动化核准...`);
    
    // 调度核心处理函数
    await runPriceChangeTask(page, storeName);
}

module.exports = {
    startApp
};