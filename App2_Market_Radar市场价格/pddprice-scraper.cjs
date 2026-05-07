// App2_Market_Radar市场价格/pddprice-scraper.cjs
// 【架构升级】：剥离独立启动权，接入中台基座，改造成标准 App 局部总控

const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

// 引入底层基座 (统一从 00_Core_Infrastructure 获取浏览器资源)
const browserManager = require('../00_Core_Infrastructure/browser_manager.cjs');

// =========================================================
// 日期辅助函数
// =========================================================
function getLocalMonitorDate(offsetDays = 0) {
    const targetDate = new Date(Date.now() + offsetDays * 86400000);
    const offset = targetDate.getTimezoneOffset() * 60000;
    return (new Date(targetDate - offset)).toISOString().split('T')[0];
}

// =========================================================
// 数据库配置 (指向中台统一数据库)
// =========================================================
// =========================================================
// 数据库配置 (动态路径适配)
// =========================================================
const { DATABASE_PATH } = require('../00_Core_Infrastructure/env_config.cjs');


// =========================================================
// 核心业务：App2 局部总控接口
// =========================================================
async function startApp() {
    console.log(`\n🚀 --- 分布式架构爬虫总控台启动 (App2: 市场竞品大盘雷达) ---`);
    
    // 初始化数据库连接
    const db = new Database(DATABASE_PATH);
    db.exec(`
        CREATE TABLE IF NOT EXISTS "pdd市场监控" (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id TEXT,        
            title TEXT,             
            price REAL,             
            total_sales INTEGER,    
            monthly_sales INTEGER,  
            weekly_sales INTEGER,   
            daily_sales_tag INTEGER,
            hot_sales INTEGER,      
            grabbed_sales INTEGER,  
            daily_increment INTEGER,
            product_url TEXT,       
            monitor_date DATE,   
            scrape_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(product_id, monitor_date) 
        )
    `);

    const insertProduct = db.prepare(`
        INSERT OR REPLACE INTO "pdd市场监控"
        (product_id, title, price, total_sales, monthly_sales, weekly_sales, daily_sales_tag, hot_sales, grabbed_sales, daily_increment, product_url, monitor_date, scrape_time) 
        VALUES (@product_id, @title, @price, @total_sales, @monthly_sales, @weekly_sales, @daily_sales_tag, @hot_sales, @grabbed_sales, @daily_increment, @product_url, @monitor_date, datetime('now', 'localtime'))
    `);

    const getYesterdaySales = db.prepare(`
        SELECT total_sales FROM "pdd市场监控"
        WHERE product_id = ? AND monitor_date = ?
    `);

    const getTodaySales = db.prepare(`
        SELECT total_sales, price FROM "pdd市场监控"
        WHERE product_id = ? AND monitor_date = ?
    `);

    // 100% 还原原版的待抓取网址列表
    const urls = [
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=3283500946001010801&list_sn=YWGBa9o9B_lmiaes3Jhw_xjc&__list_version=2&_pdd_fs=1&_pdd_tc=ffffff&_pdd_sbs=1&scene_id=goods_detail&display_type=base&refer_page_name=goods_detail&refer_page_id=10014_1775610902771_ppiz639h56&refer_page_sn=10014&activeTab=0',//美的净水器畅销榜
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=158438010201&scene_id=goods_detail%2Crelated_goods&list_sn=YWGKOjNRP-SpmKbvEED5Q9J3&__list_version=2&_pdd_fs=1&refer_page_name=bangdan_list&refer_page_id=17542_1775617970181_16m6qofvrv&refer_page_sn=17542&page_from=69&activeTab=0',//品牌云米净水器畅销榜
        //'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=3283499844847010801&list_sn=YWEgW7aKJnACkTS-VA-syDSw&__list_version=2&_pdd_fs=1&_pdd_tc=ffffff&_pdd_sbs=1&scene_id=goods_detail&display_type=base&refer_page_name=goods_detail&refer_page_id=10014_1775628324771_uec69a4wz4&refer_page_sn=10014&activeTab=0',//安吉尔净水器畅销榜
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=3283500335952010801&list_sn=YWF8XVMLgYDEn8CVFmjq-aO4&__list_version=2&_pdd_fs=1&_pdd_tc=ffffff&_pdd_sbs=1&scene_id=goods_detail&display_type=base&refer_page_name=goods_detail&refer_page_id=10014_1775628390060_fve52hluwo&refer_page_sn=10014&activeTab=0',//小米净水器畅销榜
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?refer_share_id=iLKJf757sHkUnIicy069SB75ZkwhIUfv&refer_share_channel=copy_link&_pdd_fs=1&__list_version=2&display_type=base&list_sn=YWE3UtyUoB3JnVpcQVxUEUuW&scene_id=goods_detail&refer_share_uin=6NCWZWVQQSPG3MY5ZMDLWFR3KU_GEXDA&_pdd_tc=ffffff&_pdd_sbs=1&share_list_id=9298010204&list_id=9298010204',//品牌净水器降价榜
        //'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?refer_share_id=oELKkqautphRMeJh1GRwwa66ZXp7qveZ&page_id=17542_1775701551450_adr6k9hl5d&refer_share_channel=copy_link&_pdd_fs=1&__list_version=2&display_type=base&list_sn=YWFpstRbTEA4KvkN3wH_RzCQ&scene_id=goods_detail&refer_share_uin=6NCWZWVQQSPG3MY5ZMDLWFR3KU_GEXDA&_pdd_tc=ffffff&_pdd_sbs=1&share_list_id=3283500823989010801&list_id=3283500823989010801',//即热净水器畅销榜
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=200227993010701&scene_id=goods_detail%2Crelated_goods&list_sn=YWGRw0Q0pFR5608CI7Lif-fN&__list_version=2&_pdd_fs=1&_x_share_id=iLKJf757sHkUnIicy069SB75ZkwhIUfv&refer_page_name=bangdan_list&refer_page_id=17542_1775701863123_rurzprpnud&refer_page_sn=17542&page_from=69&activeTab=0',//品牌加热净水器畅销榜
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=3283500945926010801&scene_id=goods_detail%2Crelated_goods&list_sn=YWFgklt0I9jQl1bvOU5J9V8u&__list_version=2&_pdd_fs=1&_x_share_id=oELKkqautphRMeJh1GRwwa66ZXp7qveZ&refer_page_name=bangdan_list&refer_page_id=17542_1775701551450_adr6k9hl5d&refer_page_sn=17542&page_from=69&activeTab=0',//海尔净水器畅销榜
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=79853010201&scene_id=goods_detail%2Crelated_goods&list_sn=YWG8FnAJIcfbwkU_A_RXQT_L&__list_version=2&_pdd_fs=1&_x_share_id=oELKkqautphRMeJh1GRwwa66ZXp7qveZ&refer_page_name=bangdan_list&refer_page_id=17542_1775701551450_adr6k9hl5d&refer_page_sn=17542&page_from=69&activeTab=0',//品牌纯水机净水器畅销榜
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=65413011501&scene_id=goods_detail%2Crelated_goods&list_sn=YWEHcnN7e1NWVhlQ30pdTbvN&__list_version=2&_pdd_fs=1&_x_share_id=oELKkqautphRMeJh1GRwwa66ZXp7qveZ&refer_page_name=bangdan_list&refer_page_id=17542_1775702641236_u6fgo829zf&refer_page_sn=17542&page_from=69&activeTab=0',//海尔净水器年度畅销榜
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=171369010201&scene_id=goods_detail%2Crelated_goods&list_sn=YWGyVfRiSWv89dY10urI_Kaf&__list_version=2&_pdd_fs=1&_x_share_id=oELKkqautphRMeJh1GRwwa66ZXp7qveZ&refer_page_name=bangdan_list&refer_page_id=17542_1775702648101_tqo520lac4&refer_page_sn=17542&page_from=69&activeTab=0',//品牌超滤机净水器畅销榜
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=45591011501&scene_id=goods_detail%2Crelated_goods&list_sn=YWHNmpo3mhci2IQ-pqPkhwXx&__list_version=2&_pdd_fs=1&_x_share_id=oELKkqautphRMeJh1GRwwa66ZXp7qveZ&refer_page_name=bangdan_list&refer_page_id=17542_1775702696846_q1df1118tp&refer_page_sn=17542&page_from=69&activeTab=0',//品牌上出水厨宝年度畅销榜
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=164451010201&scene_id=goods_detail%2Crelated_goods&list_sn=YWEiZbpD2WU2qGg84hGXtKHL&__list_version=2&_pdd_fs=1&_x_share_id=oELKkqautphRMeJh1GRwwa66ZXp7qveZ&refer_page_name=bangdan_list&refer_page_id=17542_1775702845537_9nxs3kqdib&refer_page_sn=17542&page_from=69&activeTab=0',//品牌苏泊尔净水器畅销榜
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=71122010201&scene_id=goods_detail%2Crelated_goods&list_sn=YWE1PGy9C_ugVbmQCjcC2VPp&__list_version=2&_pdd_fs=1&_x_share_id=oELKkqautphRMeJh1GRwwa66ZXp7qveZ&refer_page_name=bangdan_list&refer_page_id=17542_1775702887436_u0y3abpqcw&refer_page_sn=17542&page_from=69&activeTab=0',//净水器畅销榜
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=3283500376324010801&scene_id=goods_detail%2Crelated_goods&list_sn=YWEGtVMYGg0VC3QLTOb19NLE&__list_version=2&_pdd_fs=1&_x_share_id=oELKkqautphRMeJh1GRwwa66ZXp7qveZ&refer_page_name=bangdan_list&refer_page_id=17542_1775702987487_i1tp7rnl8j&refer_page_sn=17542&page_from=69&activeTab=0',//不锈钢净水器畅销榜
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=3283598229711010801&scene_id=goods_detail%2Crelated_goods&list_sn=YWHuKajJrxFrhOUXq02UwzY8&__list_version=2&_pdd_fs=1&_x_share_id=oELKkqautphRMeJh1GRwwa66ZXp7qveZ&refer_page_name=bangdan_list&refer_page_id=17542_1775703037102_i81065qgyh&refer_page_sn=17542&page_from=69&activeTab=0',//净水器配件耗材畅销榜
        'https://mobile.yangkeduo.com/sjs_cat_rank_list.html?list_id=50781010204&scene_id=goods_detail%2Crelated_goods&list_sn=YWHxcqqnGstfrTZRvuZbf7eH&__list_version=2&_pdd_fs=1&_x_share_id=oELKkqautphRMeJh1GRwwa66ZXp7qveZ&refer_page_name=bangdan_list&refer_page_id=17542_1775702023473_odtept7ds1&refer_page_sn=17542&page_from=69&activeTab=1'//美的净水器降价榜
    ];;

    
    // 指向中台共享浏览器指纹
    const profileDir = path.join(__dirname, '..', '00_Shared_Profiles', 'pdd_yunmi_official');
    
    let context = null;

    try {
        console.log('🚀 正在向中台申请启动带有反爬虫伪装的浏览器实例...');
        
        // 统一调用基座启动浏览器
        context = await browserManager.launchBrowser({ 
            profileDir: profileDir,
            headless: false
        });
        
        const page = context.pages()[0] || await context.newPage();
        
        const todayStr = getLocalMonitorDate(0);      
        const yesterdayStr = getLocalMonitorDate(-1);

        for (let i = 0; i < urls.length; i++) {
            const currentUrl = urls[i];
            console.log(`\n========================================`);
            console.log(`⏳ 准备访问第 ${i + 1}/${urls.length} 个网址: ${currentUrl}`);

            try {
                await page.goto(currentUrl, { waitUntil: 'networkidle', timeout: 30000 });
                console.log(`✅ 页面加载完成，开始检测登录状态...`);

                // 保留原汁原味的人工接管检测逻辑
                try {
                    await page.waitForSelector('div[data-ranking-goods-id]', { state: 'attached', timeout: 4000 });
                    console.log("🔓 状态正常：已识别到商品数据，免登陆直接放行！");
                } catch (error) {
                    console.log("🔒 状态异常：未检测到商品数据，已触发安全拦截或需要人工登录。");
                    console.log("🛑 【人工接管】请在浏览器中完成扫码登录或过验证...");
                    try {
                        await page.waitForSelector('div[data-ranking-goods-id]', { state: 'attached', timeout: 120000 });
                        console.log("▶️ 登录/验证成功！感应到商品数据重载，脚本自动恢复执行...");
                    } catch (timeoutError) {
                        throw new Error("超过 120 秒未完成人工登录，或目标页面根本没有商品列表元素。");
                    }
                }

                const pageData = await page.evaluate(() => {
                    const goodsElements = document.querySelectorAll('div[data-ranking-goods-id]');
                    if (goodsElements.length === 0) {
                        return { error: '未找到商品容器元素' };
                    }

                    const results = Array.from(goodsElements).map((el) => {
                        const goodsId = el.getAttribute('data-ranking-goods-id');
                        const titleEl = el.querySelector('div[title]');
                        const rawTitle = titleEl ? titleEl.getAttribute('title') : "未知名称";

                        let productUrl = "";
                        const aTag = el.querySelector('a[href]');
                        if (aTag && aTag.href) productUrl = aTag.href; 
                        else if (goodsId) productUrl = `https://mobile.yangkeduo.com/goods.html?goods_id=${goodsId}`;

                        const symbolNode = Array.from(el.querySelectorAll('*')).find(node => 
                            node.children.length === 0 && node.innerText.trim() === '￥'
                        );
                        let domPrice = 0;
                        if (symbolNode && symbolNode.parentElement) {
                            const priceText = symbolNode.parentElement.innerText;
                            const match = priceText.match(/\d+(\.\d+)?/);
                            domPrice = match ? parseFloat(match[0]) : 0;
                        }

                        const rawText = el.innerText || "";

                        return {
                            goodsId: goodsId,
                            rawTitle: rawTitle,
                            domPrice: domPrice,
                            rawText: rawText,
                            productUrl: productUrl
                        };
                    });

                    return { data: results };
                });

                if (pageData.error) {
                    console.warn(`⚠️ 警告: ${pageData.error}`);
                } else {
                    console.log(`🎉 成功提取到 ${pageData.data.length} 条商品数据，进入数据清洗入库阶段...`);
                    try {
                        const insertMany = db.transaction((items) => {
                            for (const item of items) {
                                const productId = item.goodsId;
                                if (!productId) continue;
                
                                let cleanTitle = item.rawTitle.replace(/Pr0/gi, 'Pro').toUpperCase();            
                                let textBody = item.rawText.replace(/[\n\r]+/g, ' ');
                
                                // 第一步：净化干扰源 (100%保留)
                                textBody = textBody.replace(/\d+(?:\.\d+)?万?[+＋]?人好评/g, ' ');
                                textBody = textBody.replace(/好评率\s*\d+(?:\.\d+)?%/g, ' ');
                                textBody = textBody.replace(/热卖指数\d+/g, ' ');
                                textBody = textBody.replace(/蝉联榜首\d+天/g, ' ');
                                textBody = textBody.replace(/霸榜前三\d+天/g, ' ');
                                textBody = textBody.replace(/成交价[￥¥]?\d+(?:\.\d+)?/g, ' ');

                                // 第二步：严格贴合提取销量 (100%保留)
                                function extractAndDestroy(regex) {
                                    const match = textBody.match(regex);
                                    if (match) {
                                        let num = parseFloat(match[1]);
                                        if (match[2] === '万') num *= 10000;
                                        textBody = textBody.replace(match[0], ' '); 
                                        return Math.floor(num);
                                    }
                                    return null;
                                }
                
                                let dailySalesTag = extractAndDestroy(/(?:24小时内?|今日|今天)[热卖销]*\s*(\d+(?:\.\d+)?)\s*(万?)[+＋]?\s*(?:件|单|人|次|笔|台|套|个)/);
                                let monthlySales = extractAndDestroy(/(?:30天|近一月|月销)[热卖销]*\s*(\d+(?:\.\d+)?)\s*(万?)[+＋]?\s*(?:件|单|人|次|笔|台|套|个)/);
                                let weeklySales = extractAndDestroy(/(?:一周内?|本周|周销|近期)[热卖销多]*\s*(\d+(?:\.\d+)?)\s*(万?)[+＋]?\s*(?:件|单|人|次|笔|台|套|个)/);
                                let grabbedSales = extractAndDestroy(/已抢\s*(\d+(?:\.\d+)?)\s*(万?)[+＋]?\s*(?:件|单|人|次|笔|台|套|个)?/);
                                
                                let hotSales = extractAndDestroy(/(?:热[销卖]|畅销|回购)\s*(\d+(?:\.\d+)?)\s*(万?)[+＋]?\s*(?:件|单|人|次|笔|台|套|个)/);
                                if (!hotSales) {
                                    hotSales = extractAndDestroy(/(\d+(?:\.\d+)?)\s*(万?)[+＋]?\s*(?:件|单|人|次|笔|台|套|个)[的]*[热畅][销卖]/);
                                }
                                
                                let totalSales = extractAndDestroy(/(?:总[售销]|累计[销卖售]?)\s*(\d+(?:\.\d+)?)\s*(万?)[+＋]?\s*(?:件|单|人|次|笔|台|套|个)?/);
                                if (!totalSales) {
                                    totalSales = extractAndDestroy(/(?<!\d)(\d+(?:\.\d+)?)\s*(万)[+＋]?\s*(?:件|单|人|次|笔|台|套|个)(?:已拼|已售|拼单)?/);
                                }
                                if (!totalSales) {
                                    totalSales = extractAndDestroy(/(?<!\d)(\d+(?:\.\d+)?)\s*[+＋]?\s*(?:件|单|人|次|笔|台|套|个)\s*(?:已拼|已售|拼单)/);
                                }

                                // 第三步：防脏数据覆盖拦截逻辑 (数据护城河)
                                const todayExisting = getTodaySales.get(productId, todayStr);
                                if (todayExisting) {
                                    if (todayExisting.total_sales !== null && totalSales === null) {
                                        continue;
                                    }
                                }

                                // 第四步：动态计算昨日真实增量
                                let dailyIncrement = null;
                                if (totalSales !== null) {
                                    const row = getYesterdaySales.get(productId, yesterdayStr);
                                    if (row && row.total_sales !== null) {
                                        dailyIncrement = totalSales - row.total_sales;
                                        if (dailyIncrement < 0) dailyIncrement = 0; 
                                    }
                                }
        
                                // 执行入库 
                                insertProduct.run({
                                    product_id: productId,
                                    title: cleanTitle,
                                    price: item.domPrice,
                                    total_sales: totalSales,
                                    monthly_sales: monthlySales,
                                    weekly_sales: weeklySales,
                                    daily_sales_tag: dailySalesTag,
                                    hot_sales: hotSales,
                                    grabbed_sales: grabbedSales,
                                    daily_increment: dailyIncrement,
                                    product_url: item.productUrl,
                                    monitor_date: todayStr
                                });
                            }
                        });
                        insertMany(pageData.data);
                        console.log(`💾 当前页面数据已成功清洗并写入 SQLite 数据库。`);
                        
                    } catch (error) {
                        console.error("[数据入库阶段发生严重错误] 报错信息:", error);
                    }
                } 

                const randomDelay = Math.floor(Math.random() * 3000) + 2000;
                console.log(`💤 模拟人工停顿 ${randomDelay} 毫秒...`);
                await page.waitForTimeout(randomDelay);

            } catch (error) {
                console.error(`❌ 访问或解析页面失败: ${currentUrl}`);
                console.error(`错误详情: ${error.message}`);
                
                const screenshotPath = `error_screenshot_${Date.now()}.png`;
                await page.screenshot({ path: screenshotPath, fullPage: true }).catch(()=>{});
                console.log(`📸 已保存错误现场截图至: ${screenshotPath}`);
            }
        }

    } catch (globalErr) {
        console.error(`❌ [App2 市场雷达] 致命崩溃:`, globalErr.message);
    } finally {
        // 中台架构：任务完成后安全释放当前业务线的资源
        if (context) await context.close();
        if (db) db.close();
        console.log(`\n========================================`);
        console.log(`🎯 市场竞品大盘雷达任务结束！`);
    }
}

// 导出为标准 App 总控
module.exports = { startApp };