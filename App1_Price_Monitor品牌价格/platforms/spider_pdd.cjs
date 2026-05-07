// platforms/spider_pdd.cjs
// 【架构升级】：接收总控 page，剥离浏览器启停控制，保留智能登录与风控体系

const path = require('path');
const { DateTime } = require('luxon');

// 引入底层基座 (路径更新为中台)
const browserManager = require('../../00_Core_Infrastructure/browser_manager.cjs');
const dbManager = require('../../00_Core_Infrastructure/db_manager.cjs');

// PDD 专属配置与辅助函数
const TARGET_URL = "https://mms.pinduoduo.com/kit/goods-price-management?tool_full_channel=10323_97807&msfrom=mms_globalsearch";

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
 * 递归深度查找 JSON 中的有效商品对象
 */
function deepFindGoods(obj, found = []) {
    if (typeof obj !== 'object' || obj === null) return found;
    if (Array.isArray(obj)) {
        for (const item of obj) deepFindGoods(item, found);
    } else {
        if ('goods_id' in obj && ('sku_promo_list' in obj || 'sku_list' in obj)) {
            found.push(obj);
        } 
        for (const key of Object.keys(obj)) {
            deepFindGoods(obj[key], found);
        }
    }
    return found;
}

/**
 * 拼多多抓取主函数
 */
async function run(page, tasks, storeConfig, screenshotDir) {
    console.log(`\n=============================================`);
    console.log(`📦 [拼多多模块] 启动监控 -> 店铺: ${storeConfig.storeName} (智能防覆盖与精细解包模式)`);
    console.log(`=============================================`);

    // ==================== 增量修改：查总表获取权威 ID ====================
    let new_records = [];
    let limitMap = {};
    let validGoodsIds = [];
    
    // 1. 直连本地基座数据库
    const db = dbManager.getRawDbInstance();
    const targetPlatform = storeConfig.targetPlatform || '拼多多';
    
    console.log(`   🔍 正在连接 [pdd_goods_master] 总表，提取 [${targetPlatform}] 精确商品档案...`);
    
    // 🔧 [核心修复]：将原来的 product_name 替换为你表里真实的列名！这里假设是 goods_name。
    // 如果你的表里叫 title，就把这句里的 goods_name 改成 title。
    const masterRows = db.prepare(`
        SELECT DISTINCT goods_id, sku_id, goods_name 
        FROM pdd_goods_master 
        WHERE platform = ? AND goods_id IS NOT NULL AND goods_id != ''
    `).all(targetPlatform);

    if (masterRows.length === 0) {
        console.log(`   ❌ [异常] pdd_goods_master 中未找到该店铺的商品清单，终止抓取。`);
        return [];
    }

    // 2. 组装神圣的 ID 映射表，强制将 69码 锁死到 barcode 字段中
    masterRows.forEach(row => {
        const strGoodsId = String(row.goods_id);
        validGoodsIds.push(strGoodsId);
        limitMap[strGoodsId] = {
            limit: 0, 
            barcode: row.sku_id, 
            // 🔧 [核心修复]：这里接收的变量名也要和上面 SELECT 查询的一致！
            productName: row.goods_name || "未知商品" 
        };
    });

    // 3. 将 main_controller 传进来的日常任务限价 (如果有) 挂载上去
    if (tasks && tasks.length > 0) {
        tasks.forEach(t => {
            for (const gid in limitMap) {
                if (limitMap[gid].barcode === t.sku_id || limitMap[gid].barcode === t.barcode) {
                    limitMap[gid].limit = t.limitPrice || 0;
                }
            }
        });
    }

    const allGoodsIdString = validGoodsIds.join(',');
    console.log(`   🎯 成功从总表提取 ${validGoodsIds.length} 个唯一商品 ID，准备注入 UI 面板。`);
// ====================================================================

    const networkDataPool = new Map();
    const itemsToExpand = []; 

    // ==========================================
    // 【签名窃取与双流拦截器】
    // ==========================================
    let globalPddHeaders = {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    };

    page.on('request', req => {
        const url = req.url();
        if (url.includes('query_goods_price_with_page') || url.includes('goods_price')) {
            const h = req.headers();
            ['anti-content', 'accesstoken', 'access-token', 'authorization'].forEach(key => {
                if (h[key]) globalPddHeaders[key] = h[key];
            });
        }
    });

    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('query_goods_price_with_page') || url.includes('goods_price')) {
            const reqType = response.request().resourceType();
            if (reqType === 'xhr' || reqType === 'fetch') {
                try {
                    const json = await response.json();
                    const items = deepFindGoods(json); 
                    
                    if (items.length > 0) {
                        console.log(`   📡 [网络主线] 列表截获成功，发现 ${items.length} 个商品。`);
                        items.forEach(item => {
                            if (item.goods_id) {
                                const idStr = String(item.goods_id);
                                const existing = networkDataPool.get(idStr) || {};
                                
                                if (item.sku_promo_list && item.sku_promo_list.length > (existing.sku_promo_list?.length || 0)) {
                                    networkDataPool.set(idStr, { ...existing, ...item });
                                } else if (!networkDataPool.has(idStr)) {
                                    networkDataPool.set(idStr, item);
                                }

                                // 【修复核心 1】：绝对不碰单 SKU 商品！只有检测到真有未展示的 SKU 时，才加入展开队列
                                if (item.remain_sku_num > 0) {
                                    const exposed = (item.sku_promo_list || []).map(s => s.sku_id);
                                    if (!itemsToExpand.some(t => t.goods_id === item.goods_id)) {
                                        itemsToExpand.push({
                                            goods_id: item.goods_id,
                                            exposed_sku_id_list: exposed
                                        });
                                    }
                                }
                            }
                        });
                    }
                } catch (e) {}
            }
        }
    });

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

        // ==================== 增量修改：精准注入 ID 执行搜索 ====================
        console.log("   🔄 确保进入抓价工具页...");
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
        await page.waitForSelector('table[class*="TB_tableWrapper"]', { timeout: 20000 });
        
        // 🌟 按照提供的底层 DOM 结构精确匹配输入框和按钮
        const inputLocator = page.locator('#goodsId input[data-testid="beast-core-input-htmlInput"], input[placeholder*="多个ID以逗号"]').first();
        const searchBtn = page.locator('button[data-tracking-click-viewid="search_click"], button:has-text("查询")').first();

        console.log(`   🖱️ 正在将 ${validGoodsIds.length} 个商品 ID 粘贴至检索框...`);
        await inputLocator.clear();
        await inputLocator.click();
        await inputLocator.fill(allGoodsIdString);
        
        // 🔧 [防爆机制]：拼多多的前端框架极易出现“值填进去了但没生效”的情况，手动注入双向绑定事件
        await inputLocator.evaluate(node => {
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
            node.dispatchEvent(new Event('blur', { bubbles: true }));
        });

        await page.waitForTimeout(1000);
        await searchBtn.click({ force: true });
        
        console.log(`   🚀 查询指令已发送，准备拦截并解析响应数据流...`);
        let hasNextPage = true;
