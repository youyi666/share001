// 01-API_Network_Probe.cjs (或 05-Viomi_Sales_TOP20_Sniper_Ultimate.cjs)
// 【v27 - 总控调度接入版】(全量商品解限 + 数据净洗 + 模块化导出)
// 
// 架构升级日志：
// 1. 解决手工构造 Payload 导致服务器返回空字符串的 Schema 校验失败问题。
// 2. 引入“首单 UI 劫持 + 后续 API 克隆”的终极混合驱动机制。
// 3. 加入分页限制自动破解模块，将原 Top20 静态参数动态替换为全量数据拉取。
// 4. 加入 UI 失败时增加容错日志与截图。
// 5. 移除反爬虫特征隐藏模块（解决内部系统页面不加载问题），并在入库前增加双空数据过滤逻辑。
// 6. 【增量迭代】重构为主控调度模块，暴露 run(browserContext) 接口，剥离浏览器生命周期管理。

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const ENV_CONFIG = require('../00_Core_Infrastructure/env_config.cjs');
require('dotenv').config({ path: path.join(ENV_CONFIG.ROOT, '.env') });

const VIOMI_USERNAME = process.env.VIOMI_USERNAME;
const VIOMI_PASSWORD = process.env.VIOMI_PASSWORD;

const DATABASE_PATH = ENV_CONFIG.DATABASE_PATH;
const TARGET_PLATFORMS = ['京东', '天猫', '拼多多', '有品']; 
const LOOKBACK_DAYS = 2; 

// ======================= [基座：数据库与任务] =======================
function initDatabase() {
    const dbDir = path.dirname(DATABASE_PATH);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(DATABASE_PATH);
    db.exec(`
        CREATE TABLE IF NOT EXISTS sales_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            record_date TEXT, platform TEXT, sku_id TEXT, product_name TEXT, category TEXT, barcode TEXT, 
            visitor_count INTEGER, page_views INTEGER, favorites INTEGER, 
            order_buyers INTEGER, order_items INTEGER, order_amount REAL, 
            sales_volume INTEGER, sales_users INTEGER, sales_amount REAL, 
            cart_items INTEGER, cart_users INTEGER, aov REAL, conversion_rate REAL, 
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(record_date, platform, sku_id) ON CONFLICT REPLACE
        )
    `);
    db.close();
}

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getMissingTasks() {
    console.log(`\n--- 步骤 A: 计算最近 ${LOOKBACK_DAYS} 天任务 ---`);
    const db = new Database(DATABASE_PATH);
    const existing = new Set();
    try {
        const rows = db.prepare("SELECT DISTINCT record_date, platform FROM sales_history").all();
        rows.forEach(r => existing.add(`${r.record_date}|${r.platform}`));
    } catch (e) {}
    db.close();

    const tasks = [];
    const today = new Date();
    for (let i = 1; i <= LOOKBACK_DAYS; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const dateStr = formatDate(d);
        for (const platform of TARGET_PLATFORMS) {
            if (!existing.has(`${dateStr}|${platform}`)) {
                tasks.push({ date: dateStr, platform: platform });
            }
        }
    }
    tasks.sort((a, b) => a.date.localeCompare(b.date) || TARGET_PLATFORMS.indexOf(a.platform) - TARGET_PLATFORMS.indexOf(b.platform));
    console.log(`   📉 待抓取: ${tasks.length} 个任务`);
    return tasks;
}

