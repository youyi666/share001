# -*- coding: utf-8 -*-
"""
[Step 1] 任务生成器 (外部数据源版 - 智能去重修复)
功能：
1. 连接外部数据库 (TmallDataCenter.db)
2. 根据【商品ID】+【最近N天】筛选目标订单
3. 检查本地 chat_logs 目录，剔除已下载的订单
4. 生成 tasks.json 供 Node.js 爬虫使用
"""

import sqlite3
import json
import os
import subprocess
import time
from datetime import datetime, timedelta
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_SOURCE = os.path.abspath(os.path.join(
    CURRENT_DIR, 
    '..', '..', 
    '00_Shared_Database数据库', 
    'TmallDataCenter.db'
))

# 爬虫脚本
JS_SCRIPT = "01_Scraper_Pdd_Pure_拼多多纯净抓取.js" 
TASK_FILE = "tasks.json"
JSON_DIR = "chat_logs"  # [新增] 必须与 JS 脚本中的 OUTPUT_DIR 保持一致

# 过滤条件
MAX_DAYS_LOOKBACK = 7  # 只抓取最近 N 天的订单
TARGET_GOODS_IDS = [
    '862873034610',
    '868851073714',
    '225501370546',
    '852161740747'
]

# ================= 逻辑代码 =================

def get_local_processed_orders():
    """
    [新增] 扫描本地 chat_logs 文件夹，获取已下载的订单号
    """
    if not os.path.exists(JSON_DIR):
        return set()
    
    processed = set()
    # 扫描所有以 _chat.json 结尾的文件
    for f in os.listdir(JSON_DIR):
        if f.endswith('_chat.json'):
            # 文件名格式: {order_id}_chat.json
            order_id = f.replace('_chat.json', '')
            processed.add(order_id)
            
    print(f"   📂 本地缓存检测: 已存在 {len(processed)} 个订单记录")
    return processed

def get_tasks_from_external_db():
    print(f"🔄 [Python] 连接外部数据源: {DB_SOURCE}")
    if not os.path.exists(DB_SOURCE):
        print(f"❌ 错误: 找不到数据库文件 {DB_SOURCE}")
        return 0

    conn = sqlite3.connect(DB_SOURCE)
    cursor = conn.cursor()
    
    potential_tasks = []
    
    try:
        print(f"   📅 筛选时间范围: 最近 {MAX_DAYS_LOOKBACK} 天")
        print(f"   📦 目标商品ID: {TARGET_GOODS_IDS}")

        # 1. 数据库查询
        if TARGET_GOODS_IDS:
            conditions = ['"商品id" LIKE ?'] * len(TARGET_GOODS_IDS)
            where_clause = ' OR '.join(conditions)
            params = [f"%{gid}%" for gid in TARGET_GOODS_IDS]
            
            query = f'SELECT "订单号" FROM pddorder WHERE ({where_clause})'
            cursor.execute(query, params)
        else:
            print("   ⚠️ 未配置商品ID，将抓取全量！")
            cursor.execute('SELECT "订单号" FROM pddorder')

        raw_results = cursor.fetchall()
        print(f"   🔍 数据库命中: {len(raw_results)} 条原始记录")

        # 2. 日期清洗
        cutoff_date = datetime.now() - timedelta(days=MAX_DAYS_LOOKBACK)
        
        for row in raw_results:
            order_id = str(row[0]).strip()
            if not order_id or len(order_id) < 6: continue

            try:
                date_part = order_id[:6]
                if date_part.isdigit():
                    order_year = int("20" + date_part[:2])
                    order_month = int(date_part[2:4])
                    order_day = int(date_part[4:6])
                    order_date = datetime(order_year, order_month, order_day)
                    
                    if order_date >= cutoff_date:
                        potential_tasks.append(order_id)
                else:
                    potential_tasks.append(order_id)
            except:
                potential_tasks.append(order_id)

        # 3. [核心修复] 执行去重逻辑
        # 集合运算: 潜在任务 - 本地已下载 = 真正需要跑的任务
        potential_set = set(potential_tasks)
        processed_set = get_local_processed_orders()
        
        final_tasks = list(potential_set - processed_set)
        
        print(f"   📋 任务计算: 总数 {len(potential_set)} - 已下载 {len(processed_set)} = 新增 {len(final_tasks)}")

        # 4. 写入任务文件
        if final_tasks:
            with open(TASK_FILE, 'w', encoding='utf-8') as f:
                json.dump(final_tasks, f)
            print(f"   ✅ 生成任务文件: {len(final_tasks)} 个任务")
        else:
            # 如果没有新任务，清空任务文件，防止 JS 读到旧数据
            with open(TASK_FILE, 'w', encoding='utf-8') as f:
                json.dump([], f)
            print(f"   ✅ 所有近期订单均已处理完毕，无需抓取。")
            
        return len(final_tasks)

    except Exception as e:
        print(f"❌ 查询异常: {e}")
        import traceback
        traceback.print_exc()
        return 0
    finally:
        conn.close()

def run_spider():
    print(f"\n🚀 [System] 呼叫 Node.js 爬虫脚本 ({JS_SCRIPT})...")
    try:
        subprocess.run(["node", JS_SCRIPT], shell=True, check=True)
    except subprocess.CalledProcessError as e:
        print(f"❌ 爬虫执行出错: {e}")

if __name__ == "__main__":
    # 第一步：生成去重后的任务
    task_count = get_tasks_from_external_db()
    
    # 第二步：只有当有真任务时才启动爬虫
    if task_count > 0:
        run_spider()
    else:
        print("\n💤 暂无新任务，跳过爬虫阶段。")
    
    print("\n👋 流程结束。")
    time.sleep(3)