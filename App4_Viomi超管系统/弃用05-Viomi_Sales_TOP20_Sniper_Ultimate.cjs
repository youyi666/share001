// 05-Viomi_Sales_TOP20_Sniper_Ultimate.cjs
// 【v21 - 销售额TOP20 完全体】(中台基座标准接入版)
// 
// 架构升级日志：
// 1. [规范] 全面由 ESM (.js) 降级转为 CommonJS (.cjs) 规范，对齐基座标准。
// 2. [接入] 引入 00_Core_Infrastructure 的 ENV_CONFIG，统一下载与数据库路径。
// 3. [解耦] 移除硬编码路径，环境变量由基座定位的 .env 统一挂载。

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const xlsx = require('xlsx');

// ======================= [引入核心基座模块] =======================
const ENV_CONFIG = require('../00_Core_Infrastructure/env_config.cjs');
const browserManager = require('../00_Core_Infrastructure/browser_manager.cjs');
const dbManager = require('../00_Core_Infrastructure/db_manager.cjs');
const fileUtils = require('../00_Core_Infrastructure/file_utils.cjs');

// 加载环境变量 (使用基座提供的 ROOT 路径精准定位 .env)
require('dotenv').config({ path: path.join(ENV_CONFIG.ROOT, '.env') });

const VIOMI_USERNAME = process.env.VIOMI_USERNAME;
const VIOMI_PASSWORD = process.env.VIOMI_PASSWORD;

// ======================= [模块一：TOP20 专属配置] =======================
// 使用基座提供的全局数据库与下载目录
const DATABASE_PATH = ENV_CONFIG.DATABASE_PATH;
const TOP20_DOWNLOAD_DIR = path.join(ENV_CONFIG.DOWNLOADS_DIR, 'TOP20_Sniper');
const TOP20_ARCHIVE_DIR = path.join(TOP20_DOWNLOAD_DIR, '已导入');

// --- 监控范围 ---
const TARGET_PLATFORMS = ['京东', '天猫', '拼多多', '有品']; 
const LOOKBACK_DAYS = 30; 

// ======================= [数据库初始化] =======================
function initDatabase() {
    const dbDir = path.dirname(DATABASE_PATH);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    
    const db = new Database(DATABASE_PATH);
    
    try {
        const check = db.prepare("SELECT barcode FROM sales_history LIMIT 1").get();
    } catch (e) {
        if (e.message.includes('no such column')) {
            console.log("   ⚠️ 检测到旧版数据库结构，正在升级表结构...");
            db.exec("DROP TABLE IF EXISTS sales_history"); 
        }
    }

    db.exec(`
        CREATE TABLE IF NOT EXISTS sales_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            record_date TEXT,       -- 日期
            platform TEXT,          -- 渠道类型
            sku_id TEXT,            -- 平台商品id
            product_name TEXT,      -- 商品名称
            category TEXT,          -- 类目
            barcode TEXT,           -- 商品69码 (核心关联字段)
            
            -- 流量数据
            visitor_count INTEGER,  -- 访客数
            page_views INTEGER,     -- 浏览量
            favorites INTEGER,      -- 收藏量
            
            -- 销售漏斗
            order_buyers INTEGER,   -- 下单买家数
            order_items INTEGER,    -- 下单件数
            order_amount REAL,      -- 下单金额
            
            sales_volume INTEGER,   -- 支付数量 (修正原名为支付件数)
            sales_users INTEGER,    -- 支付用户数
            sales_amount REAL,      -- 支付金额
            
            -- 意向数据
            cart_items INTEGER,     -- 加购件数
            cart_users INTEGER,     -- 加购人数
            
            -- 指标
            aov REAL,               -- 客单价
            conversion_rate REAL,   -- 支付转化率
            
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(record_date, platform, sku_id) ON CONFLICT REPLACE
        )
    `);
    db.close();
}

// ======================= [工具函数] =======================
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
    console.log(`   📉 待执行: ${tasks.length} 个任务`);
    return tasks;
}

