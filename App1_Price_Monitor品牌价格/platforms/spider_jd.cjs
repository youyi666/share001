// platforms/spider_jd.cjs
// 【架构升级】：剥离浏览器启动权，接收总控传导的 page 实例，更新中台基座路径

const path = require('path');
const fs = require('fs');
const { DateTime } = require('luxon');

// 【修改点1】引入大中台的底层基座 (注意路径变为 ../../ )
const browserManager = require('../../00_Core_Infrastructure/browser_manager.cjs');
const dbManager = require('../../00_Core_Infrastructure/db_manager.cjs');

// 通用工具函数 (100%保留)
function parsePriceToFloat(priceStr) {
    if (!priceStr) return null;
    const cleanStr = priceStr.toString().replace(/[^\d.]/g, '');
    const val = parseFloat(cleanStr);
    return isNaN(val) ? null : val;
}

/**
 * [回归基础] 鼠标随机晃动 + 极小幅滚动并复位策略
 * 产生充足的拟人特征防屏蔽，同时绝对不破坏截图画面
 */
async function simpleScroll(page) {
    try {
        // 1. 注入纯鼠标轨迹
        const width = await page.evaluate(() => window.innerWidth).catch(() => 1200);
        const height = await page.evaluate(() => window.innerHeight).catch(() => 800);
        await page.mouse.move(Math.random() * (width / 2), Math.random() * (height / 2), { steps: 10 });
        await page.waitForTimeout(Math.random() * 300 + 200);

        // 2. 原地微幅滚动并立刻复位
        const microScroll = Math.floor(Math.random() * 50) + 20; // 仅滚动 20~70 像素
        await page.mouse.wheel(0, microScroll); // 往下滚一点点
        await page.waitForTimeout(Math.random() * 300 + 200);
        await page.mouse.wheel(0, -microScroll); // 原路滚回顶部（复位）
        await page.waitForTimeout(Math.random() * 500 + 500);
    } catch (e) {}
}

/**
 * 京东抓取主函数
 * 【修改点2】新增接收 page 参数
 * @param {Object} page - 由总控传来的带有状态的浏览器页面实例
 * @param {Array} tasks - 经过总控筛选去重后的待抓取任务列表
 * @param {Object} storeConfig - 包含 profileDir 的店铺配置
 * @param {string} screenshotDir - 全局截图保存目录
 */