function importJSONToDB(dataArray, dateStr, platformName) {
    if (!dataArray || dataArray.length === 0) {
        console.warn(`      ⚠️ 无有效数据可入库。`);
        return;
    }
    const db = new Database(DATABASE_PATH);
    const insertStmt = db.prepare(`
        INSERT OR REPLACE INTO sales_history 
        (record_date, platform, sku_id, product_name, category, barcode, 
         visitor_count, page_views, favorites, order_buyers, order_items, order_amount,
         sales_volume, sales_users, sales_amount, cart_items, cart_users, aov, conversion_rate)
        VALUES (@date, @plat, @sku, @name, @cat, @bc, 
                @uv, @pv, @fav, @ob, @oi, @oa, @sv, @su, @sa, @ci, @cu, @aov, @rate)
    `);

    const transaction = db.transaction((rows) => {
        let insertCount = 0;
        let skipCount = 0;
        
        for (const row of rows) {
            const cleanInt = (v) => parseInt(v) || 0;
            const cleanFloat = (v) => parseFloat(v) || 0.0;
            const cleanStr = (v) => String(v || '').trim();
            const record = {
                date: dateStr, plat: platformName,
                sku: cleanStr(row['平台商品id']), name: cleanStr(row['组合商品名称']),
                cat: cleanStr(row['组合产品公司']), bc: cleanStr(row['组合69码']), 
                uv: cleanInt(row['sum(访客数)']), pv: cleanInt(row['sum(浏览量)']),
                fav: cleanInt(row['sum(商品收藏人数)']), ob: cleanInt(row['sum(下单买家数)']),
                oi: cleanInt(row['sum(下单件数)']), oa: cleanFloat(row['sum(下单金额)']),
                sv: cleanInt(row['sum(支付数量)']), su: cleanInt(row['sum(支付用户数)']),
                sa: cleanFloat(row['sum(支付金额)']), ci: cleanInt(row['sum(加购件数)']),
                cu: cleanInt(row['sum(加购人数)']), aov: cleanFloat(row['sum(总客单价)']),
                rate: cleanFloat(row['sum(支付转化)'])
            };
            
            // 无效数据过滤
            if (record.uv === 0 && record.sa === 0.0) {
                skipCount++;
                continue;
            }

            if (record.sku) {
                insertStmt.run(record);
                insertCount++;
            }
        }
        return { insertCount, skipCount };
    });

    const result = transaction(dataArray);
    db.close();
    console.log(`      ✅ 数据入库完成: [${dateStr}] [${platformName}] 成功写入 ${result.insertCount} 条，过滤双空无效数据 ${result.skipCount} 条。`);
}

// ======================= [核心战术一：UI 动作与完美模板窃取] =======================
async function uiActionAndStealTemplate(page, dateStr, platformName) {
    try {
        console.log(`      ⚙️ [UI模式] 设置筛选并窃取底层报文: ${dateStr} ${platformName}`);
        
        const startDatePicker = page.locator('div.ant-picker').first();
        const startClearButton = startDatePicker.locator('span.ant-picker-clear');
        if (await startClearButton.isVisible({ timeout: 2000 })) await startClearButton.click(); 
        await startDatePicker.locator('input').click();
        await page.locator('div.ant-picker-panel:visible').waitFor();
        await startDatePicker.locator('input').fill(dateStr);
        await page.locator('div.ant-picker-panel:visible').locator(`td[title="${dateStr}"]`).click();
        await page.locator('div.ant-picker-panel:visible').waitFor({ state: 'hidden' });

        const endDatePicker = page.locator('div.ant-picker').nth(1);
        const endClearButton = endDatePicker.locator('span.ant-picker-clear');
        if (await endClearButton.isVisible({ timeout: 2000 })) await endClearButton.click(); 
        await endDatePicker.locator('input').click();
        await page.locator('div.ant-picker-panel:visible').waitFor();
        await endDatePicker.locator('input').fill(dateStr);
        await page.locator('div.ant-picker-panel:visible').locator(`td[title="${dateStr}"]`).click();
        await page.locator('div.ant-picker-panel:visible').waitFor({ state: 'hidden' });

        const selector = page.locator('.ant-select-selector').first();
        const removeIcons = page.locator('.ant-select-selection-item-remove');
        while (await removeIcons.count() > 0) { 
            await removeIcons.first().click(); 
            await page.waitForTimeout(50);
        }
        await selector.click();
        await page.keyboard.type(platformName, { delay: 100 });
        await page.waitForTimeout(800); 
        await page.locator(`.ant-select-item-option-content:has-text("${platformName}")`).first().click();
        await page.keyboard.press('Escape'); 

        const apiResPromise = page.waitForResponse(async res => {
            const req = res.request();
            if (res.url().includes('api/v3/views/1061/getdata') && res.status() === 200 && req.method() === 'POST') {
                try {
                    const postData = req.postData();
                    if (postData && postData.includes('平台商品id') && postData.includes('组合69码')) {
                        return true;
                    }
                } catch (e) {
                    return false;
                }
            }
            return false;
        }, { timeout: 25000 });

        await page.getByRole('button', { name: '查 询' }).first().click();
        
        const targetRes = await apiResPromise;
        const targetReq = targetRes.request(); 

        const perfectHeaders = targetReq.headers();
        const perfectPayloadStr = targetReq.postData(); 

        const jsonBody = await targetRes.json();
        let rawDataArray = [];
        if (jsonBody.payload && Array.isArray(jsonBody.payload.resultList)) {
            rawDataArray = jsonBody.payload.resultList;
        } else if (jsonBody.data && Array.isArray(jsonBody.data)) {
            rawDataArray = jsonBody.data;
        }

        return {
            success: true,
            dataArray: rawDataArray,
            headers: perfectHeaders,
            payloadStr: perfectPayloadStr
        };

    } catch (e) {
        console.error(`      ❌ UI窃取模板过程异常:`, e.message);
        try {
            const dumpDir = path.dirname(DATABASE_PATH);
            const crashImgPath = path.join(dumpDir, `ui_crash_${Date.now()}.png`);
            await page.screenshot({ path: crashImgPath, fullPage: true });
            console.log(`      📸 [容错防护] UI 崩溃现场截图已保存至: ${crashImgPath}`);
        } catch (snapErr) {
            console.error(`      ❌ 容错截图保存失败:`, snapErr.message);
        }
        return { success: false };
    }
}

