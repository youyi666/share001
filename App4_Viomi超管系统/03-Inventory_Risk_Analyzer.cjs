// 03-Inventory_Risk_Analyzer.cjs
// 库存风险智能诊断分析脚本 (V10: 全渠道物理库存与前端运营解耦版)
//
// 架构逻辑：
// 1. 【全渠道流速】：从 sales_history 获取多平台近 30 天销量，逗号拆包归集到基础物理 69 码。
// 2. 【实物盘点】：从 viomi_central_inventory 提取实物库存。
// 3. 【供应链资产预警】：底层实物库存 🆚 全渠道底层流速 (彻底消除组合商品重复积压报警)。
// 4. 【拼多多前台预警】：pdd_goods_master 前台库存 🆚 系统计算库存 (抓取虚空超卖)。

// ======================= [基座代码引入] =======================
const Database = require('better-sqlite3');
const path = require('path');

const fileUtils = require('../00_Core_Infrastructure/file_utils.cjs');
const dbManager = require('../00_Core_Infrastructure/db_manager.cjs');
// 注：03脚本纯本地数据计算，暂无需调用 browserManager，但保持架构对齐预留接口

const envConfig = require('../00_Core_Infrastructure/env_config.cjs'); 
const DB_FILE = envConfig.DATABASE_PATH;

// ======================= [增量模块：常量与配置] =======================
const MASTER_TABLE = 'pdd_goods_master';
const INVENTORY_TABLE = 'viomi_central_inventory';
const SALES_HISTORY_TABLE = 'sales_history';

const CONFIG = {
    ANALYSIS_DAYS: 30,      
    STOCKOUT_WARNING: 7,    
    SLOW_MOVING_WARNING: 90 
};