// ======================= [核心交互逻辑] =======================
async function clearDownloadList(page) {
    try {
        const downloadManagerIcon = page.locator('span.ant-badge:has(path[d^="M5,15"])');
        if (!await downloadManagerIcon.isVisible()) return;

        await downloadManagerIcon.click();
        await page.waitForTimeout(500);

        let retry = 0;
        while (retry < 20) {
            const deleteBtns = page.getByRole('button', { name: 'delete' });
            const count = await deleteBtns.count();
            if (count === 0) break;
            await deleteBtns.first().click();
            await page.waitForTimeout(300);
            retry++;
        }
        await page.keyboard.press('Escape'); 
        await page.waitForTimeout(300);
    } catch (error) {
        console.warn('      ⚠️ 清理列表轻微异常, 尝试继续...');
        await page.keyboard.press('Escape').catch(()=>{});
    }
}

async function setFiltersAndQuery(page, dateStr, platformName) {
    console.log(`      ⚙️ 设置筛选: [${dateStr}] [${platformName}]`);

    const startDatePicker = page.locator('div.ant-picker').first();
    const startDateInput = startDatePicker.locator('input');
    
    const startClearButton = startDatePicker.locator('span.ant-picker-clear');
    if (await startClearButton.isVisible({ timeout: 2000 })) { 
        await startClearButton.click(); 
    }
    
    await startDateInput.click();
    await page.locator('div.ant-picker-panel:visible').waitFor();
    await startDateInput.fill(dateStr);
    
    const visiblePanelStart = page.locator('div.ant-picker-panel:visible');
    await visiblePanelStart.locator(`td[title="${dateStr}"]`).click();
    await page.locator('div.ant-picker-panel:visible').waitFor({ state: 'hidden' });

    const endDatePicker = page.locator('div.ant-picker').nth(1);
    const endDateInput = endDatePicker.locator('input');
    
    const endClearButton = endDatePicker.locator('span.ant-picker-clear');
    if (await endClearButton.isVisible({ timeout: 2000 })) { 
        await endClearButton.click(); 
    }
    
    await endDateInput.click();
    await page.locator('div.ant-picker-panel:visible').waitFor();
    await endDateInput.fill(dateStr);
    
    const visiblePanelEnd = page.locator('div.ant-picker-panel:visible');
    await visiblePanelEnd.locator(`td[title="${dateStr}"]`).click();
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

    const option = page.locator(`.ant-select-item-option-content:has-text("${platformName}")`).first();
    if (!await option.isVisible()) {
        console.warn(`      ❌ 无法找到平台选项: ${platformName}`);
        return false;
    }
    await option.click();
    await page.keyboard.press('Escape'); 

    console.log(`      🖱️ 点击查询...`);
    const responsePromise = page.waitForResponse(resp => 
        resp.url().includes('dashboard') && resp.status() === 200, 
        { timeout: 15000 }
    ).catch(() => null);

    await page.getByRole('button', { name: '查 询' }).first().click();
    
    await responsePromise; 
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000); 

    return true;
}

async function downloadTop20(page, dateStr, platformName) {
    console.log(`      🎯 提取 TOP20 数据...`);
    
    const widget = page.locator('.gridItem--WrCz6', { has: page.locator('text="销售额TOP20"') }).last();
    if (!await widget.isVisible()) return null;

    await widget.hover();
    await widget.locator('.anticon-download').click();
    
    await page.waitForTimeout(1000);
    const popover = page.locator('.ant-popover-content:visible');
    if (await popover.isVisible()) {
        await popover.locator('img, svg, button').first().click();
    }

    console.log(`      ⏳ 等待文件生成...`);
    const downloadIcon = page.locator('span.ant-badge:has(path[d^="M5,15"])');
    await downloadIcon.click();

    const firstItem = page.locator('li[class^="item--"]').first();
    await firstItem.waitFor({ state: 'visible', timeout: 180000 });
    
    const fileName = await firstItem.innerText();
    if (!fileName.includes('销售额TOP20')) {
        console.error(`      ❌ 异常：文件名为 [${fileName}]，不是目标文件！`);
        await page.keyboard.press('Escape');
        return null;
    }

    await firstItem.locator('span.ant-tag:text("成功")').waitFor({ state: 'visible', timeout: 60000 });

    const downloadPromise = page.waitForEvent('download');
    await firstItem.locator('p[class^="success--"]').click();
    const download = await downloadPromise;

    if (!fs.existsSync(TOP20_DOWNLOAD_DIR)) fs.mkdirSync(TOP20_DOWNLOAD_DIR, { recursive: true });
    const saveName = `${dateStr}_${platformName}_TOP20.xlsx`;
    const savePath = path.join(TOP20_DOWNLOAD_DIR, saveName);
    
    await download.saveAs(savePath);
    console.log(`      💾 已保存: ${saveName}`);
    await page.keyboard.press('Escape');
    
    return savePath;
}