// ======================= [核心战术二：API 模板克隆打击] =======================
async function fetchDataViaCloneAPI(apiContext, clonedHeaders, clonedPayloadStr, oldDate, oldPlat, newDate, newPlat) {
    try {
        const apiUrl = 'https://ms.viomi.com.cn/data-bi-api/api/v3/views/1061/getdata';
        
        let maxPayloadStr = clonedPayloadStr;
        try {
            let jsonObj = JSON.parse(clonedPayloadStr);
            function traverseAndModifyLimit(obj) {
                if (typeof obj !== 'object' || obj === null) return;
                for (let key in obj) {
                    if (['pageSize', 'size', 'limit', 'maxRows', 'page_size'].includes(key) && typeof obj[key] === 'number') {
                        console.log(`      🛠️ [解除限制] 识别到底层静态分页参数 ${key}=${obj[key]}，已动态拉升至 99999`);
                        obj[key] = 99999;
                    }
                    if (typeof obj[key] === 'object') traverseAndModifyLimit(obj[key]);
                }
            }
            traverseAndModifyLimit(jsonObj);
            maxPayloadStr = JSON.stringify(jsonObj);
        } catch(e) {
            console.warn(`      ⚠️ JSON 序列化解析异常，采用正则兜底解除分页限制`);
            maxPayloadStr = maxPayloadStr.replace(/"pageSize"\s*:\s*\d+/g, '"pageSize":99999')
                                         .replace(/"limit"\s*:\s*\d+/g, '"limit":99999');
        }

        let newPayloadStr = maxPayloadStr
            .replace(new RegExp(oldDate, 'g'), newDate)
            .replace(new RegExp(oldPlat, 'g'), newPlat);

        const response = await apiContext.post(apiUrl, {
            headers: clonedHeaders, 
            data: newPayloadStr     
        });

        const jsonBody = await response.json();
        
        if (jsonBody.payload === "" && jsonBody.code === 200) {
            console.error(`      ❌ 克隆 API 遭到底层拦截 (可能平台名称编码不同)`);
            return null;
        }

        let rawDataArray = [];
        if (jsonBody.payload && Array.isArray(jsonBody.payload.resultList)) {
            rawDataArray = jsonBody.payload.resultList;
        } else if (jsonBody.data && Array.isArray(jsonBody.data)) {
            rawDataArray = jsonBody.data;
        }

        return rawDataArray;
    } catch (e) {
        console.error(`      ❌ API 克隆请求异常:`, e.message);
        return null;
    }
}