// --------------------------- [工具函数] ---------------------------
function getLocalDateString(date) {
    if (!(date instanceof Date) || isNaN(date)) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// 视觉对齐辅助引擎
function getVisLen(str) {
    let len = 0;
    for (let i = 0; i < str.length; i++) len += str.charCodeAt(i) > 255 ? 2 : 1;
    return len;
}

function sliceVis(str, maxVisLen) {
    let len = 0, res = '';
    for (let i = 0; i < str.length; i++) {
        let charLen = str.charCodeAt(i) > 255 ? 2 : 1;
        if (len + charLen > maxVisLen) break;
        res += str[i];
        len += charLen;
    }
    return res;
}

function padR(str, target) {
    str = String(str);
    str = sliceVis(str, target);
    return str + ' '.repeat(target - getVisLen(str));
}

function padL(str, target) {
    str = String(str);
    str = sliceVis(str, target);
    return ' '.repeat(target - getVisLen(str)) + str;
}

// --------------------------- [核心逻辑封装导出] ---------------------------
async function executeRiskAnalysis() {
    console.log('📊 [App4 调度] 启动【全渠道供应链】与【单平台运营】解耦诊断分析...');
    
    let db = null;
    try {
        // 利用统一的基座或直接基于配置文件连接数据库
        db = new Database(DB_FILE, { readonly: true, fileMustExist: true });

        // ==============================================================
        // 步骤 1：构建全渠道基础物理 SKU 真实流速库 (sales_history)
        // ==============================================================
        console.log(`1️⃣ 正在解析全渠道多平台历史销量 (近 ${CONFIG.ANALYSIS_DAYS} 天)...`);
        
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - CONFIG.ANALYSIS_DAYS);
        const dateLimitStr = getLocalDateString(thirtyDaysAgo);

        // 提取近30天全平台销量数据
        const salesRows = db.prepare(`
            SELECT barcode, sum(sales_volume) as total_qty
            FROM ${SALES_HISTORY_TABLE}
            WHERE record_date >= ? AND barcode IS NOT NULL AND barcode != ''
            GROUP BY barcode
        `).all(dateLimitStr);

        const globalSalesMap = new Map(); 
        
        salesRows.forEach(row => {
            const qty = row.total_qty || 0;
            const baseCodes = row.barcode.split(',');
            
            baseCodes.forEach(rawCode => {
                const cleanCode = rawCode.replace(/\D/g, '').trim(); 
                if (cleanCode.length >= 6) {
                    const current = globalSalesMap.get(cleanCode) || 0;
                    globalSalesMap.set(cleanCode, current + qty);
                }
            });
        });
        console.log(`   -> 逗号拆包归集完成，共提取到底层物理基础 69 码流速档案 ${globalSalesMap.size} 份。`);

        // ==============================================================
        // 步骤 2：读取中央仓库实物快照 (viomi_central_inventory)
        // ==============================================================
        console.log('2️⃣ 正在读取中央物理盘点数据...');
        const invDateRow = db.prepare(`SELECT max(查询日期) as lastDate FROM ${INVENTORY_TABLE}`).get();
        if (!invDateRow || !invDateRow.lastDate) throw new Error(`库存表为空，请先运行库存同步脚本。`);

        const invRows = db.prepare(`
            SELECT 商品69码 AS code, sum(可用库存) AS realStock
            FROM ${INVENTORY_TABLE}
            WHERE 查询日期 = ?
            GROUP BY 商品69码
        `).all(invDateRow.lastDate);

        const centralStockMap = new Map();
        invRows.forEach(row => {
            centralStockMap.set(String(row.code).trim().toUpperCase(), row.realStock || 0);
        });
        console.log(`   -> 读取到最新实物盘点数据 ${centralStockMap.size} 款。`);

        // ==============================================================
        // 步骤 3：提取拼多多前台商品底库 (用于虚空超卖预警)
        // ==============================================================
        console.log('3️⃣ 正在读取拼多多最新前台挂载快照 (pdd_goods_master)...');
        const masterDateRow = db.prepare(`SELECT max(scrape_time) as lastTime FROM ${MASTER_TABLE}`).get();
        
        const pddFrontMap = new Map();
        const codeToNameMap = new Map(); 

        if (masterDateRow && masterDateRow.lastTime) {
            const frontEndRows = db.prepare(`
                SELECT out_sku_sn AS code, goods_name AS productName, sum(sku_quantity) AS platformStock
                FROM ${MASTER_TABLE}
                WHERE scrape_time = ? AND out_sku_sn IS NOT NULL AND out_sku_sn != ''
                GROUP BY out_sku_sn
            `).all(masterDateRow.lastTime);

            frontEndRows.forEach(row => {
                const code = String(row.code).trim().toUpperCase();
                pddFrontMap.set(code, row.platformStock || 0);
                if (!codeToNameMap.has(code)) codeToNameMap.set(code, row.productName);
            });
            console.log(`   -> 获取到拼多多前台独立挂载编码 ${pddFrontMap.size} 个。`);
        }

        const nameRows = db.prepare(`SELECT barcode, product_name FROM ${SALES_HISTORY_TABLE} WHERE product_name IS NOT NULL`).all();
        nameRows.forEach(row => {
            const baseCodes = row.barcode.split(',');
            baseCodes.forEach(rawCode => {
                const cleanCode = rawCode.replace(/\D/g, '').trim();
                if (!codeToNameMap.has(cleanCode)) codeToNameMap.set(cleanCode, row.product_name);
            });
        });

        // ==============================================================
        // 步骤 4：解耦风险诊断计算
        // ==============================================================
        console.log('4️⃣ 执行前后端解耦的逻辑对撞诊断...');
        
        const ghostReport = []; 
        const supplyReport = []; 

        for (const [code, platformStock] of pddFrontMap.entries()) {
            const realStock = centralStockMap.get(code) || 0;
            if (platformStock > realStock && platformStock > 0 && realStock <= 0) {
                ghostReport.push({
                    code,
                    name: codeToNameMap.get(code) || '未知商品',
                    platformStock,
                    realStock
                });
            }
        }

        for (const [code, realStock] of centralStockMap.entries()) {
            if (!/^\d+$/.test(code)) continue;

            const globalSales30d = globalSalesMap.get(code) || 0;
            const dailySales = globalSales30d / CONFIG.ANALYSIS_DAYS;
            
            let daysOfSupply = 9999;
            if (dailySales > 0) {
                daysOfSupply = realStock / dailySales;
            } else if (realStock <= 0 && dailySales > 0) {
                daysOfSupply = 0; 
            }

            let riskType = 'NORMAL';
            if (daysOfSupply < CONFIG.STOCKOUT_WARNING) {
                riskType = 'HIGH_RISK_STOCKOUT';
            } else if (realStock > 0 && globalSales30d === 0) {
                riskType = 'DEAD_STOCK';
            } else if (daysOfSupply > CONFIG.SLOW_MOVING_WARNING) {
                riskType = 'SLOW_MOVING';
            }

            if (riskType !== 'NORMAL') {
                supplyReport.push({
                    code,
                    name: codeToNameMap.get(code) || '未知基础物料',
                    globalSales30d,
                    dailySales: dailySales.toFixed(1),
                    realStock,
                    daysOfSupply: daysOfSupply === 9999 ? '∞' : daysOfSupply.toFixed(1),
                    riskType
                });
            }
        }

        // ==============================================================
        // 步骤 5：生成分离式高管级业务报表
        // ==============================================================
        console.log('\n===========================================================================================================');
        console.log(`📊 业财一体化库存风险报表 (拼多多运营风险 与 全渠道供应链资产 分离式预警)`);
        console.log('===========================================================================================================\n');

        const W_CODE = 15, W_NAME = 25, W_SALES = 14, W_STOCK = 14, W_RATE = 10, W_DAYS = 12;

        ghostReport.sort((a, b) => b.platformStock - a.platformStock);
        if (ghostReport.length > 0) {
            console.log(`🧨 【PDD 店铺运营告警】虚空超卖漏洞！前台有货但实仓(含组合)已空，随时触动发货罚款 (共 ${ghostReport.length} 款)`);
            console.log(`-----------------------------------------------------------------------------------------------------------`);
            console.log(`| ${padR('前台编码(含组合)', W_CODE)} | ${padR('商品简称', W_NAME)} | ${padL('⚠️PDD虚挂库存', W_STOCK)} | ${padL('🚨系统实际支撑', W_STOCK)} |`);
            console.log(`|${'-'.repeat(W_CODE+2)}|${'-'.repeat(W_NAME+2)}|${'-'.repeat(W_STOCK+2)}|${'-'.repeat(W_STOCK+2)}|`);
            ghostReport.forEach(item => {
                console.log(`| ${padR(item.code, W_CODE)} | ${padR(item.name, W_NAME)} | ${padL(item.platformStock, W_STOCK)} | ${padL(item.realStock, W_STOCK)} |`);
            });
            console.log('\n');
        }

        const urgentItems = supplyReport.filter(r => r.riskType === 'HIGH_RISK_STOCKOUT').sort((a, b) => parseFloat(a.daysOfSupply) - parseFloat(b.daysOfSupply));
        if (urgentItems.length > 0) {
            console.log(`🔴 【全渠道供应链告警】底层物理实物断供风险！(共 ${urgentItems.length} 款基础SKU, 支撑不足 ${CONFIG.STOCKOUT_WARNING}天)`);
            console.log(`-----------------------------------------------------------------------------------------------------------`);
            console.log(`| ${padR('基础物理69码', W_CODE)} | ${padR('商品简称', W_NAME)} | ${padL('全渠道30天总销', W_SALES)} | ${padL('实物可用库存', W_STOCK)} | ${padL('多端日均流速', W_RATE)} | ${padL('极限支撑天数', W_DAYS)} |`);
            console.log(`|${'-'.repeat(W_CODE+2)}|${'-'.repeat(W_NAME+2)}|${'-'.repeat(W_SALES+2)}|${'-'.repeat(W_STOCK+2)}|${'-'.repeat(W_RATE+2)}|${'-'.repeat(W_DAYS+2)}|`);
            urgentItems.forEach(item => {
                console.log(`| ${padR(item.code, W_CODE)} | ${padR(item.name, W_NAME)} | ${padL(item.globalSales30d, W_SALES)} | ${padL(item.realStock, W_STOCK)} | ${padL(item.dailySales, W_RATE)} | ${padL(item.daysOfSupply, W_DAYS)} |`);
            });
            console.log('\n');
        }

        const slowItems = supplyReport.filter(r => ['DEAD_STOCK', 'SLOW_MOVING'].includes(r.riskType)).sort((a, b) => b.realStock - a.realStock); 
        if (slowItems.length > 0) {
            console.log(`🔵 【全渠道供应链告警】底层实物资产严重积压死滞！(共 ${slowItems.length} 款基础SKU, 滞销超 ${CONFIG.SLOW_MOVING_WARNING}天)`);
            console.log(`   (注: 已过滤前端组合虚拟 SKU，纯底层物理存货积压排行)`);
            console.log(`-----------------------------------------------------------------------------------------------------------`);
            console.log(`| ${padR('基础物理69码', W_CODE)} | ${padR('商品简称', W_NAME)} | ${padL('全渠道30天总销', W_SALES)} | ${padL('严重积压库存', W_STOCK)} | ${padL('多端日均流速', W_RATE)} | ${padL('极限支撑天数', W_DAYS)} |`);
            console.log(`|${'-'.repeat(W_CODE+2)}|${'-'.repeat(W_NAME+2)}|${'-'.repeat(W_SALES+2)}|${'-'.repeat(W_STOCK+2)}|${'-'.repeat(W_RATE+2)}|${'-'.repeat(W_DAYS+2)}|`);
            slowItems.slice(0, 15).forEach(item => {
                let statusMsg = item.daysOfSupply;
                if (item.riskType === 'DEAD_STOCK') statusMsg = '死货(零销)';
                console.log(`| ${padR(item.code, W_CODE)} | ${padR(item.name, W_NAME)} | ${padL(item.globalSales30d, W_SALES)} | ${padL(item.realStock, W_STOCK)} | ${padL(item.dailySales, W_RATE)} | ${padL(statusMsg, W_DAYS)} |`);
            });
            
            if (slowItems.length > 15) {
                const skipStr = `... (省略其余 ${slowItems.length - 15} 款商品) ...`;
                console.log(`| ${padR(skipStr, 100)} |`); 
            }
            console.log('\n');
        }

        console.log('✅ 前后端架构解耦诊断结束。运营抓超卖，后端抓周转！');

    } catch (err) {
        console.error('❌ 执行诊断时出现崩溃:', err.message);
    } finally {
        if (db) db.close();
    }
}

module.exports = { executeRiskAnalysis };