// 04-Viomi_DBS_Ultimate_Consumables.cjs 
// 【终极融合版】DBS 基础资料抓取与智能排重同步
//
// 融合特性：
// 1. [智能排重] 抛弃 Excel 静态任务，直连 SQLite pdd_goods_master 对撞找缺漏任务。
// 2. [强力注入] 吸收 forceFillInput 函数，底层触发 Vue/React 的绑定事件。
// 3. [数据打平] 吸收耗材独立列存储逻辑 (c1_barcode - c5_barcode 打平入库)。
// 4. [异常修复] 包含 V29 版本的下拉框视口穿透修复，以及安全的页面级异常销毁。
// 5. [基座标准] 由 app4 总控传入隐身浏览器 context 统一调度。

const path = require('path');
const fs = require('fs');

// ======================= [基座代码引入] =======================
const envConfig = require('../00_Core_Infrastructure/env_config.cjs'); 
const dbManager = require('../00_Core_Infrastructure/db_manager.cjs'); 

require('dotenv').config({ path: path.join(envConfig.ROOT, '.env') });

// 确保下载目录存在用于存放报错截图
if (!fs.existsSync(envConfig.DOWNLOADS_DIR)) fs.mkdirSync(envConfig.DOWNLOADS_DIR, { recursive: true });

const VIOMI_USERNAME = process.env.VIOMI_USERNAME;
const VIOMI_PASSWORD = process.env.VIOMI_PASSWORD;

const DB_TABLE_NAME = 'dbs_product_details';
const SOURCE_TABLE_NAME = 'pdd_goods_master';

// --- 辅助函数 ---

function parseDimensions(dimString) {
    if (!dimString || typeof dimString !== 'string') return { l: 0, w: 0, h: 0 };
    const parts = dimString.toLowerCase().split('x').map(s => parseFloat(s.trim()));
    return { l: parts[0] || 0, w: parts[1] || 0, h: parts[2] || 0 };
}

function findVal(rawData, section, subSection, labelName) {
    try {
        return rawData[section]?.[subSection]?.find(i => i.label === labelName)?.value || null;
    } catch (e) { return null; }
}

/**
 * 强化版输入机制，针对复杂或拦截组件注入底层数据绑定事件
 */
async function forceFillInput(elementHandle, value) {
    await elementHandle.fill('');
    await elementHandle.fill(value);
    await elementHandle.evaluate(node => {
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        node.dispatchEvent(new Event('blur', { bubbles: true }));
    });
}

