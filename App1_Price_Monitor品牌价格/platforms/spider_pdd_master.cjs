// platforms/spider_pdd.cjs
// 【架构升级】：接收总控 page，剥离浏览器启停控制，保留智能登录与风控体系

const path = require('path');
const { DateTime } = require('luxon');

// 引入底层基座 (路径更新为中台)
const browserManager = require('../../00_Core_Infrastructure/browser_manager.cjs');
const dbManager = require('../../00_Core_Infrastructure/db_manager.cjs');

// 目标直指商品管理总表页面
const TARGET_URL = "https://mms.pinduoduo.com/goods/goods_list";

function extractIdFromInput(inputStr) {
    if (!inputStr) return "";
    const str = inputStr.toString().trim();
    if (/^\d+$/.test(str)) return str;
    try {
        const urlObj = new URL(str);
        const id = urlObj.searchParams.get("goods_id");
        if (id) return id;
    } catch (e) {
        const match = str.match(/goods_id=(\d+)/);
        if (match) return match[1];
    }
    return str;
}

const randomDelay = (min = 1000, max = 3000) => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

/**
 * 拼多多抓取主函数 (全维数据 UI 驱动被动提取模式)
 */
async function run(page, tasks, storeConfig, screenshotDir) {
    console.log(`\n=============================================`);
    console.log(`📦 [拼多多模块] 启动监控 -> 店铺: ${storeConfig.storeName} (纯净 UI 驱动总表构建)`);
    console.log(`=============================================`);

    let new_records = [];
    let limitMap = {};

    if (tasks && tasks.length > 0) {
        tasks.forEach(task => {
            const rawId = extractIdFromInput(task.url);
            if (rawId) {
                limitMap[rawId] = { 
                    limit: task.limitPrice, 
                    barcode: task.barcode, 
                    productName: task.productName 
                };
            }
        });
    }

    // ==========================================
    // 【终极被动拦截器】：完全不主动发请求，只截胡官方 UI 拿到的合法数据
    // ==========================================
    let pendingGoodsBatch = [];

    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('/vodka/v2/mms/query/display/mall/goodsList')) {
            const reqType = response.request().resourceType();
            if (reqType === 'xhr' || reqType === 'fetch') {
                try {
                    const json = await response.json();
                    if (json && json.success && json.result && json.result.goods_list) {
                        const list = json.result.goods_list;
                        if (list.length > 0) {
                            // 将截获的官方数据塞入处理队列
                            pendingGoodsBatch.push(...list);
                            console.log(`   📡 [底层截获] 成功捕获官方请求返回的 ${list.length} 个商品包！`);
                        }
                    }
                } catch (e) {
                    // 非标准 JSON 或网络流中断，静默跳过
                }
            }
        }
    });
    // ==========================================

    try {
        const pddLoginConfig = {
            platform: `拼多多-${storeConfig.storeName}`,
            checkUrl: TARGET_URL,
            loginUrlKeyword: 'login', 
            userSelector: 'input#usernameId', 
            passSelector: 'input#passwordId', 
            submitSelector: 'button[type="submit"]',
            envUserKey: storeConfig.envUserKey,
            envPassKey: storeConfig.envPassKey,
            defaultUser: storeConfig.defaultUser
        };

        await browserManager.smartLogin(page, pddLoginConfig);

        console.log("   🔄 正在进入全店商品总表后台...");
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // ==========================================
        // 【物理翻页引擎】：模拟人类点击下一页，完美规避签名哈希校验
        // ==========================================
        let currentPage = 1;
        let hasNextPage = true;

        // 给首页充分的加载时间，让被动拦截器先吃到第一波数据
        await page.waitForTimeout(5000);

        while (hasNextPage) {
            console.log(`\n📄 [数据脱水] --- 正在处理总库 第 ${currentPage} 页 ---`);
            
            // 1. 等待数据池就绪 (防网络延迟)
            let waitTime = 0;
            while (pendingGoodsBatch.length === 0 && waitTime < 10000) {
                await page.waitForTimeout(1000);
                waitTime += 1000;
            }

            // 2. 清洗截获的数据
            if (pendingGoodsBatch.length > 0) {
                console.log(`   📦 开始展开本页截获的 ${pendingGoodsBatch.length} 个主商品 SKU 矩阵...`);
                
                // 将当前批次拿出来处理，并清空队列供下一页使用
                const currentList = [...pendingGoodsBatch];
                pendingGoodsBatch = []; 

                currentList.forEach(item => {
                    try {
                        const goodsId = String(item.id);
                        const goodsName = item.goods_name || "";
                        const mainOutSn = item.out_goods_sn || ""; 
                        const brandName = item.brand_name || "";
                        
                        const categoryPath = [item.cat_name_1, item.cat_name_2, item.cat_name_3, item.cat_name_4]
                            .filter(Boolean).join(" > ");
                        
                        const soldQuantity = item.sold_quantity || 0;
                        const soldQuantity30d = item.sold_quantity_for_thirty_days || 0;
                        const isGoodsOnsale = item.is_onsale ? 1 : 0;
                        
                        const createdAt = item.created_at ? DateTime.fromSeconds(item.created_at).toFormat('yyyy-MM-dd HH:mm:ss') : "";
                        const updatedAt = item.updated_at ? DateTime.fromSeconds(item.updated_at).toFormat('yyyy-MM-dd HH:mm:ss') : "";

                        let activityName = "";
                        if (item.promotion_goods && item.promotion_goods.activity_name) {
                            activityName = item.promotion_goods.activity_name;
                        } else if (item.resource_hover && item.resource_hover["百亿补贴"]) {
                            activityName = "百亿补贴";
                        }

                        const info = limitMap[goodsId] || { 
                            limit: 0, 
                            barcode: mainOutSn, 
                            productName: goodsName 
                        };
                        const refPrice = info.limit;

                        const skus = item.sku_list || [];

                        if (skus.length > 0) {
                            skus.forEach(sku => {
                                const skuId = String(sku.skuId);
                                const outSkuSn = sku.outSkuSn || mainOutSn || "";
                                const spec = sku.spec || sku.newSpec || "默认规格";
                                const skuQuantity = sku.skuQuantity || 0;
                                const isSkuOnsale = sku.isOnsale ? 1 : 0;

                                const normalPrice = sku.normalPrice ? (sku.normalPrice / 100).toFixed(2) : 0;
                                const groupPrice = sku.groupPrice ? (sku.groupPrice / 100).toFixed(2) : 0;
                                const activityGroupPrice = sku.activityGroupPrice ? (sku.activityGroupPrice / 100).toFixed(2) : 0;
                                
                                const finalPrice = parseFloat(activityGroupPrice) > 0 ? parseFloat(activityGroupPrice) : parseFloat(groupPrice);
                                
                                const thumbUrl = sku.skuThumbUrl || item.hd_thumb_url || item.thumb_url || "";

                                let status = "正常";
                                if (refPrice > 0 && finalPrice > 0) {
                                    const alertThreshold = refPrice * 0.97;
                                    if (finalPrice < alertThreshold) {
                                        status = "破价警报";
                                    } else if (finalPrice > refPrice) {
                                        status = "高价待调整";
                                    }
                                }
                                if (activityName) status = (status === "正常") ? activityName : `${status} | ${activityName}`;

                                new_records.push({
                                    Platform: storeConfig.targetPlatform || "拼多多",
                                    Store_Name: storeConfig.storeName || "",
                                    Goods_ID: goodsId,
                                    Goods_Name: goodsName,
                                    Out_Goods_SN: mainOutSn,
                                    Cat_Name: categoryPath,
                                    Brand_Name: brandName,
                                    Sold_Quantity: soldQuantity,
                                    Sold_Quantity_30d: soldQuantity30d,
                                    Goods_Is_Onsale: isGoodsOnsale,
                                    Goods_Created_At: createdAt,
                                    Goods_Updated_At: updatedAt,
                                    Activity_Name: activityName,
                                    SKU_ID: skuId,
                                    SKU_Spec: spec,
                                    Out_SKU_SN: outSkuSn,
                                    SKU_Quantity: skuQuantity,
                                    SKU_Is_Onsale: isSkuOnsale,
                                    Normal_Price: parseFloat(normalPrice),
                                    Group_Price: parseFloat(groupPrice),
                                    Activity_Price: parseFloat(activityGroupPrice),
                                    Final_Price: finalPrice,
                                    Thumb_URL: thumbUrl,
                                    Scrape_Date: "" 
                                });
                            });
                        }
                    } catch (itemErr) {
                        console.error(`   ⚠️ 提取商品级数据出现异常: ${itemErr.message}`);
                    }
                });
            } else {
                console.log(`   ⚠️ 本页未截获任何数据，可能遇到网络阻塞或列表为空。`);
            }

            // 3. 驱动页面 UI 点击下一页
            try {
                // 兼容拼多多各种可能的分页器选择器 (AntD / BeastUI)
                const nextBtnSelectors = 'li[title="下一页"], li[data-testid="beast-core-pagination-next"], .beast-core-pagination-next, .ant-pagination-next';
                const nextBtn = page.locator(nextBtnSelectors).locator('visible=true').first();

                if (await nextBtn.count() > 0) {
                    const classAttr = await nextBtn.getAttribute('class') || "";
                    const ariaDisabled = await nextBtn.getAttribute('aria-disabled') || "";

                    if (classAttr.includes('disabled') || ariaDisabled === "true") {
                        console.log("   🛑 下一页按钮已置灰，全店总库物理遍历完成！");
                        hasNextPage = false;
                    } else {
                        await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
                        await nextBtn.click({ force: true });
                        console.log("   👉 已点击下一页，等待官方前端请求新数据...");
                        currentPage++;
                        // 强制延迟，等待页面发起 AJAX 并在后台被我们截获
                        await randomDelay(3000, 4500); 
                    }
                } else {
                    console.log("   ⚠️ 未找到下一页按钮，可能只有一页数据。");
                    hasNextPage = false;
                }
            } catch (e) {
                console.log(`   ⚠️ 翻页操作异常: ${e.message}，结束遍历。`);
                hasNextPage = false;
            }
        }

    } catch (e) {
        console.error(`[PDD] 平台运行致命错误: ${e}`);
    } finally {
        if (new_records.length > 0) {
            // 纯净去重，防止循环翻页导致的数据重叠
            const uniqueRecordsMap = new Map();
            new_records.forEach(record => {
                const uniqueKey = `${record.Platform}_${record.Goods_ID}_${record.SKU_ID}`;
                if (!uniqueRecordsMap.has(uniqueKey)) {
                    uniqueRecordsMap.set(uniqueKey, record);
                }
            });
            
            const deduplicated_records = Array.from(uniqueRecordsMap.values());
            
            // 统一批次时间戳 (数据库端请确保约束为: platform, store_name, goods_id, sku_id, scrape_time)
            const scrapeTime = DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss');
            deduplicated_records.forEach(record => {
                record.Scrape_Date = scrapeTime;
            });

            console.log(`   🧽 [数据清洗] 全维总表构建完成: 共输出 ${deduplicated_records.length} 条独立的 SKU 记录。`);
            
            try {
                dbManager.save_master_results_to_db(deduplicated_records);
            } catch (dbErr) {
                console.error(`   ❌ [平台调用层] 数据库写入致命异常: ${dbErr.message}`);
            }
        }
        
        console.log(`[PDD] 全店总表拉取完毕。`);
        return new_records;
    }
}

module.exports = { run };