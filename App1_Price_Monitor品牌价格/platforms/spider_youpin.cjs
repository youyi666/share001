// platforms/spider_youpin.cjs
// 【架构升级】：接入总控 page，移动端视图切换，保留多步骤点击逻辑

const path = require('path');
const { DateTime } = require('luxon');

// 引入基座
const browserManager = require('../../00_Core_Infrastructure/browser_manager.cjs');
const dbManager = require('../../00_Core_Infrastructure/db_manager.cjs');

function parsePriceToFloat(priceStr) {
    if (!priceStr) return null;
    const cleanStr = priceStr.toString().replace(/[^\d.]/g, '');
    const val = parseFloat(cleanStr);
    return isNaN(val) ? null : val;
}

// 清理页面遮挡
async function cleanupPage(page) {
    try {
        const nuisanceSelectors = ['#lib10-opapp-wrap', '.m-header-download-banner', '.openAppDialog', '.m-detail-back-top'];
        await page.evaluate((selectors) => {
            selectors.forEach(selector => {
                const el = document.querySelector(selector);
                if (el) el.remove();
            });
        }, nuisanceSelectors);
    } catch (error) {}
}

// 抓取价格文本
async function grabPrice(page) {
    let priceText = "Not Found";
    try {
        const presalePriceLocator = page.locator('[aria-label^="预售到手价"]');
        const finalPriceLocator = page.locator('[aria-label^="到手价"]');
        const regularPriceLocator = page.locator('[aria-label^="￥"]');

        let priceAriaLabel = "";
        if (await presalePriceLocator.count() > 0) priceAriaLabel = await presalePriceLocator.first().getAttribute('aria-label');
        else if (await finalPriceLocator.count() > 0) priceAriaLabel = await finalPriceLocator.first().getAttribute('aria-label');
        else if (await regularPriceLocator.count() > 0) priceAriaLabel = await regularPriceLocator.first().getAttribute('aria-label');

        if (priceAriaLabel) {
            const priceMatch = priceAriaLabel.match(/(\d+(\.\d+)?)/);
            if (priceMatch) priceText = priceMatch[0];
        }
        return priceText;
    } catch (e) { return "Error"; }
}

async function run(page, tasks, storeConfig, screenshotDir) {
    console.log(`\n=============================================`);
    console.log(`📦 [有品模块] 启动监控 -> 店铺身份: ${storeConfig.storeName || '默认有品环境'}`);
    console.log(`=============================================`);

    if (!tasks || tasks.length === 0) return [];
    const today_str = DateTime.now().toFormat('yyyy-MM-dd');
    let new_records = [];

    try {
        // 动态注入移动端视图，让平台下发 H5 移动端代码
        await page.setViewportSize({ width: 414, height: 896 });
        await page.setExtraHTTPHeaders({
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
        });

        const ypLoginConfig = {
            platform: '有品',
            checkUrl: 'https://m.xiaomiyoupin.com/', 
            loginUrlKeyword: 'passport.xiaomi.com', 
            userSelector: 'input[name="account"]', 
            passSelector: 'input[type="password"]', 
            submitSelector: 'button[type="submit"]',
            envUserKey: storeConfig.envUserKey,
            envPassKey: storeConfig.envPassKey,
            defaultUser: storeConfig.defaultUser
        };
        await browserManager.smartLogin(page, ypLoginConfig);

        for (let index = 0; index < tasks.length; index++) {
            const task = tasks[index];
            if (!task.url) continue;

            console.log(`--- [Youpin] (${index + 1}/${tasks.length}) 69码: ${task.barcode} ---`);

            try {
                await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await cleanupPage(page);
                await page.waitForTimeout(1000); 

                const buyBtnSelectors = ['text=/^立即(购买|抢购)$/', 'text="领券购买"', 'text="到货通知"', 'text=/^支付定金/', 'text="加入购物车"', '.m-detail-footer-btns .btn-item'];
                let isFound = false;
                for (const selector of buyBtnSelectors) {
                    const btn = page.locator(selector).first();
                    if (await btn.isVisible()) {
                        await btn.scrollIntoViewIfNeeded();
                        await btn.click({ force: true });
                        isFound = true; break;
                    }
                }
                if (isFound) await page.waitForTimeout(1500);

                // 兼容 Excel E列中的多步骤指令
                const subTasks = (task.skuTask || '').split(';').map(t => t.trim()).filter(t => t !== '');
                const currentTasks = subTasks.length > 0 ? subTasks : ['default'];

                for (const currentTaskStr of currentTasks) {
                    let final_price_str = "Not Found";
                    let price_status = "未知";
                    let savedImagePath = "";

                    if (currentTaskStr !== 'default') {
                        for (const step of currentTaskStr.split(',').map(s => s.trim())) {
                            let targetText = step, targetIndex = 0;
                            const match = step.match(/(.+)\[(\d+)\]$/);
                            if (match) { targetText = match[1].trim(); targetIndex = parseInt(match[2], 10); }
                            const stepLocator = page.getByText(targetText, { exact: true });
                            if (await stepLocator.count() > targetIndex) {
                                await stepLocator.nth(targetIndex).click({ force: true });
                                await page.waitForTimeout(500);
                            }
                        }
                    }

                    await page.waitForTimeout(800);
                    final_price_str = await grabPrice(page);

                    if (final_price_str !== "Not Found" && final_price_str !== "Error") {
                        const currentVal = parsePriceToFloat(final_price_str);
                        const shotName = `${today_str}_YP_${task.barcode}_${Date.now()}.jpg`;
                        const fullPath = path.join(screenshotDir, shotName);
                        
                        if (task.limitPrice && currentVal && currentVal < (task.limitPrice * 0.97)) {
                            price_status = "破价警报";
                        } else if (currentVal && task.limitPrice && currentVal > task.limitPrice) {
                            price_status = "高价待调整";
                        } else { 
                            price_status = "价格正常";
                        }

                        try {
                            const viewportWidth = await page.evaluate(() => window.innerWidth).catch(() => 414);
                            await page.screenshot({ 
                                path: fullPath, type: 'jpeg', quality: 10,
                                clip: { x: 0, y: 0, width: viewportWidth, height: 1000 }
                            });
                            savedImagePath = fullPath;
                            console.log(`   📸 [轻量化] 有品截图已保存.`);
                        } catch (shotErr) {
                            console.error(`   ❌ 有品截图失败: ${shotErr.message}`);
                        }
                    }

                    new_records.push({
                        Platform: "米家有品",
                        URL: task.url,
                        Product_Name: task.productName,
                        SKU_Identifier: task.barcode,      
                        True_SKU_Identifier: currentTaskStr, 
                        Price: final_price_str,
                        Limit_Price: task.limitPrice,
                        Price_Status: price_status,
                        Scrape_Date: DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss'),
                        Main_Image_URL: savedImagePath
                    });
                }
            } catch (err) { 
                console.log(`   [Error] ${err.message.split('\n')[0]}`);
            }
        }
    } finally {
        if (new_records.length > 0) dbManager.save_results_to_db(new_records);
        console.log(`[Youpin] 模块执行完毕。`);
        return new_records;
    }
}

module.exports = { run };