// ======================= [步骤1：智能数据库对比任务排重] =======================
function getMissingTasks() {
    console.log(`\n🔍 准备从本地数据库计算待抓取任务...`);
    const db = dbManager.getRawDbInstance();

    // 确保目标表存在，加入用户新增的耗材多列打平字段
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${DB_TABLE_NAME} (
            barcode TEXT PRIMARY KEY,
            product_name TEXT,
            product_model TEXT,
            erp_code TEXT,
            sku_id TEXT,
            net_weight REAL,
            gross_weight REAL,
            dim_prod_l REAL, dim_prod_w REAL, dim_prod_h REAL,
            dim_pkg_l REAL, dim_pkg_w REAL, dim_pkg_h REAL,
            image_url TEXT,
            is_wifi TEXT,
            category_path TEXT,
            unit TEXT,
            consumables_json TEXT,
            consumable_1_barcode TEXT,
            consumable_2_barcode TEXT,
            consumable_3_barcode TEXT,
            consumable_4_barcode TEXT,
            consumable_5_barcode TEXT,
            market_price TEXT,
            tax_rate TEXT,
            purchase_entity TEXT,
            software_entity TEXT,
            update_time TEXT,
            scrape_time TEXT
        )
    `);

    // 获取所有需要查询的 69 码 (从拼多多商品总表提取)
    const allSourceRows = db.prepare(`SELECT DISTINCT out_sku_sn FROM ${SOURCE_TABLE_NAME} WHERE out_sku_sn IS NOT NULL AND out_sku_sn != ''`).all();
    let allCodes = new Set();
    
    allSourceRows.forEach(row => {
        const code = String(row.out_sku_sn).trim();
        // 过滤掉 S 开头的组合码和无效短码，仅保留纯数字单品 69 码去查 DBS
        if (code.length >= 6 && !code.toUpperCase().startsWith('S')) {
            allCodes.add(code);
        }
    });

    // 获取已经抓取过的 DBS 资料 69 码
    const existingRows = db.prepare(`SELECT barcode FROM ${DB_TABLE_NAME}`).all();
    existingRows.forEach(row => {
        allCodes.delete(String(row.barcode).trim());
    });

    const missingTasks = Array.from(allCodes);
    console.log(`   ✅ 对撞排重完成！总计单品: ${allSourceRows.length}，已抓取: ${existingRows.length}，需新抓取: ${missingTasks.length} 个。`);
    return missingTasks;
}

// ======================= [核心业务逻辑 (模块化导出)] =======================
/**
 * 模块入口：由 app4 总控传入统一上下文执行
 * @param {import('playwright').BrowserContext} context 
 */
async function run(context) {
    console.log('\n======================================================');
    console.log('--- [模块 04] 启动 DBS 基础资料抓取与智能排重同步 ---');

    if (!VIOMI_USERNAME || !VIOMI_PASSWORD) {
        console.error('❌ 请在 .env 文件中设置 VIOMI_USERNAME 和 VIOMI_PASSWORD');
        return;
    }

    const taskCodes = getMissingTasks();
    if (taskCodes.length === 0) {
        console.log('⚠️ 所有基础资料均已入库，没有缺失任务，安全退出当前模块。');
        return;
    }

    const db = dbManager.getRawDbInstance();
    // 使用命名参数绑定 (@xxx) 实现防错 UPSERT
    const insertStmt = db.prepare(`
        INSERT INTO ${DB_TABLE_NAME} (
            barcode, product_name, product_model, erp_code, sku_id,
            net_weight, gross_weight, 
            dim_prod_l, dim_prod_w, dim_prod_h,
            dim_pkg_l, dim_pkg_w, dim_pkg_h,
            image_url, is_wifi, category_path, unit,
            consumables_json, 
            consumable_1_barcode, consumable_2_barcode, consumable_3_barcode, 
            consumable_4_barcode, consumable_5_barcode,
            market_price, tax_rate, purchase_entity, software_entity,
            update_time, scrape_time
        ) VALUES (
            @barcode, @product_name, @product_model, @erp_code, @sku_id,
            @net_weight, @gross_weight, 
            @dim_prod_l, @dim_prod_w, @dim_prod_h,
            @dim_pkg_l, @dim_pkg_w, @dim_pkg_h,
            @image_url, @is_wifi, @category_path, @unit,
            @consumables_json, 
            @c1_barcode, @c2_barcode, @c3_barcode, @c4_barcode, @c5_barcode,
            @market_price, @tax_rate, @purchase_entity, @software_entity,
            @update_time, @scrape_time
        )
        ON CONFLICT (barcode) DO UPDATE SET
            product_name = excluded.product_name,
            product_model = excluded.product_model,
            erp_code = excluded.erp_code,
            sku_id = excluded.sku_id,
            net_weight = excluded.net_weight,
            gross_weight = excluded.gross_weight,
            dim_prod_l = excluded.dim_prod_l, dim_prod_w = excluded.dim_prod_w, dim_prod_h = excluded.dim_prod_h,
            dim_pkg_l = excluded.dim_pkg_l, dim_pkg_w = excluded.dim_pkg_w, dim_pkg_h = excluded.dim_pkg_h,
            image_url = excluded.image_url,
            is_wifi = excluded.is_wifi,
            category_path = excluded.category_path,
            unit = excluded.unit,
            consumables_json = excluded.consumables_json,
            consumable_1_barcode = excluded.consumable_1_barcode,
            consumable_2_barcode = excluded.consumable_2_barcode,
            consumable_3_barcode = excluded.consumable_3_barcode,
            consumable_4_barcode = excluded.consumable_4_barcode,
            consumable_5_barcode = excluded.consumable_5_barcode,
            market_price = excluded.market_price,
            tax_rate = excluded.tax_rate,
            purchase_entity = excluded.purchase_entity,
            software_entity = excluded.software_entity,
            update_time = excluded.update_time,
            scrape_time = excluded.scrape_time
    `);

    // 创建当前模块所需的独立页面
    const page = await context.newPage();

    try {
        // --- 1. 登录 ---
        console.log('➡️ 登录云米门户...');
        await page.goto('https://su.viomi.com.cn/super/login.html');

        try {
            await page.waitForSelector('input', { timeout: 5000 });
            
            const visibleInputs = await page.locator('input:visible').all();
            let filled = false;

            if (visibleInputs.length >= 2) {
                console.log(`   🔑 发现 ${visibleInputs.length} 个输入框，采用 forceFillInput 强力填充...`);
                
                await forceFillInput(visibleInputs[0], VIOMI_USERNAME);
                
                const pwInput = page.locator('input[type="password"]:visible').first();
                if (await pwInput.isVisible()) {
                    await forceFillInput(pwInput, VIOMI_PASSWORD);
                } else {
                    await forceFillInput(visibleInputs[1], VIOMI_PASSWORD);
                }
                
                const loginBtn = page.locator('.login-btn, button[type="button"], div[role="button"]').filter({ hasText: /登录|Login/ }).first();
                if (await loginBtn.isVisible()) {
                    await loginBtn.click({ force: true });
                } else {
                    await page.keyboard.press('Enter');
                }
                filled = true;
                await page.waitForTimeout(2000);
            } 
            
            if (!filled) console.log('   ⚠️ 未找到合适的输入框，跳过自动填充。');

        } catch (e) { console.log('   ℹ️ 登录流程跳过或无须登录:', e.message); }

        // --- 2. 跳转与搜索 ---
        console.log('➡️ 跳转 DBS 系统...');
        const page2Promise = context.waitForEvent('page');
        
        const dbsEntryBtn = page.locator('text=DBS 基础资料平台').first();
        try {
            await dbsEntryBtn.click({ force: true, timeout: 5000 });
        } catch (e) {
            await page.locator('span:has-text("DBS 基础资料平台")').first().click({ force: true });
        }
        
        const dbsPage = await page2Promise;
        await dbsPage.waitForLoadState('networkidle');

        console.log('➡️ 进入产品资料菜单...');
        await dbsPage.getByText('产品基础资料管理').click({ force: true });
        await dbsPage.getByRole('menuitem', { name: '产品资料管理' }).click({ force: true });
        await dbsPage.waitForTimeout(1000);

        const searchTypeInput = dbsPage.locator('.el-select').first().locator('input.el-input__inner');
        const searchContentInput = dbsPage.getByRole('textbox', { name: '多个请使用英文逗号分隔' });
        const searchBtn = dbsPage.getByRole('button', { name: '搜索' });

        // --- 3. 循环任务 ---
        for (const code of taskCodes) {
            console.log(`\n🔍 处理 69码: [${code}]`);
            let detailPage = null;
            try {
                // ==========================================
                // [视口修复] 针对复杂下拉框的强力穿透方案
                // ==========================================
                await searchTypeInput.click({ force: true });
                await dbsPage.waitForTimeout(500); 

                const optionNode = dbsPage.getByText('产品69码', { exact: true });
                try {
                    await optionNode.click({ force: true, timeout: 2000 });
                } catch (clickErr) {
                    await optionNode.evaluate(node => {
                        node.scrollIntoView({ block: 'center', behavior: 'instant' });
                        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                        node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                        node.click();
                    });
                }
                
                await dbsPage.waitForTimeout(300); 

                // 使用优化后的底层注入方法填写查询表单
                await forceFillInput(searchContentInput, code);
                await searchBtn.click({ force: true });
                
                // 等待加载遮罩消失
                await dbsPage.waitForSelector('.el-loading-mask', { state: 'hidden', timeout: 5000 }).catch(() => {});
                await dbsPage.waitForTimeout(800);

                const viewBtn = dbsPage.getByRole('button', { name: '查看' }).first();
                if (!(await viewBtn.isVisible())) {
                    console.log(`   ⚠️ 未找到该记录，可能并非官方登记的主品`);
                    continue;
                }

                const popupPromise = context.waitForEvent('page', { timeout: 15000 });
                await viewBtn.evaluate(node => node.click());
                detailPage = await popupPromise;
                await detailPage.waitForLoadState('domcontentloaded');
                await detailPage.waitForSelector('.container-box', { timeout: 15000 });

                try {
                    await detailPage.waitForSelector('text="包含耗材"', { timeout: 3000 }).catch(() => {});
                } catch(e) {}

                // --- 4. 浏览器内抓取 ---
                const pageData = await detailPage.evaluate(() => {
                    const res = { raw: {}, consumables: [] };
                    const clean = t => t ? t.replace(/\s+/g, ' ').trim() : '';

                    // A. 常规数据
                    const container = document.querySelector('.container-box');
                    if (container) {
                        let sec = 'Default', sub = 'Default';
                        for (const el of Array.from(container.children)) {
                            if (el.tagName === 'H3' || el.matches('.m-title')) { sec = clean(el.innerText); res.raw[sec] = {}; sub = 'General'; }
                            else if (el.tagName === 'H4') { sub = clean(el.innerText); if (!res.raw[sec]) res.raw[sec] = {}; res.raw[sec][sub] = []; }
                            else {
                                const items = el.matches('.el-form-item') ? [el] : el.querySelectorAll('.el-form-item');
                                for (const item of items) {
                                    const label = clean(item.querySelector('.el-form-item__label')?.innerText);
                                    const content = item.querySelector('.el-form-item__content');
                                    let val = null;
                                    if (content) {
                                        const imgs = content.querySelectorAll('img');
                                        if (imgs.length) val = Array.from(imgs).map(i => i.src);
                                        else {
                                            const inputs = Array.from(content.querySelectorAll('input:not([type="hidden"]), textarea'));
                                            if (inputs.length) {
                                                const texts = inputs.filter(i => i.type !== 'radio' && i.type !== 'checkbox').map(i => i.value);
                                                if (inputs[0].type === 'radio') {
                                                    const checked = content.querySelector('.is-checked .el-radio__label');
                                                    val = checked ? clean(checked.innerText) : '';
                                                } else val = texts.length > 1 ? texts.join(' x ') : texts[0];
                                            } else val = clean(content.innerText);
                                        }
                                    }
                                    if (!res.raw[sec]) res.raw[sec] = {}; if (!res.raw[sec][sub]) res.raw[sec][sub] = [];
                                    res.raw[sec][sub].push({ label, value: val });
                                }
                            }
                        }
                    }

                    // B. 耗材表格提取
                    const textNodes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
                    let node;
                    let targetTable = null;

                    while(node = textNodes.nextNode()) {
                        if(node.nodeValue.includes('包含耗材')) {
                            let parent = node.parentElement; 
                            for(let i=0; i<5; i++) {
                                if(!parent) break;
                                const table = parent.querySelector('.el-table');
                                if(table) {
                                    targetTable = table;
                                    break;
                                }
                                parent = parent.parentElement;
                            }
                        }
                        if(targetTable) break;
                    }

                    if (targetTable) {
                        const rows = Array.from(targetTable.querySelectorAll('tbody tr'));
                        for (const row of rows) {
                            const cols = row.querySelectorAll('td');
                            
                            if (cols.length >= 6) {
                                const getTextDeep = (cell) => {
                                    if(!cell) return '';
                                    const input = cell.querySelector('input');
                                    if (input && input.value) return clean(input.value);
                                    const deepDiv = cell.querySelector('.img-box > div');
                                    if (deepDiv) return clean(deepDiv.innerText);
                                    return clean(cell.innerText);
                                };

                                const item = {
                                    name: getTextDeep(cols[2]),      
                                    code: getTextDeep(cols[0]),      
                                    material: getTextDeep(cols[3]),  
                                    barcode: getTextDeep(cols[5]),   
                                    image: cols[1].querySelector('img')?.src || ''
                                };

                                if (item.name && item.name !== '无需填写，系统自动生成') {
                                    res.consumables.push(item);
                                }
                            }
                        }
                    }

                    return res;
                });

                await detailPage.close().catch(() => {});

                // C. 数据清洗与入库 (融入用户新增的多列打平逻辑)
                const raw = pageData.raw;
                const cons = pageData.consumables || [];
                const base = '商品基础信息详情', subBase = '基础信息', subExt = '扩展属性', subList = '上市信息', subFin = '财务信息', subSys = '系统信息';
                const prodDims = parseDimensions(findVal(raw, base, subBase, '产品尺寸（mm）'));
                const pkgDims = parseDimensions(findVal(raw, base, subBase, '产品外包装尺寸（mm）'));
                const imgRaw = findVal(raw, base, subBase, '产品主图');

                const cleanData = {
                    barcode: code,
                    product_name: findVal(raw, base, subBase, '产品名称'),
                    product_model: findVal(raw, base, subBase, '产品型号'),
                    erp_code: findVal(raw, base, subBase, 'erp物料编码'),
                    sku_id: findVal(raw, base, subBase, 'skuid'),
                    net_weight: parseFloat(findVal(raw, base, subBase, '净重(kg)')) || 0,
                    gross_weight: parseFloat(findVal(raw, base, subBase, '产品毛重(kg)')) || 0,
                    dim_prod_l: prodDims.l, dim_prod_w: prodDims.w, dim_prod_h: prodDims.h,
                    dim_pkg_l: pkgDims.l, dim_pkg_w: pkgDims.w, dim_pkg_h: pkgDims.h,
                    image_url: Array.isArray(imgRaw) ? imgRaw[0] : imgRaw,
                    is_wifi: findVal(raw, base, subBase, '是否支持联网'),
                    category_path: findVal(raw, base, subExt, '产品分类'),
                    unit: findVal(raw, base, subBase, '基本包装单位'),
                    
                    consumables_json: JSON.stringify(cons), 
                    
                    // 耗材数组扁平化
                    c1_barcode: cons[0]?.barcode || null,
                    c2_barcode: cons[1]?.barcode || null,
                    c3_barcode: cons[2]?.barcode || null,
                    c4_barcode: cons[3]?.barcode || null,
                    c5_barcode: cons[4]?.barcode || null,
                    
                    market_price: findVal(raw, base, subList, '建议零售价（元）'),
                    tax_rate: findVal(raw, base, subFin, '税率'),
                    purchase_entity: findVal(raw, base, subFin, '当前采购主体'),
                    software_entity: findVal(raw, base, subFin, '当前软件主体'),
                    update_time: findVal(raw, base, subSys, '更新时间'),
                    scrape_time: new Date().toLocaleString()
                };

                // 执行 SQLite 写入 (事务包装加速)
                const tx = db.transaction(() => {
                    insertStmt.run(cleanData);
                });
                tx();

                console.log(`   ✅ 入库成功: ${cleanData.product_name || '未解析到商品名'}`);
                if (cons.length > 0) {
                    console.log(`      🔗 关联到 ${cons.length} 个耗材 (打平至 C1-C5 列)`);
                }

            } catch (err) {
                console.error(`   ❌ 局部数据抓取异常: ${err.message}`);
                
                // 【页面污染清理】：从后往前安全关闭非主控制页
                try {
                    const pages = context.pages();
                    for (let i = pages.length - 1; i >= 0; i--) {
                        if (pages[i] !== dbsPage && pages[i] !== page) {
                            await pages[i].close().catch(() => {});
                        }
                    }
                } catch(cleanupErr) {}
            }
        }

    } catch (e) {
        console.error('❌ [模块 04] 遭遇致命崩溃:', e.message);
        const crashScreenPath = path.join(envConfig.DOWNLOADS_DIR, `Crash_App04_${Date.now()}.png`);
        await page.screenshot({ path: crashScreenPath, fullPage: true }).catch(() => {});
        console.log(`📸 致命崩溃截图已保留至: ${crashScreenPath}`);
    } finally {
        await page.close().catch(() => {});
        console.log('🏁 模块 04 智能补查执行结束。');
    }
}

module.exports = { run };