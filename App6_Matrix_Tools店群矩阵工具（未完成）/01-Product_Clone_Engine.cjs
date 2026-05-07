// App6_Matrix_Tools店群矩阵工具/01-Product_Clone_Engine.cjs
// 【修复抢跑 Bug】：已去除自执行副作用，包装为标准组件供 Global_Runner 调度

const path = require('path');
const fs = require('fs');

// ======================= [中台基座接入] =======================
const browserManager = require('../00_Core_Infrastructure/browser_manager.cjs');

// ======================= [战术配置区] =======================
const CONFIG = {
    PRICE_SAFE_MULTIPLIER: 4.9, // B店价格不能超过 A店价格的 4.9 倍（防违规）
    // 任务清单：sourceA 为源店商品ID，targetB 为目标店需要覆盖的相似品ID
    TASK_LIST: [
        { sourceA: '774960777953', targetB: '942736093204' },
    ],
    // 店铺指纹配置
    STORES: {
        A: {
            name: '云米拼多多官方店 (源)',
            profile: 'pdd_yunmi_official'
        },
        B: {
            name: '云米拼多多新店 (目标)',
            profile: 'pdd_yunmi_new'
        }
    }
};

// ======================= [核心战术引擎] =======================
// 重点：只定义，不自执行！
async function startApp() {
    console.log(`\n🚀 --- 【矩阵战术工具】跨店商品克隆引擎启动 ---`);
    
    let contextA = null;
    let contextB = null;

    try {
        // 1. 分别从基座申请两个独立的浏览器上下文（A店与B店隔离运行）
        console.log(`📡 正在连接基座：获取 [A店:${CONFIG.STORES.A.name}] 指纹环境...`);
        contextA = await browserManager.launchBrowser({ 
            profileDir: path.join(__dirname, '..', '00_Shared_Profiles', CONFIG.STORES.A.profile) 
        });

        console.log(`📡 正在连接基座：获取 [B店:${CONFIG.STORES.B.name}] 指纹环境...`);
        contextB = await browserManager.launchBrowser({ 
            profileDir: path.join(__dirname, '..', '00_Shared_Profiles', CONFIG.STORES.B.profile) 
        });

        const goodsListUrl = 'https://mms.pinduoduo.com/goods/goods_list';

        // 2. 遍历执行克隆任务
        for (let i = 0; i < CONFIG.TASK_LIST.length; i++) {
            const task = CONFIG.TASK_LIST[i];
            console.log(`\n▶️ [任务 ${i + 1}/${CONFIG.TASK_LIST.length}] A店:${task.sourceA} ➡️ B店:${task.targetB}`);

            let productA_Data = null;
            let productA_DecorationData = null;
            let bStoreSniffedMaxPriceCents = 0;
            let taskSuccess = false;

            const pageA = contextA.pages()[0] || await contextA.newPage();
            const pageB = contextB.pages()[0] || await contextB.newPage();
            let editPageB = null;

            // ==========================================
            // 阶段一：A店数据劫持 (Sniffing)
            // ==========================================
            console.log(`🔍 [A店] 正在截获源数据...`);
            await pageA.goto(goodsListUrl, { waitUntil: 'domcontentloaded' });
            
            const inputA = pageA.locator('div').filter({ hasText: /^商品ID$/ }).getByTestId('beast-core-input-htmlInput').first();
            await inputA.waitFor({ state: 'visible', timeout: 15000 });
            await inputA.fill(task.sourceA);
            await inputA.evaluate(node => {
                node.dispatchEvent(new Event('input', { bubbles: true }));
                node.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await pageA.getByRole('button', { name: '查询' }).click();
            
            try { 
                await pageA.getByTestId('beast-core-modal-close-button').waitFor({ state: 'visible', timeout: 3000 }); 
                await pageA.getByTestId('beast-core-modal-close-button').click();
            } catch (e) {}

            const editBtnA = pageA.getByTestId('beast-core-table-body-tr').getByText('编辑').first();
            await editBtnA.waitFor({ state: 'visible', timeout: 10000 });

            const newPagePromiseA = contextA.waitForEvent('page');
            await editBtnA.click();
            const editPageA = await newPagePromiseA;
            await editPageA.waitForLoadState('domcontentloaded');

            // 挂载数据窃听器
            let aDataCaptured = false;
            editPageA.on('request', request => {
                if (request.method() === 'POST' && request.url().includes('action/edit')) {
                    try { productA_Data = JSON.parse(request.postData()); console.log(`✅ [后台窃听] 成功截获 A 店【主商品】数据！`); aDataCaptured = true; } catch (e) {}
                } else if (request.method() === 'POST' && request.url().includes('decoration/commit/save')) {
                    try { productA_DecorationData = JSON.parse(request.postData()); console.log(`✅ [后台窃听] 成功截获 A 店【商详装修】数据！`); } catch (e) {}
                }
            });

            await editPageA.route('**/action/edit*', async (route) => await route.continue());
            await editPageA.route('**/decoration/commit/save*', async (route) => await route.continue());

            console.log(`🖱️ [自动化] 正在自动触发 A 店保存动作...`);
            try { 
                await editPageA.getByRole('button', { name: '提交' }).click(); 
            } catch (e) { 
                console.log(`⚠️ [人工介入] 请手动点击 A 店【提交】。`);
            }

            for(let j=0; j<15; j++) { 
                if (aDataCaptured) break; 
                await editPageA.waitForTimeout(1000); 
            }

            if (!productA_Data) { 
                console.log(`❌ 未能截获 A 店数据，跳过任务。`); 
                if (!editPageA.isClosed()) await editPageA.close();
                continue; 
            }
            if (!editPageA.isClosed()) await editPageA.close();

            // ==========================================
            // 阶段二：B店数据融合与注入 (Injection)
            // ==========================================
            console.log(`🧪 [B店] 启动“借尸还魂”注入程序...`);
            await pageB.goto(goodsListUrl, { waitUntil: 'domcontentloaded' });
            
            const inputB = pageB.locator('div').filter({ hasText: /^商品ID$/ }).getByTestId('beast-core-input-htmlInput').first();
            await inputB.waitFor({ state: 'visible', timeout: 15000 });
            await inputB.fill(task.targetB);
            await inputB.evaluate(node => { 
                node.dispatchEvent(new Event('input', { bubbles: true })); 
                node.dispatchEvent(new Event('change', { bubbles: true })); 
            });
            await pageB.getByRole('button', { name: '查询' }).click();

            try { 
                await pageB.getByTestId('beast-core-modal-close-button').waitFor({ state: 'visible', timeout: 3000 }); 
                await pageB.getByTestId('beast-core-modal-close-button').click();
            } catch (e) {}

            const editBtnB = pageB.getByTestId('beast-core-table-body-tr').getByText('发布相似品').first();
            await editBtnB.waitFor({ state: 'visible', timeout: 10000 });

            // 开启 B 店价格嗅探
            const sniffListener = async (response) => {
                if ((response.request().resourceType() === 'fetch' || response.request().resourceType() === 'xhr') && response.url().includes('goods')) {
                    try {
                        const text = await response.text();
                        if (text.includes('group_price') || text.includes('normal_price') || text.includes('sku_price')) {
                            const regex = /"(?:normal_price|group_price|sku_price|goods_price)"\s*:\s*(\d+)/g;
                            let match;
                            while ((match = regex.exec(text)) !== null) {
                                const p = parseInt(match[1], 10);
                                if (p > bStoreSniffedMaxPriceCents && p < 10000000) bStoreSniffedMaxPriceCents = p;
                            }
                        }
                    } catch(e) {}
                }
            };
            contextB.on('response', sniffListener);

            console.log(`🖱️ [自动化] 正在点击【发布相似品】...`);
            const newPagePromiseB = contextB.waitForEvent('page');
            await editBtnB.click();
            await pageB.getByRole('button', { name: '确认' }).click().catch(()=>{});

            editPageB = await newPagePromiseB;
            await editPageB.waitForLoadState('domcontentloaded');

            // --- 核心：劫持 B 店提交接口，注入 A 店数据 ---
            console.log(`\n⚙️ [拦截监听] 正在挂载 B 店全域数据修改器...`);
            await editPageB.route(/.*(action\/edit|commit\/submit).*/, async (route, request) => {
                if (request.method() !== 'POST') return route.continue();
                
                try {
                    let originalBData = JSON.parse(request.postData());
                    if (productA_Data) {
                        let scaleFactor = 1;

                        // 价格红线判定
                        let maxPriceB = originalBData.skus && originalBData.skus.length > 0 ? 
                            Math.max(...originalBData.skus.map(s => Number(s.normal_price || s.group_price || s.sku_price || 0))) : 
                            Number(originalBData.goods_price || 0); 
                            
                        if (maxPriceB > 0 && productA_Data.skus && productA_Data.skus.length > 0) {
                            let maxPriceA = Math.max(...productA_Data.skus.map(s => Number(s.normal_price || s.group_price || s.sku_price || 0)));
                            let limitPrice = maxPriceB * CONFIG.PRICE_SAFE_MULTIPLIER;
                            if (maxPriceA > limitPrice) {
                                scaleFactor = limitPrice / maxPriceA;
                                console.log(`🛡️ [自动破局] 启动“等比压缩”，强行缩小价格过审... (系数: ${scaleFactor.toFixed(2)})`);
                            }
                        }

                        // 融合数据
                        originalBData.goods_name = productA_Data.goods_name;
                        originalBData.goods_desc = productA_Data.goods_desc; 
                        originalBData.gallery = productA_Data.gallery; 
                        originalBData.goods_properties = productA_Data.goods_properties; 
                        
                        originalBData.quantity = 999;
                        originalBData.goods_quantity = 999;
                        originalBData.is_onsale = 1;

                        if (productA_Data.skus) { 
                            originalBData.skus = productA_Data.skus.map(sku => ({ 
                                ...sku, 
                                id: undefined, 
                                sku_id: undefined,
                                normal_price: Math.floor(Number(sku.normal_price || 0) * scaleFactor), 
                                group_price: Math.floor(Number(sku.group_price || 0) * scaleFactor), 
                                sku_price: Math.floor(Number(sku.sku_price || 0) * scaleFactor),
                                quantity: 999,
                                sku_quantity: 999,
                                stock: 999,
                                stock_num: 999,
                                init_quantity: 999,
                                is_onsale: 1
                            }));
                        }
                    }
                    await route.continue({ postData: JSON.stringify(originalBData) });
                    console.log(`🎉 [任务完成] 成功在 ${request.url().includes('commit/submit') ? '最终提交' : '中间保存'} 阶段注入满血库存与数据！`);
                } catch (e) { 
                    await route.continue();
                }
            });

            await editPageB.route('**/decoration/commit/save*', async (route, request) => {
                try {
                    let originalBDeco = JSON.parse(request.postData());
                    if (productA_DecorationData && productA_DecorationData.decoration_floor_list) { 
                        originalBDeco.decoration_floor_list = productA_DecorationData.decoration_floor_list; 
                    }
                    await route.continue({ postData: JSON.stringify(originalBDeco) });
                } catch (e) { await route.continue(); }
            });

            // ==========================================
            // 阶段三：计算参考价与最终提交
            // ==========================================
            console.log(`🖱️ [自动化] 尝试点击“装修商详”以激活长图保存...`);
            const decoBtn = editPageB.locator('button:has-text("装修商详")').first();
            await decoBtn.waitFor({ state: 'visible', timeout: 5000 });
            await decoBtn.click({ force: true });
            await editPageB.waitForTimeout(1500);

            // 参考价计算逻辑
            let maxPriceA_Cents = productA_Data && productA_Data.skus ?
                Math.max(...productA_Data.skus.map(s => Number(s.normal_price || s.group_price || s.sku_price || 0))) : 0;
            let bPriceYuan = bStoreSniffedMaxPriceCents > 0 ? (bStoreSniffedMaxPriceCents / 100) : 0; 
            if (bPriceYuan === 0) bPriceYuan = 2999;
            
            let aPriceYuan = maxPriceA_Cents > 0 ? (maxPriceA_Cents / 100) : 2599;
            let targetRefPriceYuan = Math.max(aPriceYuan, bPriceYuan);

            const absoluteLimit = bPriceYuan * CONFIG.PRICE_SAFE_MULTIPLIER;
            if (targetRefPriceYuan > absoluteLimit) targetRefPriceYuan = absoluteLimit; 

            let maxPriceStr = targetRefPriceYuan.toFixed(2);
            console.log(`💰 [自动化] 正在填入精准计算的【参考价】(${maxPriceStr}元)...`);

            const advicePriceInput = editPageB.locator('input[data-tracking-click-viewid="goods_advice_price"]');
            await advicePriceInput.waitFor({ state: 'visible', timeout: 5000 });
            await advicePriceInput.fill(maxPriceStr);
            await advicePriceInput.evaluate(node => { 
                node.dispatchEvent(new Event('input', { bubbles: true })); 
                node.dispatchEvent(new Event('change', { bubbles: true })); 
                node.dispatchEvent(new Event('blur', { bubbles: true })); 
            });

            console.log(`🚀 [自动化] 锁定【提交】按钮，执行最终发布！`);
            const submitSuccessPromise = editPageB.waitForResponse(
                res => res.url().includes('commit/submit') && res.status() === 200, 
                { timeout: 15000 } 
            ).catch(() => null);
            
            await editPageB.getByRole('button', { name: '提交并上架' }).click({ force: true });
            
            console.log(`⏳ [网络等待] 正在死守拼多多服务器的上架反馈...`);
            const submitResult = await submitSuccessPromise;
            
            if (submitResult) {
                console.log(`🎊 [任务 ${i + 1} 成功] 抓包确认：服务器已响应上架成功！`);
                taskSuccess = true;
                console.log(`👀 [视觉检查] 页面将保留 10 秒供你确认，随后再自动进入下一个任务...`);
                await editPageB.waitForTimeout(10000); 
            } else {
                throw new Error("提交接口未在15秒内返回成功状态");
            }

            // 单个任务收尾清理
            contextB.removeListener('response', sniffListener);
            if (taskSuccess) {
                console.log(`🧹 [清理内存] 正在关闭当前任务标签页...`);
                if (editPageB && !editPageB.isClosed()) await editPageB.close();
                if (pageB && !pageB.isClosed()) await pageB.close();
                if (pageA && !pageA.isClosed()) await pageA.close();
            } else {
                console.log(`\n🛑 [现场保留] 触发防崩溃机制！已将当前页面停留在此，请你在浏览器中手动检查。`);
                console.log(`➡️ 解决完毕后，程序会在 45 秒后自动关闭本页，进入下一个任务...`);
                if (editPageB && !editPageB.isClosed()) await editPageB.waitForTimeout(45000); 
                if (editPageB && !editPageB.isClosed()) await editPageB.close();
                if (pageB && !pageB.isClosed()) await pageB.close();
                if (pageA && !pageA.isClosed()) await pageA.close();
            }
        }

    } catch (err) {
        console.error(`🚨 克隆引擎致命异常:`, err.message);
    } finally {
        // 最终全局收尾
        if (contextA) await contextA.close();
        if (contextB) await contextB.close();
        console.log(`\n🏁 矩阵战术任务执行完毕。`);
    }
}

// ==========================================
// 重点：暴露统一接口，绝不自启动！
// ==========================================
module.exports = { startApp };