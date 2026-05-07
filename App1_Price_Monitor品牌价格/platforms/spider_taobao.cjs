// platforms/spider_taobao.cjs
// 【架构升级】：接入总控 page，保留拟人化滚动与防滑块拦截

const path = require('path');
const fs = require('fs');
const { DateTime } = require('luxon');

// 引入基座
const browserManager = require('../../00_Core_Infrastructure/browser_manager.cjs');
const dbManager = require('../../00_Core_Infrastructure/db_manager.cjs');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 拟人化行为模拟：不规则移动与滚动 ---
async function simulateHumanAction(page) {
    console.log("   🧘 模拟人类浏览行为中...");
    try {
        const width = await page.evaluate(() => window.innerWidth).catch(()=>1200);
        const height = await page.evaluate(() => window.innerHeight).catch(()=>800);
        
        for (let i = 0; i < 3; i++) {
            const scrollAmount = Math.floor(Math.random() * 300) + 100;
            await page.mouse.wheel(0, scrollAmount);
            await sleep(Math.random() * 1000 + 500);
        }
        
        for (let i = 0; i < 2; i++) {
            await page.mouse.move(Math.random() * width, Math.random() * height, { steps: 10 });
            await sleep(500);
        }
    } catch (e) {}
}

// --- 辅助：清理页面遮挡 ---
async function clearObstructions(page) {
    const closeSelectors = [
        '.mui-dialog-close', '.sufei-dialog-close', 'button[aria-label="Close"]', 
        '.rax-view[role="button"]', 'text="关闭"', 'text="不再提示"', '.ant-modal-close'
    ];
    for (const sel of closeSelectors) {
        try {
            const els = await page.locator(sel).all();
            for (const el of els) {
                if (await el.isVisible()) {
                    await el.click({ force: true });
                    await sleep(300);
                }
            }
        } catch (e) {}
    }
}

// --- SKU 选择逻辑 ---
async function autoSelectSKU(page) {
    console.log("   ⚙️ 正在检查并自动选择 SKU...");
    const rowSelectors = ['dl.tm-sale-prop', 'ul.J_TSaleProp', 'div[class*="skuItem"]', 'div[class*="propRow"]'];
    for (const rowSel of rowSelectors) {
        const rows = await page.locator(rowSel).all();
        if (rows.length > 0) {
            for (const row of rows) {
                try {
                    const isSelected = await row.locator('.tb-selected, .tm-selected, [class*="selected"], [aria-checked="true"]').count() > 0;
                    if (!isSelected) {
                        const options = row.locator('li:not([class*="disabled"]):not([class*="out-of-stock"]) a, li:not([class*="disabled"]) span, button:not([disabled])');
                        if (await options.count() > 0) {
                            await options.first().click({ force: true });
                            await sleep(800);
                        }
                    }
                } catch (e) {}
            }
        }
    }
}