// ======================= [核心主接口：接入总控引擎] =======================
// 接受总控传递进来的 browserContext 实例
async function run(browserContext) {
    console.log("🚀 --- [模块 01: Sales TOP20 Sniper] 动态模板克隆启动 ---");
    initDatabase();
    
    const tasks = getMissingTasks();
    if (tasks.length === 0) {
        console.log("✅ 无需更新，模块平稳退出。");
        return;
    }

    // 从全局上下文中创建页面，而不是自行实例化浏览器
    const page = await browserContext.newPage();
    const apiContext = browserContext.request;

    let stolenTemplate = {
        headers: null,
        payloadStr: null,
        baseDate: null,
        basePlat: null
    };

    try {
        console.log('\n--- 1. 登录后台系统 ---');
        await page.goto('https://sky.viomi.com.cn/bi/dashboard/module?projectId=1&sourceId=3377&menuId=857');
        await page.getByRole('textbox', { name: '用户名' }).fill(VIOMI_USERNAME);
        await page.getByRole('textbox', { name: '密码' }).fill(VIOMI_PASSWORD);
        await page.getByRole('button', { name: '登 录' }).click();
        await page.waitForLoadState('networkidle', { timeout: 60000 });

        console.log('\n--- 2. 开始调度混合引擎 ---');
        for (let i = 0; i < tasks.length; i++) {
            const task = tasks[i];
            
            if (i === 0 || !stolenTemplate.payloadStr || !stolenTemplate.payloadStr.includes(stolenTemplate.basePlat)) {
                console.log(`\n🔹 [${task.date}] [${task.platform}] 探测节点: 发起 UI 操作与模板窃取...`);
                
                if (i !== 0) await page.reload({ waitUntil: 'networkidle' });

                const uiResult = await uiActionAndStealTemplate(page, task.date, task.platform);
                
                if (uiResult.success) {
                    stolenTemplate.headers = uiResult.headers;
                    stolenTemplate.payloadStr = uiResult.payloadStr;
                    stolenTemplate.baseDate = task.date;
                    stolenTemplate.basePlat = task.platform;
                    console.log(`      💡 模板嗅探成功，发现静态 Token，后续任务将切换为 10 倍速的 API 克隆模式。`);
                    
                    console.log(`      🔄 [平滑闭环] 正在使用解除分页限制的 API 重新拉取本首发节点的全部商品...`);
                    const firstFullData = await fetchDataViaCloneAPI(
                        apiContext, 
                        stolenTemplate.headers, 
                        stolenTemplate.payloadStr, 
                        stolenTemplate.baseDate, 
                        stolenTemplate.basePlat, 
                        task.date, 
                        task.platform
                    );
                    
                    if (firstFullData && firstFullData.length > 0) {
                        importJSONToDB(firstFullData, task.date, task.platform);
                    } else {
                        console.warn(`      ⚠️ 首节点全量重刷异常，退回入库 UI 截获的默认数据`);
                        importJSONToDB(uiResult.dataArray, task.date, task.platform);
                    }
                }

            } else {
                console.log(`\n⚡ [${task.date}] [${task.platform}] 轰炸节点: 瞬发纯 API 全量请求...`);
                
                const dataArray = await fetchDataViaCloneAPI(
                    apiContext, 
                    stolenTemplate.headers, 
                    stolenTemplate.payloadStr, 
                    stolenTemplate.baseDate, 
                    stolenTemplate.basePlat, 
                    task.date, 
                    task.platform
                );

                if (dataArray === null || dataArray.length === 0) {
                     console.log(`      ⚠️ API 克隆引擎失效，自动降级切换为 UI 安全模式重试...`);
                     await page.reload({ waitUntil: 'networkidle' });
                     const retryResult = await uiActionAndStealTemplate(page, task.date, task.platform);
                     if (retryResult.success) importJSONToDB(retryResult.dataArray, task.date, task.platform);
                } else {
                     importJSONToDB(dataArray, task.date, task.platform);
                }
                
                await page.waitForTimeout(300); 
            }
        }

    } catch (e) {
        console.error('❌ 模块内部运行中断:', e);
    } finally {
        // [极度关键] 任务结束仅关闭当前 page，绝对不能关闭 browser，把销毁权交还给总控列车
        await page.close().catch(() => {});
        console.log('🏁 [模块 01] 执行结束，控制权交还总控');
    }
}

// 暴露标准接口给 app4_master_controller
module.exports = { run };

// ======================= [兼容独立调试模式] =======================
if (require.main === module) {
    (async () => {
        console.log("🛠️ 正在以[独立模式]启动模块...");
        const { chromium } = require('playwright');
        const browser = await chromium.launch({ headless: false });
        // 模拟总控构造标准的 Context 给模块测试
        const context = await browser.newContext({
            viewport: { width: 1920, height: 1080 }
        });
        
        try {
            await run(context);
        } finally {
            await browser.close();
            console.log("🛠️ [独立模式] 测试完毕，浏览器已关闭。");
        }
    })();
}