async function run(page, tasks, storeConfig, screenshotDir) {
    console.log(`\n=============================================`);
    console.log(`📦 [京东模块] 启动监控 -> 店铺: ${storeConfig.storeName || '默认京东环境'}`);
    console.log(`=============================================`);

    if (!tasks || tasks.length === 0) {
        console.log(`🎉 [JD] 当前无待处理任务，直接返回！`);
        return [];
    }
    console.log(`📊 [JD] 本次接收到待处理任务: ${tasks.length} 个`);

    const today_str = DateTime.now().toFormat('yyyy-MM-dd');
    let new_records = [];

    // 创建错误截图目录 (容错机制)
    const errorScreenshotDir = path.join(path.dirname(screenshotDir), 'error_screenshots');
    if (!fs.existsSync(errorScreenshotDir)) {
        fs.mkdirSync(errorScreenshotDir, { recursive: true });
    }

    try {
        // ==========================================
        // 【新增增量模块】：极限网络提速策略 (屏蔽无用资源)
        // ==========================================
        console.log(`🚀 [JD提速] 启动网络路由拦截，屏蔽无用大文件...`);
        await page.route('**/*', (route) => {
            const request = route.request();
            const resourceType = request.resourceType();
            // 屏蔽媒体流、字体、以及部分第三方追踪脚本
            if (['media', 'font', 'manifest', 'other'].includes(resourceType)) {
                route.abort();
            } 
            // 如果需要极端提速可以连 image 也屏蔽，但由于你有截图需求（需确认是否包含商品主图），这里保守放行 image
            else {
                route.continue();
            }
        });
        // 【修改点3】彻底删除了 browserManager.launchBrowser 的代码，直接使用传入的 page

        // ==========================================
        // 激活多维降级登录基座 (复用总控传来的 page 进行鉴权)
        // ==========================================
        const jdLoginConfig = {
            platform: '京东',
            // 用京东个人中心测试登录态。如果未登录，会被强制跳到 passport.jd.com
            checkUrl: 'https://home.jd.com/', 
            loginUrlKeyword: 'passport.jd.com', 
            userSelector: '#loginname', 
            passSelector: '#nloginpwd', 
            submitSelector: '#loginsubmit',
            envUserKey: storeConfig.envUserKey,
            envPassKey: storeConfig.envPassKey,
            defaultUser: storeConfig.defaultUser
        };
        // 强制执行智能鉴权：缓存优先 -> 自动密码注入 -> 挂起等待人工
        await browserManager.smartLogin(page, jdLoginConfig);

        // ==========================================
        // 保持 V4 的稳定等待时间
        

        for (let index = 0; index < tasks.length; index++) {
            const task = tasks[index];
            if (!task.url || !task.url.startsWith('http')) continue;

            console.log(`--- [JD] (${index + 1}/${tasks.length}) SKU:${task.trueId} | 码:${task.barcode} ---`);
            let final_price_str = "Not Found";
            let price_status = "未知";
            let savedImagePath = "";

            try {
                // [自带 referer 伪装自然流量]
                await page.goto(task.url, { 
                    waitUntil: "domcontentloaded", 
                    timeout: 60000,
                    referer: "https://search.jd.com/"
                });
            
                // ==========================================
                // 【修复版】京东专属动态风控拦截（稳定等待）
                // ==========================================
                if (page.url().includes('passport.jd.com') || page.url().includes('safe.jd.com')) {
                    console.log("🛑 [JD动态风控] 访问商品页时遭到拦截，进入挂起等待模式...");
                    console.log("   (请在弹出的浏览器中手动完成扫码/滑块验证，脚本将无限期等待直至通过)");
                    
                    // 永久循环等待，直到离开验证页面
                    while (true) {
                        const currentUrl = page.url();
                        if (!currentUrl.includes('passport.jd.com') && !currentUrl.includes('safe.jd.com')) {
                            break;
                        }
                        await page.waitForTimeout(1000);
                    }
            
                    console.log("✅ [JD动态风控] 验证完成，重回自动化接管...");
                    await page.waitForTimeout(3000);
                }
                // ==========================================
                            
            
                    
                    // 1. 优先执行一波拟人微小滚动
                    await simpleScroll(page);
                    
                    // 2. 弹性等待核心元素：价格一旦出现，最多再假装看 1-2 秒就直接开干，不再死等 4-7 秒
                    try {
                        await Promise.any([
                            page.waitForSelector("#J_FinalPrice .price", { timeout: 4000 }),
                            page.waitForSelector(".p-price .price", { timeout: 4000 }),
                            page.waitForSelector(".product-price--value", { timeout: 4000 })
                        ]);
                        // 元素出现后，象征性地等待极短时间，假装人类反应
                        await page.waitForTimeout(Math.random() * 1000 + 800); 
                    } catch (e) {
                        // 如果 4 秒内都没刷出来，说明页面卡顿或价格隐藏，此时兜底再等两秒
                        console.log("   ⚠️ 价格元素加载缓慢，触发兜底等待...");
                        await page.waitForTimeout(2000);
                    }
            
                // ==========================================
                // 【修复版】验证码/滑块/弹窗 持续监听（永不漏检）
                // ==========================================
                console.log("   🔍 持续监听京东验证弹窗...");
                const captchaSelectors = [
                    '#captcha_modal',
                    '.captcha-box',
                    'text="验证一下"',
                    '#J-dj-captcha',
                    '.verify-box',
                    '#verify',
                    '.login-wrap'
                ];
            
                // 无限轮询检测，出现就等待消失
                while (true) {
                    let foundCaptcha = false;
                    for (const sel of captchaSelectors) {
                        try {
                            const locator = page.locator(sel).first();
                            if (await locator.isVisible({ timeout: 300 })) {
                                foundCaptcha = true;
                                console.log("   ⚠️ 检测到验证弹窗，等待人工完成验证...");
                                await locator.waitFor({ state: 'hidden', timeout: 0 });
                                console.log("   ✅ 验证已完成，脚本自动继续执行...");
                                await page.waitForTimeout(1500);
                                break;
                            }
                        } catch (e) {}
                    }
                    if (!foundCaptcha) break;
                }
            
                

                const priceSelectors = [
                    ".product-price--value", 
                    ".product-price--main",  
                    "#J_FinalPrice .price", 
                    ".J-presale-price", 
                    ".p-price .price", 
                    ".price"
                ];

                for (const sel of priceSelectors) {
                    try {
                        const el = page.locator(sel).first();
                        if (await el.isVisible()) {
                            await el.scrollIntoViewIfNeeded();
                            const txt = await el.textContent();
                            if (/\d/.test(txt)) { final_price_str = txt.trim(); break; }
                        }
                    } catch (e) {}
                }

                if (final_price_str !== "Not Found") {
                    console.log(`   💰 抓取价格: ${final_price_str}`);
                    if (task.limitPrice !== null) {
                        const currentVal = parsePriceToFloat(final_price_str);
                        if (currentVal !== null) {
                            const alertThreshold = task.limitPrice * 0.97;
                            if (currentVal < alertThreshold) {
                                price_status = "破价警报";
                                console.log(`   🚨 [破价] ${currentVal} < 警报阈值 ${alertThreshold.toFixed(2)} (原限价: ${task.limitPrice})`);
                            } else if (currentVal > task.limitPrice) {
                                price_status = "高价待调整";
                                console.log(`   📈 [高价] ${currentVal} > 限价 ${task.limitPrice}`);
                            } else {
                                price_status = "价格正常";
                            }
                        }
                    }

                    // 截图防御逻辑：鼠标避让与可视区极简截图
                    const shotName = `${today_str}_JD_${task.barcode}_${task.trueId}.jpg`;
                    const fullShotPath = path.join(screenshotDir, shotName);

                    try {
                        const vWidth = await page.evaluate(() => window.innerWidth).catch(() => 1200);
                        await page.mouse.move(vWidth - 20, 300); // 避开放大镜
                        await page.waitForTimeout(500);
                        await page.screenshot({
                            path: fullShotPath,
                            type: 'jpeg',
                            quality: 10,
                            fullPage: false // 斩断越界报错可能
                        });
                        savedImagePath = fullShotPath;
                        console.log(`   📸 [可视区记录] 截图已稳妥保存 (${shotName})`);
                    } catch (shotErr) {
                        console.error(`   ❌ 截图保存发生罕见崩溃: ${shotErr.message}`);
                    }
                } else {
                    price_status = "抓取失败";
                    console.log(`   ❌ 未找到价格`);
                    const failShotPath = path.join(errorScreenshotDir, `fail_JD_${task.trueId || index}.png`);
                    await page.screenshot({ path: failShotPath });
                    savedImagePath = failShotPath;
                }

            } catch (e) {
                console.log(`   [出错] ${e.message.split('\n')[0]}`);
                final_price_str = "Error";
                price_status = "脚本错误";
            }

            new_records.push({
                Platform: "京东",
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

            // 实时写入与休息策略
            if (index > 0 && index % 8 === 0) {
                const restTime = Math.floor(Math.random() * 5000) + 3000;
                console.log(`   ☕ 处理8件，小憩 ${restTime/1000}s...`);
                await page.waitForTimeout(restTime);
            } else {
                await page.waitForTimeout(Math.random() * 1500 + 1500);
            }
        }

    } catch (e) {
        console.error(`[JD] 平台运行致命错误: ${e}`);
    } finally {
        // 【修改点4】严禁在这里关闭浏览器，因为还有别的任务要用它。把 context.close 删掉
        
        // 模块内只负责将数据写入数据库，CSV 统筹交给外层
        if (new_records.length > 0) {
            dbManager.save_results_to_db(new_records);
        }
        
        console.log(`[JD] 模块执行完毕，产出 ${new_records.length} 条记录。`);
        return new_records;
    }
}

module.exports = {
    run
};