async function run(page, tasks, storeConfig, screenshotDir) {
    console.log(`\n=============================================`);
    console.log(`📦 [淘系模块] 启动监控 -> 店铺身份: ${storeConfig.storeName || '默认淘系环境'}`);
    console.log(`⚠️ 提示：正在采用低频拟人化策略，以降低封号风险。`);
    console.log(`=============================================`);

    if (!tasks || tasks.length === 0) return [];
    const today_str = DateTime.now().toFormat('yyyy-MM-dd');
    let new_records = [];

    try {
        // 淘系鉴权：使用购物车作为登录态探测点
        const tbLoginConfig = {
            platform: '淘系',
            checkUrl: 'https://cart.taobao.com/', 
            loginUrlKeyword: 'login.taobao.com', 
            userSelector: '#fm-login-id', 
            passSelector: '#fm-login-password', 
            submitSelector: '.fm-button',
            envUserKey: storeConfig.envUserKey,
            envPassKey: storeConfig.envPassKey,
            defaultUser: storeConfig.defaultUser
        };
        await browserManager.smartLogin(page, tbLoginConfig);

        for (let index = 0; index < tasks.length; index++) {
            const task = tasks[index];
            console.log(`--- [Taobao] (${index + 1}/${tasks.length}) ID:${task.trueId} ---`);
            
            let final_price_str = "Not Found";
            let price_status = "未知";
            let savedImagePath = "";

            try {
                await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

                // 验证拦截熔断逻辑
                if (page.url().includes('login.taobao') || (await page.locator('.sufei-dialog-content').isVisible().catch(()=>false))) {
                    console.log("🛑 检测到高强度验证或登录拦截！");
                    console.log("   (脚本将挂起，等待人工滑块通过...)");
                    await page.waitForURL(url => !url.href.includes('login.taobao.com'), { timeout: 0 });
                    await sleep(3000);
                }

                await clearObstructions(page);
                await simulateHumanAction(page);
                await autoSelectSKU(page);
                
                const safeInterval = Math.random() * 15000 + 15000;
                console.log(`   ⏳ 安全冷却 (${(safeInterval/1000).toFixed(1)}s)...`);
                await sleep(safeInterval);

                const buySelectors = ['text="立即购买"', 'text="领券购买"', '#J_LinkBuy', '[class*="buyBtn"]', '[class*="Buy--buyBtn"]'];
                let clicked = false;
                for(const selector of buySelectors) {
                    try {
                        const btn = page.locator(selector).first();
                        if (await btn.isVisible()) {
                            await btn.click({timeout: 5000, force: true});
                            console.log(`   👆 已触发购买动作`);
                            clicked = true; break;
                        }
                    } catch(e) {}
                }

                if (!clicked) throw new Error("无法触发购买动作");
                await sleep(2000);

                const confirmSelectors = ['.sku-info .btn-ok', 'button[class*="sku--sure"]', 'div[role="dialog"] button:has-text("确定")'];
                for(const sel of confirmSelectors) {
                    const btn = page.locator(sel).first();
                    if (await btn.isVisible()) {
                        await btn.click({force: true});
                        await sleep(1500); break;
                    }
                }

                console.log("   🔄 正在进入结算页...");
                await page.waitForURL(url => url.href.includes('buy.taobao') || url.href.includes('buy.tmall'), { timeout: 15000 });

                const priceSelectors = ['.trade-price-integer', '[class*="totalPrice_num"]', '[class*="realPay-price"]'];
                let priceText = "";
                for (const sel of priceSelectors) {
                    try {
                        const el = page.locator(sel).first();
                        if (await el.isVisible({timeout: 3000})) {
                            priceText = await el.textContent();
                            if (priceText && /\d/.test(priceText)) { priceText = priceText.trim(); break; }
                        }
                    } catch(e) {}
                }
                
                if (priceText) {
                    final_price_str = priceText;
                    console.log(`   💰 实付款: ${final_price_str}`);
                }

                const shotName = `${today_str}_TB_${task.barcode}.jpg`;
                const fullShotPath = path.join(screenshotDir, shotName);
                try {
                    const viewportWidth = await page.evaluate(() => window.innerWidth).catch(() => 1920);
                    await page.screenshot({ 
                        path: fullShotPath,
                        type: 'jpeg',
                        quality: 10,
                        clip: { x: 0, y: 0, width: viewportWidth, height: 1000 }
                    });
                    savedImagePath = fullShotPath;
                    console.log(`   📸 [轻量化] 淘宝截图已保存.`);
                } catch (shotErr) {
                    console.error(`   ❌ 淘宝截图失败: ${shotErr.message}`);
                }

            } catch(e) {
                console.log(`   [Error] ${e.message.split('\n')[0]}`);
                final_price_str = "Error";
                price_status = "脚本错误";
            }

            new_records.push({
                Platform: "淘系",
                URL: task.url,
                Product_Name: task.productName,
                SKU_Identifier: task.barcode,
                True_SKU_Identifier: task.trueId,
                Price: final_price_str,
                Limit_Price: task.limitPrice,
                Price_Status: price_status,
                Scrape_Date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
                Main_Image_URL: savedImagePath
            });

            const coolDown = Math.random() * 20000 + 10000;
            console.log(`   ☕ 完成一件，冷却 ${coolDown/1000}s...`);
            await sleep(coolDown);
        }

    } catch (e) {
        console.error(`[Taobao] 致命错误: ${e}`);
    } finally {
        if (new_records.length > 0) dbManager.save_results_to_db(new_records);
        console.log(`[Taobao] 模块执行完毕。`);
        return new_records;
    }
}

module.exports = { run };