// ====================================================================
        let pageNum = 1;

        while (hasNextPage) {
            console.log(`\n📄 [PDD] --- 第 ${pageNum} 页 ---`);
            console.log("⏳ [PDD] 等待主列表数据流...");
            await page.waitForTimeout(4000); 

            // 主动请求触发器
            if (itemsToExpand.length > 0) {
                console.log(`   👉 发现 ${itemsToExpand.length} 个存在折叠的复杂商品，开始精准展开...`);
                for (const task of itemsToExpand) {
                    try {
                        const expandResult = await page.evaluate(async ({ goodsId, exposedList, headers }) => {
                            const url = "https://mms.pinduoduo.com/madrid/price_manage/expand_all_sku";
                            const payload = {
                                goods_id: goodsId,
                                consult_price_scene_list: [7], 
                                exposed_sku_id_list: exposedList
                            };
                            
                            const res = await fetch(url, {
                                method: 'POST',
                                headers: headers, 
                                body: JSON.stringify(payload)
                            });
                            return await res.json();
                        }, { 
                            goodsId: task.goods_id, 
                            exposedList: task.exposed_sku_id_list,
                            headers: globalPddHeaders 
                        });

                        // 【修复核心 2】：防空包覆盖。只在确实获取到数组且有内容时才进行覆写合并！
                        if (expandResult && expandResult.result && Array.isArray(expandResult.result.sku_promo_list) && expandResult.result.sku_promo_list.length > 0) {
                            const idStr = String(task.goods_id);
                            const existing = networkDataPool.get(idStr) || {};
                            networkDataPool.set(idStr, { ...existing, ...expandResult.result });
                            console.log(`      ✅ 穿透成功: ID ${task.goods_id} -> 补齐 ${expandResult.result.sku_promo_list.length} 个 SKU 明细`);
                        } else {
                            console.log(`      ⚠️ 穿透响应空包: ID ${task.goods_id}，已保留原数据不受破坏。`);
                        }
                    } catch (err) {}
                    await randomDelay(800, 1500); 
                }
                itemsToExpand.length = 0; 
            }

            if (networkDataPool.size > 0) {
                console.log(`   📦 本页内存池共结算 ${networkDataPool.size} 个商品，准备展开为多条记录...`);
                
                for (const [matchedId, itemData] of networkDataPool.entries()) {
                    try {
                        const goodsName = itemData.goods_name || "未知商品名称";
                        const info = limitMap[matchedId] || { 
                            limit: 0, 
                            barcode: matchedId, 
                            productName: goodsName 
                        };
                        const refPrice = info.limit;

                        let skus = itemData.sku_promo_list || itemData.sku_list || [];

                        if (skus.length > 0) {
                            skus.forEach(sku => {
                                const groupPrice = sku.group_price ? (sku.group_price / 100).toFixed(2) : 0;
                                let promoPrice = groupPrice; 
                                
                                const calcDetails = sku.calculate_price_detail_list;
                                if (calcDetails && calcDetails.length > 0 && calcDetails[0].promo_price_list) {
                                    promoPrice = (calcDetails[0].promo_price_list[0] / 100).toFixed(2);
                                } else if (sku.activity_price_info && sku.activity_price_info.activity_price) {
                                    // 备选兜底：如果场景列表没给，直接提取外层活动价格
                                    promoPrice = (sku.activity_price_info.activity_price / 100).toFixed(2);
                                }

                                const currentPrice = parseFloat(promoPrice);
                                let status = "正常";

                                // 独立评判每个 SKU 是否破价
                                if (refPrice > 0 && currentPrice > 0) {
                                    const alertThreshold = refPrice * 0.97;
                                    if (currentPrice < alertThreshold) {
                                        status = "破价警报";
                                        console.log(`   🚨 [破价] ID:${matchedId} | 规格:${sku.sku_spec} | ${currentPrice} < 限价 ${refPrice}`);
                                    } else if (currentPrice > refPrice) {
                                        status = "高价待调整";
                                    }
                                }

                                // 【修复核心 3】：精准捕获百亿补贴等官方标签
                                let activityTag = "";
                                if (sku.activity_price_info && sku.activity_price_info.activity_type_desc) {
                                    activityTag = sku.activity_price_info.activity_type_desc; // 例如："百亿补贴"
                                }
                                if (activityTag) {
                                    status = (status === "正常") ? activityTag : `${status} | ${activityTag}`;
                                }

                                new_records.push({
                                    Platform: storeConfig.targetPlatform || "拼多多",
                                    URL: `https://mobile.yangkeduo.com/goods.html?goods_id=${matchedId}`,
                                    Product_Name: info.productName,
                                    SKU_Identifier: info.barcode,               
                                    True_SKU_Identifier: matchedId,             
                                    Platform_SKU_ID: String(sku.sku_id || ""),  
                                    Spec: sku.sku_spec || sku.spec || "默认规格", 
                                    Group_Price: parseFloat(groupPrice),        
                                    Price: currentPrice,                        
                                    Limit_Price: refPrice > 0 ? refPrice : "",
                                    Price_Status: status, 
                                    Scrape_Date: "", 
                                    Main_Image_URL: "无截图"
                                });
                            });
                        } else {
                            // 极端兜底逻辑
                            let currentPrice = itemData.group_price ? (itemData.group_price / 100) : 0;
                            let status = "正常";
                            if (refPrice > 0 && currentPrice > 0) {
                                const alertThreshold = refPrice * 0.97;
                                if (currentPrice < alertThreshold) status = "破价警报";
                                else if (currentPrice > refPrice) status = "高价待调整";
                            }

                            new_records.push({
                                Platform: storeConfig.targetPlatform || "拼多多",
                                URL: `https://mobile.yangkeduo.com/goods.html?goods_id=${matchedId}`,
                                Product_Name: info.productName,
                                SKU_Identifier: info.barcode, 
                                True_SKU_Identifier: matchedId, 
                                Platform_SKU_ID: matchedId, 
                                Spec: "单机/默认规格",
                                Group_Price: currentPrice,
                                Price: currentPrice,
                                Limit_Price: refPrice > 0 ? refPrice : "",
                                Price_Status: status, 
                                Scrape_Date: "", 
                                Main_Image_URL: "无截图"
                            });
                        }
                        
                    } catch (err) {}
                }
            }

            networkDataPool.clear();

            // 翻页逻辑
            const nextBtn = page.locator('li[data-testid="beast-core-pagination-next"]');
            if (await nextBtn.count() > 0 && await nextBtn.isVisible()) {
                const classAttr = await nextBtn.getAttribute('class') || "";
                if (classAttr.includes('disabled')) {
                    hasNextPage = false;
                } else { 
                    await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
                    await nextBtn.click({ force: true });
                    await randomDelay(3000, 4500); 
                    pageNum++;
                }
            } else { 
                hasNextPage = false;
            }
        }

    } catch (e) {
        console.error(`[PDD] 平台运行致命错误: ${e}`);
    } finally {
        if (new_records.length > 0) {
            const uniqueRecordsMap = new Map();
            new_records.forEach(record => {
                const uniqueKey = `${record.Platform}_${record.True_SKU_Identifier}_${record.Platform_SKU_ID}`;
                if (!uniqueRecordsMap.has(uniqueKey)) {
                    uniqueRecordsMap.set(uniqueKey, record);
                }
            });
            
            const deduplicated_records = Array.from(uniqueRecordsMap.values());
            const scrapeTime = DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss');
            
            deduplicated_records.forEach(record => {
                record.Scrape_Date = scrapeTime;
            });

            console.log(`   🧽 [数据清洗] 去重完成: 从 ${new_records.length} 个 SKU 中提出 ${deduplicated_records.length} 条有效记录。`);
            
            try {
                dbManager.save_results_to_db(deduplicated_records);
            } catch (dbErr) {
                console.error(`   ❌ [平台调用层] 数据库写入致命异常: ${dbErr.message}`);
            }
        }
        
        console.log(`[PDD] 全店模块执行完毕。`);
        return new_records;
    }
}

module.exports = { run };