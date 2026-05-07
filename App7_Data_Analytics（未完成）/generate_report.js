/**
 * 功能：基于 pddorder、pdd_product_promotion 与外部 CSV 生成全维度电商周报
 * 迭代修复 (新增时间周期表头)：
 * 1. 扩充 CATEGORY_MAP，增加新品“小海豚3滤芯单品”的物理 69 码识别。
 * 2. 业务逻辑重构：由于是新品期无复购，将单品滤芯销量全额视作“套餐贡献”。
 * 3. 占比分母同步扩充，精准反映小海豚3对耗材的真实带动率。
 * 4. [增量] 报表头部新增明确的动态数据统计周期提示。
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const dayjs = require('dayjs');
const isBetween = require('dayjs/plugin/isBetween');
dayjs.extend(isBetween);

// --- 基座配置 ---
const { DATABASE_PATH } = require('../00_Core_Infrastructure/env_config.cjs');
const CSV_PATH = path.join(__dirname, '拼多多5月周分解.csv');
const REPORT_WEEK = 1; // 当前统计的周次 (1-4)

// 静态 SKU 字典 (仅用于订单表精准查销量)
const CATEGORY_MAP = {
    '小海豚600G+': '6923185653684', 
    '小海豚3': '6923185605867',
    '小海豚3滤芯套餐': 'S2512250944002',
    '小海豚3滤芯单品': '6923185657347'  // 新增单品滤芯物理码
};

// 月度目标 (销售额)
const TARGETS_MONTH = { overall: 1600000, water: 1400000, smart: 200000 };

// 动态时间视窗计算 (滚动 7 天，不含今天)
const now = dayjs();
const currentMonthStart = now.startOf('month');
const currentMonthEnd = now.endOf('month');
const thisWeekEnd = now.subtract(1, 'day').endOf('day'); 
const thisWeekStart = now.subtract(7, 'day').startOf('day');
const lastWeekEnd = thisWeekStart.subtract(1, 'day').endOf('day');
const lastWeekStart = thisWeekStart.subtract(7, 'day').startOf('day');

// --- 模块 1：CSV 配置与预算解析 ---
function loadConfigFromCSV() {
    if (!fs.existsSync(CSV_PATH)) throw new Error(`未找到 CSV 文件: ${CSV_PATH}`);
    const content = fs.readFileSync(CSV_PATH, 'utf-8');
    const lines = content.split(/\r?\n/);
    
    const parseRow = (line) => {
        let res = [], cur = '', inQ = false;
        for (let char of line) {
            if (char === '"') inQ = !inQ;
            else if (char === ',' && !inQ) { res.push(cur); cur = ''; }
            else cur += char;
        }
        res.push(cur); return res;
    };

    const headers = parseRow(lines[0]);
    const barcodeIdx = headers.findIndex(h => h.includes('69码') || h.includes('系统编码'));
    const nameIdx = headers.findIndex(h => h.includes('产品名称'));
    const weekSalesIdx = headers.findIndex(h => h.includes(`W${REPORT_WEEK}销售额`));
    const weekPromoIdx = headers.findIndex(h => h.includes(`W${REPORT_WEEK}推广费`));

    const waterBarcodes = new Set(), smartBarcodes = new Set();
    let tgtSalesWater = 0, tgtSalesSmart = 0, tgtPromoOverall = 0;

    const waterKeywords = ['海豚', '京龙', '白龙', '昆仑', '滤芯', '净水', 'Super Pro', '600G', '800G', '900G', '1000G', '1100G', '管线机', '台净'];

    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const row = parseRow(lines[i]);
        const barcode = row[barcodeIdx]?.trim();
        const productName = row[nameIdx]?.trim();
        const salesRaw = row[weekSalesIdx]?.trim();
        const promoRaw = row[weekPromoIdx]?.trim();

        if (!barcode || !productName) continue;

        const isWater = waterKeywords.some(k => productName.includes(k));
        if (isWater) waterBarcodes.add(barcode);
        else smartBarcodes.add(barcode);

        if (salesRaw) {
            const val = parseFloat(salesRaw.replace(/,/g, '')) || 0;
            if (isWater) tgtSalesWater += val; else tgtSalesSmart += val;
        }
        if (promoRaw) {
            tgtPromoOverall += (parseFloat(promoRaw.replace(/,/g, '')) || 0);
        }
    }

    return {
        salesWeek: { water: tgtSalesWater, smart: tgtSalesSmart, overall: tgtSalesWater + tgtSalesSmart },
        promoWeek: { overall: tgtPromoOverall },
        waterBarcodes, smartBarcodes
    };
}

const isMatchSKU = (dbValue, targetCode) => dbValue ? String(dbValue).trim().includes(targetCode) : false;

// 针对推广表商品名称的安全包含匹配
const isMatchPromoName = (dbProductName, keywordStr, excludeStr = null) => {
    if (!dbProductName) return false;
    const name = String(dbProductName);
    if (excludeStr && name.includes(excludeStr)) return false;
    return name.includes(keywordStr);
};

async function generateWeeklyReport() {
    let db;
    try {
        const config = loadConfigFromCSV();
        
        db = new sqlite3.Database(DATABASE_PATH, sqlite3.OPEN_READONLY, (err) => {
            if (err) throw new Error(`数据库连接致命失败: ${err.message}`);
        });

        // 异步查询 1：业务侧订单
        const getOrders = () => {
            return new Promise((resolve, reject) => {
                const sql = `
                    SELECT 
                        "订单号" as order_sn, "店铺名称" as store_name, "商家编码_规格维度" as barcode_69,
                        "支付时间" as pay_time, CAST("商品数量_件_" AS INTEGER) as qty, CAST("商家实收金额_元_" AS REAL) as revenue
                    FROM pddorder 
                    WHERE "售后状态" NOT LIKE '%退款成功%' AND "售后状态" NOT LIKE '%全额退款%'
                `;
                db.all(sql, [], (err, rows) => err ? reject(err) : resolve(rows || []));
            });
        };

        // 异步查询 2：流量侧推广
        const getPromotions = () => {
            return new Promise((resolve, reject) => {
                const sql = `
                    SELECT 
                        "统计日期" as stat_date,
                        "商品名称" as product_name,
                        CAST(REPLACE("总花费_元_", ',', '') AS REAL) as spend,
                        CAST(REPLACE("净交易额_元_", ',', '') AS REAL) as net_gmv
                    FROM pdd_product_promotion
                `;
                db.all(sql, [], (err, rows) => err ? reject(err) : resolve(rows || []));
            });
        };

        const [orders, promotions] = await Promise.all([getOrders(), getPromotions()]);

        // --- 指标计算引擎 ---
        const calcSales = (dataList, startDate, endDate, filterFn = null) => {
            let revenue = 0, qty = 0;
            dataList.forEach(row => {
                let d = dayjs(row.pay_time, ['MM/DD/YY', 'YYYY-MM-DD', 'YYYY/MM/DD HH:mm:ss']);
                if (d.isValid() && d.isBetween(startDate, endDate, 'day', '[]') && (!filterFn || filterFn(row))) {
                    revenue += (row.revenue || 0); qty += (row.qty || 0);
                }
            });
            return { revenue, qty };
        };

        const calcPromo = (promoList, startDate, endDate, filterFn = null) => {
            let spend = 0, netGmv = 0;
            promoList.forEach(row => {
                let d = dayjs(row.stat_date, ['YYYY-MM-DD', 'MM/DD/YY']);
                if (d.isValid() && d.isBetween(startDate, endDate, 'day', '[]') && (!filterFn || filterFn(row))) {
                    spend += (row.spend || 0); netGmv += (row.net_gmv || 0);
                }
            });
            
            let costRate = '0.0%';
            if (netGmv > 0) {
                costRate = ((spend / netGmv) * 100).toFixed(1) + '%';
            } else if (spend > 0) {
                costRate = '无转化(>100%)';
            }
            
            return { 
                spend, 
                netGmv, 
                roi: spend > 0 ? (netGmv / spend).toFixed(2) : '0.00',
                costRate
            };
        };

        // 1. 整体盘点
        const overallMonth = calcSales(orders, currentMonthStart, currentMonthEnd);
        const overallWeek = calcSales(orders, thisWeekStart, thisWeekEnd);
        const waterMonth = calcSales(orders, currentMonthStart, currentMonthEnd, (r) => Array.from(config.waterBarcodes).some(c => isMatchSKU(r.barcode_69, c)));
        const waterWeek = calcSales(orders, thisWeekStart, thisWeekEnd, (r) => Array.from(config.waterBarcodes).some(c => isMatchSKU(r.barcode_69, c)));
        const smartMonth = calcSales(orders, currentMonthStart, currentMonthEnd, (r) => Array.from(config.smartBarcodes).some(c => isMatchSKU(r.barcode_69, c)));
        const smartWeek = calcSales(orders, thisWeekStart, thisWeekEnd, (r) => Array.from(config.smartBarcodes).some(c => isMatchSKU(r.barcode_69, c)));

        // 2. 推广大盘
        const overallPromoWeek = calcPromo(promotions, thisWeekStart, thisWeekEnd);

        // 3. 店铺表现
        const storeStats = {};
        orders.forEach(row => {
            let d = dayjs(row.pay_time, ['MM/DD/YY', 'YYYY-MM-DD', 'YYYY/MM/DD HH:mm:ss']);
            if (d.isValid() && d.isBetween(thisWeekStart, thisWeekEnd, 'day', '[]')) {
                const sName = row.store_name || '未知店铺';
                if (!storeStats[sName]) storeStats[sName] = { revenue: 0, qty: 0 };
                storeStats[sName].revenue += (row.revenue || 0);
                storeStats[sName].qty += (row.qty || 0);
            }
        });
        let storeReportStr = `店铺情况：\n`;
        Object.entries(storeStats).forEach(([sName, stats]) => {
            storeReportStr += `${sName}，本周达成${(stats.revenue / 10000).toFixed(2)}万，售出${stats.qty}台\n`;
        });

        // 4. 单品表现 (销售精准锁定 69码，推广模糊匹配产品名称)
        const d600_sales_w = calcSales(orders, thisWeekStart, thisWeekEnd, (r) => isMatchSKU(r.barcode_69, CATEGORY_MAP['小海豚600G+']));
        const d600_sales_l = calcSales(orders, lastWeekStart, lastWeekEnd, (r) => isMatchSKU(r.barcode_69, CATEGORY_MAP['小海豚600G+']));
        const d600_promo = calcPromo(promotions, thisWeekStart, thisWeekEnd, (r) => isMatchPromoName(r.product_name, '600G+', '套')); 
        const d600_growth = d600_sales_l.qty ? Math.round(((d600_sales_w.qty - d600_sales_l.qty) / d600_sales_l.qty) * 100) : 0;

        const d3_sales_w = calcSales(orders, thisWeekStart, thisWeekEnd, (r) => isMatchSKU(r.barcode_69, CATEGORY_MAP['小海豚3']));
        const d3_sales_l = calcSales(orders, lastWeekStart, lastWeekEnd, (r) => isMatchSKU(r.barcode_69, CATEGORY_MAP['小海豚3']));
        const d3_promo = calcPromo(promotions, thisWeekStart, thisWeekEnd, (r) => isMatchPromoName(r.product_name, '小海豚3', '套'));
        const d3_growth = d3_sales_l.qty ? Math.round(((d3_sales_w.qty - d3_sales_l.qty) / d3_sales_l.qty) * 100) : 0;

        // --- 小海豚3 滤芯表现合并与重算 ---
        const d3_bundle_sales_w = calcSales(orders, thisWeekStart, thisWeekEnd, (r) => isMatchSKU(r.barcode_69, CATEGORY_MAP['小海豚3滤芯套餐']));
        const d3_single_filter_sales_w = calcSales(orders, thisWeekStart, thisWeekEnd, (r) => isMatchSKU(r.barcode_69, CATEGORY_MAP['小海豚3滤芯单品']));
        
        const d3_bundle_total_qty = d3_bundle_sales_w.qty + d3_single_filter_sales_w.qty;
        const d3_total_qty = d3_sales_w.qty + d3_bundle_total_qty;
        const d3_bundle_ratio = d3_total_qty > 0 ? Math.round((d3_bundle_total_qty / d3_total_qty) * 100) : 0;

        // --- 输出层 ---
        const fW = (val) => Math.round(val / 10000); 
        const fW2 = (val) => (val / 10000).toFixed(2); 
        const fRatio = (act, tgt) => tgt > 0 ? Math.round((act / tgt) * 100) : 0;

        console.log('\n================ 生成完毕，可直接复制到 Obsidian ================');
        
        // 增量：在头部注入动态日期格式化文本
        let reportStr = `📊 数据周期：本周: ${thisWeekStart.format('YYYY-MM-DD')} 至 ${thisWeekEnd.format('YYYY-MM-DD')} | 环比: ${lastWeekStart.format('YYYY-MM-DD')} 至 ${lastWeekEnd.format('YYYY-MM-DD')}

整体：本月目标${fW(TARGETS_MONTH.overall)}万，达成${fW(overallMonth.revenue)}万，达成率${fRatio(overallMonth.revenue, TARGETS_MONTH.overall)}%。本周目标${fW(config.salesWeek.overall)}万，达成${fW(overallWeek.revenue)}万。
净水：本月目标${fW(TARGETS_MONTH.water)}万，达成${fW(waterMonth.revenue)}万，达成率${fRatio(waterMonth.revenue, TARGETS_MONTH.water)}%。本周目标${fW(config.salesWeek.water)}万，达成${fW(waterWeek.revenue)}万。
智能：本月目标${fW(TARGETS_MONTH.smart)}万，达成${fW(smartMonth.revenue)}万，达成率${fRatio(smartMonth.revenue, TARGETS_MONTH.smart)}%。本周目标${fW(config.salesWeek.smart)}万，达成${fW(smartWeek.revenue)}万。

推广整体情况：本周预算${fW(config.promoWeek.overall)}万，实际花费${fW2(overallPromoWeek.spend)}万，整体净投产比 ${overallPromoWeek.roi}，费率 ${overallPromoWeek.costRate}。

${storeReportStr}单品表现情况：
小海豚600G+，本周${d600_sales_w.qty}台，增长${d600_growth > 0 ? '+' : ''}${d600_growth}%，日均${Math.round(d600_sales_w.qty / 7)}台。推广花费 ${Math.round(d600_promo.spend)} 元，净ROI ${d600_promo.roi}，费率 ${d600_promo.costRate}。
小海豚3，本周${d3_sales_w.qty}台，${d3_growth < 0 ? '负' : ''}增长${Math.abs(d3_growth)}%，日均${Math.round(d3_sales_w.qty / 7)}台，本周活动到期下线2天。现已恢复20台每天。推广花费 ${Math.round(d3_promo.spend)} 元，净ROI ${d3_promo.roi}，费率 ${d3_promo.costRate}。
小海豚3滤芯套餐（含单品）本周共 ${d3_bundle_total_qty} 台（其中套餐 ${d3_bundle_sales_w.qty} 台，滤芯单品 ${d3_single_filter_sales_w.qty} 台），综合挂载占比 ${d3_bundle_ratio}%。
商品周同比数据（环比周一至周五）

✅ 本周已完成 (Achievements)
小海豚2 1000G百亿补贴活动报名。已审核通过。
小海豚3+1根滤芯已复合官补要求门槛，已报名。
小海豚600G+1根滤芯/2根滤芯套餐加推投入和叠加百亿官补流量。已完成。`;

        console.log(reportStr);
        console.log('=================================================================\n');

    } catch (error) {
        console.error('\n[FATAL ERROR] 数据流执行崩溃，正在输出错误现场...');
        console.error('异常详情: ', error.stack);
    } finally {
        if(db) db.close(() => console.log(`[LOG] 数据库连接已安全断开。`));
    }
}

generateWeeklyReport();