function importToDB(filePath, dateStr, platformName) {
    const db = new Database(DATABASE_PATH);
    const workbook = xlsx.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet);

    if (data.length === 0) { db.close(); return; }

    const insertStmt = db.prepare(`
        INSERT OR REPLACE INTO sales_history 
        (record_date, platform, sku_id, product_name, category, barcode, 
         visitor_count, page_views, favorites, 
         order_buyers, order_items, order_amount,
         sales_volume, sales_users, sales_amount,
         cart_items, cart_users, aov, conversion_rate)
        VALUES (@date, @plat, @sku, @name, @cat, @bc, 
                @uv, @pv, @fav, 
                @ob, @oi, @oa,
                @sv, @su, @sa,
                @ci, @cu, @aov, @rate)
    `);

    const transaction = db.transaction((rows) => {
        for (const row of rows) {
            const cleanInt = (v) => parseInt(v) || 0;
            const cleanFloat = (v) => parseFloat(v) || 0.0;
            const cleanStr = (v) => String(v || '').trim();

            const record = {
                date: dateStr,
                plat: platformName,
                sku: cleanStr(row['平台商品id'] || row['商品ID']),
                name: cleanStr(row['商品名称'] || row['产品名称']),
                cat: cleanStr(row['类目'] || row['一级类目']),
                bc:  cleanStr(row['商品69码'] || row['69码'] || row['条形码']), 
                uv: cleanInt(row['访客数']),
                pv: cleanInt(row['浏览量']),
                fav: cleanInt(row['收藏量']),
                ob: cleanInt(row['下单买家数']),
                oi: cleanInt(row['下单件数']),
                oa: cleanFloat(row['下单金额']),
                sv: cleanInt(row['支付数量'] || row['支付件数']), 
                su: cleanInt(row['支付用户数']),
                sa: cleanFloat(row['支付金额']),
                ci: cleanInt(row['加购件数']),
                cu: cleanInt(row['加购人数']),
                aov: cleanFloat(row['客单价']),
                rate: cleanFloat(row['支付转化率'] || row['转化率'])
            };
            
            if (record.sku) insertStmt.run(record);
        }
    });

    transaction(data);
    db.close();
    console.log(`      ✅ 入库 ${data.length} 条 (全字段) | 归档中...`);

    if (!fs.existsSync(TOP20_ARCHIVE_DIR)) fs.mkdirSync(TOP20_ARCHIVE_DIR, { recursive: true });
    const destPath = path.join(TOP20_ARCHIVE_DIR, path.basename(filePath));
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    fs.renameSync(filePath, destPath);
}

// ======================= [主流程] =======================
async function main() {
    console.log("🚀 --- [v21] 销售额TOP20 完全体 (基座接入版) ---");
    initDatabase();
    
    const tasks = getMissingTasks();
    if (tasks.length === 0) return console.log("✅ 无需更新。");

    // 内部 BI 系统无需复杂的电商指纹，保持原生启动模式，避免串号
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        console.log('\n--- 登录后台 ---');
        await page.goto('https://sky.viomi.com.cn/bi/dashboard/module?projectId=1&sourceId=3377&menuId=857');
        await page.getByRole('textbox', { name: '用户名' }).fill(VIOMI_USERNAME);
        await page.getByRole('textbox', { name: '密码' }).fill(VIOMI_PASSWORD);
        await page.getByRole('button', { name: '登 录' }).click();
        await page.waitForLoadState('networkidle', { timeout: 60000 });

        for (const task of tasks) {
            console.log(`\n🔹 [${task.date}] [${task.platform}] 任务开始...`);
            
            console.log(`      🔄 强制刷新页面...`);
            await page.reload({ waitUntil: 'networkidle' });
            
            await clearDownloadList(page);

            const filterOk = await setFiltersAndQuery(page, task.date, task.platform);
            if (filterOk) {
                const filePath = await downloadTop20(page, task.date, task.platform);
                if (filePath) {
                    importToDB(filePath, task.date, task.platform);
                } else {
                    console.error(`      ❌ 下载失败，跳过入库`);
                }
            }
        }

    } catch (e) {
        console.error('❌ 运行中断:', e);
    } finally {
        await browser.close();
        console.log('🏁 脚本结束');
    }
}

main();