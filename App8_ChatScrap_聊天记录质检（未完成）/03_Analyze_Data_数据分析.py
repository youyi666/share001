# -*- coding: utf-8 -*-
import sqlite3
import json
import re
import time
import os
import sys
import hashlib
from collections import Counter
from datetime import datetime
from openai import OpenAI 

# ================= [配置区域] =================
# 基础路径配置
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "daily_raw_logs", "chat_logs.db")
JSON_DIR = os.path.join(BASE_DIR, "chat_logs") # 新增：原始JSON文件扫描路径
WEB_DATA_FILE = os.path.join(BASE_DIR, "web", "assets", "data.json")

# 清洗配置
THRESHOLD = 10  # 客服重复回复超过10次判定为自动回复

# --- AI 模型配置 (架构保留，当前锁定使用 DeepSeek) ---
DS_API_KEY = "sk-5ce512e159c64ce7a67b838828dd4f88" 
DS_BASE_URL = "https://api.deepseek.com"

# 备用配置
DB_API_KEY = "f30f6193-7aa4-481d-a3ea-b01374dbf55a" 
DB_MODEL_ENDPOINT = "ep-20260202133906-rzh7j" 

# 全局变量
client_ds = None 
client_db = None 

# ================= [核心工具函数] =================

def generate_uid(name, avatar_url):
    """
    [新增] 生成唯一用户ID (核心资产)
    算法: MD5(头像URL + 昵称) -> 16位指纹
    """
    # 如果没有头像，回退到仅用名字（兼容旧数据）
    raw_str = f"{name}_{avatar_url}" if avatar_url else name
    return hashlib.md5(raw_str.encode('utf-8')).hexdigest()[:16]

# ================= [数据库工具] =================

def init_db_schema():
    """初始化数据库结构 (升级版V2)"""
    if not os.path.exists(os.path.dirname(DB_PATH)):
        os.makedirs(os.path.dirname(DB_PATH))

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # 1. [新增] 客户档案表 (记忆库)
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS customers (
        uid TEXT PRIMARY KEY,
        customer_name TEXT,
        avatar_url TEXT,
        first_seen TEXT,
        last_seen TEXT,
        total_sessions INTEGER DEFAULT 0,
        risk_count INTEGER DEFAULT 0,
        user_summary TEXT,  -- AI 画像
        tags TEXT
    )
    ''')

    # 2. 会话表 (升级)
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        order_id TEXT,
        date TEXT,
        customer_uid TEXT,  -- [新增] 关联 customers.uid
        customer_name TEXT,
        goods_id TEXT,
        ai_category TEXT,
        ai_score INTEGER,
        ai_thought TEXT,
        is_risk BOOLEAN DEFAULT 0,
        ai_analyzed BOOLEAN DEFAULT 0,
        created_at TEXT
    )
    ''')
    
    # 自动补全可能缺失的字段 (兼容旧表)
    cursor.execute("PRAGMA table_info(sessions)")
    existing_cols = {col[1] for col in cursor.fetchall()}
    if 'customer_uid' not in existing_cols:
        try: cursor.execute("ALTER TABLE sessions ADD COLUMN customer_uid TEXT")
        except: pass
    if 'created_at' not in existing_cols:
        try: cursor.execute("ALTER TABLE sessions ADD COLUMN created_at TEXT")
        except: pass

    # 3. 消息表
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        time TEXT,
        sender TEXT,
        role TEXT,
        content TEXT,
        display_content TEXT,
        is_collapsed BOOLEAN DEFAULT 0,
        ai_risk_flag BOOLEAN DEFAULT 0,
        order_id TEXT
    )
    ''')

    # 检查 messages 表字段
    cursor.execute("PRAGMA table_info(messages)")
    msg_cols = {col[1] for col in cursor.fetchall()}
    required_msg_cols = ['display_content', 'is_collapsed', 'ai_risk_flag', 'order_id']
    for col in required_msg_cols:
        if col not in msg_cols:
            try: cursor.execute(f"ALTER TABLE messages ADD COLUMN {col} TEXT") # 简化处理，统一TEXT或BOOLEAN在SQLite不严格区分
            except: pass

    conn.commit()
    conn.close()

# ================= [模块一：数据同步 (File -> DB)] =================

def sync_json_to_db():
    """[新增] 主动扫描本地JSON文件，识别身份并入库"""
    print("📥 [同步] 正在扫描本地文件并建立档案...")
    if not os.path.exists(JSON_DIR):
        print(f"   ⚠️ 目录不存在: {JSON_DIR}")
        return

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    json_files = [f for f in os.listdir(JSON_DIR) if f.endswith('_chat.json')]
    new_count = 0
    
    for jf in json_files:
        file_path = os.path.join(JSON_DIR, jf)
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read().strip()
                if not content: continue
                
                data = json.loads(content)
                
                # 兼容旧版数组结构 (虽然新版脚本已改，但为了稳健)
                if isinstance(data, list):
                    messages = data
                    meta = {"orderId": jf.replace('_chat.json',''), "customerName": "Unknown", "customerAvatar": ""}
                else:
                    # 新版对象结构
                    messages = data.get('messages', [])
                    meta = data
                
                if not messages: continue

                # 1. 提取元数据
                order_id = meta.get('orderId', '')
                c_name = meta.get('customerName', 'Unknown')
                c_avatar = meta.get('customerAvatar', '')
                
                # 2. [核心] 生成身份指纹 UID
                uid = generate_uid(c_name, c_avatar)
                
                # 3. 确定 Session ID (使用 Order ID)
                session_id = order_id
                
                # 提取日期 (从第一条消息)
                date_str = datetime.now().strftime('%Y-%m-%d')
                if messages:
                    first_time = messages[0].get('time', '')
                    if len(first_time) >= 10:
                        date_str = first_time[:10]

                # 4. 检查是否已存在 (避免重复入库)
                cursor.execute("SELECT 1 FROM sessions WHERE session_id = ?", (session_id,))
                if cursor.fetchone():
                    continue # 已存在则跳过

                # 5. 入库操作
                # A. 插入/更新 客户档案
                cursor.execute("SELECT total_sessions, user_summary FROM customers WHERE uid = ?", (uid,))
                cust_row = cursor.fetchone()
                
                if cust_row:
                    # 老用户：更新活跃时间
                    cursor.execute("UPDATE customers SET last_seen = ?, customer_name = ? WHERE uid = ?", (date_str, c_name, uid))
                else:
                    # 新用户：创建档案
                    cursor.execute('''
                        INSERT INTO customers (uid, customer_name, avatar_url, first_seen, last_seen, user_summary)
                        VALUES (?, ?, ?, ?, ?, ?)
                    ''', (uid, c_name, c_avatar, date_str, date_str, "新发现用户"))

                # B. 插入 会话
                cursor.execute('''
                    INSERT INTO sessions (session_id, order_id, date, customer_uid, customer_name, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                ''', (session_id, order_id, date_str, uid, c_name, datetime.now().isoformat()))

                # C. 插入 消息
                for msg in messages:
                    role = msg.get('role', 'unknown')
                    sender = msg.get('name', msg.get('sender', ''))
                    
                    cursor.execute('''
                        INSERT INTO messages (session_id, time, sender, role, content, order_id)
                        VALUES (?, ?, ?, ?, ?, ?)
                    ''', (session_id, msg.get('time'), sender, role, msg.get('content'), order_id))
                
                new_count += 1
                # print(f"   ✅ 入库: {c_name} (UID:{uid[:6]}...)") # 减少刷屏

        except Exception as e:
            print(f"   ❌ 解析错误 {jf}: {e}")

    conn.commit()
    conn.close()
    if new_count > 0:
        print(f"🎉 新增入库 {new_count} 个会话。")
    else:
        print("✅ 文件同步完成 (无新文件)。")

def get_unprocessed_sessions():
    """获取待分析数据"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    sql = "SELECT * FROM sessions WHERE (ai_analyzed = 0 OR ai_analyzed IS NULL)"
    cursor.execute(sql)
    sessions = [dict(row) for row in cursor.fetchall()]

    if not sessions:
        conn.close()
        return {}, {}

    session_ids = [s['session_id'] for s in sessions]
    placeholders = ','.join(['?'] * len(session_ids))
    sql = f"SELECT * FROM messages WHERE session_id IN ({placeholders}) ORDER BY id ASC"
    cursor.execute(sql, session_ids)
    all_messages = [dict(row) for row in cursor.fetchall()]

    sessions_map = {s['session_id']: s for s in sessions}
    # 将消息挂载到 session 对象下
    for s in sessions_map.values():
        s['messages'] = []
    
    for msg in all_messages:
        sid = msg.get('session_id')
        if sid in sessions_map:
            sessions_map[sid]['messages'].append(msg)

    conn.close()
    return sessions_map, all_messages

def get_customer_profile(conn, uid):
    """[新增] 从数据库调取用户画像"""
    cursor = conn.cursor()
    cursor.execute("SELECT user_summary, total_sessions, risk_count FROM customers WHERE uid = ?", (uid,))
    row = cursor.fetchone()
    if row:
        return {
            "summary": row[0] or "暂无画像",
            "history_count": row[1] or 0,
            "risk_count": row[2] or 0
        }
    return {"summary": "新用户", "history_count": 0, "risk_count": 0}

def update_customer_memory(session_id, customer_uid, new_summary, is_risk):
    """[新增] 记忆回写：更新用户画像"""
    if not customer_uid: return
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        # 增量更新统计数据
        cursor.execute("SELECT total_sessions, risk_count FROM customers WHERE uid = ?", (customer_uid,))
        row = cursor.fetchone()
        
        current_total = (row[0] or 0) + 1 # 本次会话算一次
        current_risk = (row[1] or 0) + (1 if is_risk else 0)
        
        # 只有当 AI 返回了有效的新画像时才更新文本，否则只更新统计
        if new_summary and len(new_summary) > 2:
            cursor.execute('''
                UPDATE customers 
                SET user_summary = ?, total_sessions = ?, risk_count = ?
                WHERE uid = ?
            ''', (new_summary, current_total, current_risk, customer_uid))
        else:
            cursor.execute('''
                UPDATE customers 
                SET total_sessions = ?, risk_count = ?
                WHERE uid = ?
            ''', (current_total, current_risk, customer_uid))
            
        conn.commit()
    except Exception as e:
        print(f"❌ 记忆回写失败: {e}")
    finally:
        conn.close()

def save_session_results(session_id, ai_result, processed_messages):
    """回写会话分析结果"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            UPDATE sessions 
            SET ai_category = ?, ai_score = ?, ai_thought = ?, is_risk = ?, ai_analyzed = 1
            WHERE session_id = ?
        ''', (
            ai_result.get('category', '未归类'),
            ai_result.get('score', 0),
            ai_result.get('thought', ''),
            1 if ai_result.get('is_risk') else 0,
            session_id
        ))

        for msg in processed_messages:
            cursor.execute('''
                UPDATE messages 
                SET display_content = ?, is_collapsed = ?, ai_risk_flag = ?
                WHERE id = ?
            ''', (
                msg.get('display_content', ''),
                1 if msg.get('is_collapsed') else 0,
                1 if msg.get('_ai_risk_flag') else 0,
                msg['id']
            ))
        conn.commit()
    except Exception as e:
        print(f"❌ DB Write Error: {e}")
    finally:
        conn.close()

# ================= [清洗逻辑 (保持不变)] =================

def clean_text(text):
    if not isinstance(text, str): return ""
    return re.sub(r'http[s]?://\S+', '[链接]', text).strip()

def identify_auto_replies(all_messages_in_batch):
    cs_messages = []
    for msg in all_messages_in_batch:
        role = msg.get('role', 'unknown')
        sender = msg.get('sender', '')
        content = msg.get('content', '')
        
        is_cs = (role == 'cs') or ('viomi' in str(sender).lower()) or (role == '客服')
        
        if is_cs and content:
            cs_messages.append(clean_text(content))
            
    msg_counts = Counter(cs_messages)
    return {msg for msg, count in msg_counts.items() if count >= THRESHOLD and len(msg) > 5}

def preprocess_single_session(messages, frequent_replies):
    for msg in messages:
        original = msg.get('content', '')
        cleaned = clean_text(original)
        msg['display_content'] = cleaned
        
        role = msg.get('role', 'unknown')
        sender = msg.get('sender', '')
        is_cs = (role == 'cs') or ('viomi' in str(sender).lower()) or (role == '客服')
        
        if is_cs and cleaned in frequent_replies:
            msg['display_content'] = f"[自动回复] {cleaned[:10]}..." 
            msg['is_collapsed'] = True
        else:
            msg['is_collapsed'] = False
    return messages

def prepare_transcript_for_ai(messages):
    simplified_lines = []
    indices_map = {} 
    ai_line_counter = 0
    
    for original_index, msg in enumerate(messages):
        content = msg.get('display_content', '')
        role = msg.get('role', 'unknown')
        sender = msg.get('sender', '')
        
        display_role = "用户"
        if role == 'cs' or 'viomi' in str(sender).lower() or role == '客服':
            display_role = "客服"
        elif role == 'system': continue 
        
        if msg.get('is_collapsed'): continue
        if not content or content == '[图片]': continue
        if content.strip() in ["亲，您好", "在的", "收到", "好的"]: continue

        line_text = f"[{ai_line_counter}] {display_role}: {content}"
        simplified_lines.append(line_text)
        indices_map[ai_line_counter] = original_index
        ai_line_counter += 1
        
    return "\n".join(simplified_lines), indices_map

# ================= [AI 分析逻辑 (带记忆增强)] =================

def setup_clients():
    global client_ds, client_db
    try:
        client_ds = OpenAI(api_key=DS_API_KEY, base_url=DS_BASE_URL)
        client_db = OpenAI(api_key=DB_API_KEY, base_url="https://ark.cn-beijing.volces.com/api/v3")
    except Exception as e:
        print(f"⚠️ 客户端初始化警告: {e}")

def call_model_api_with_memory(transcript, provider, customer_profile):
    """
    [修改] 融合了业务规则 + 记忆系统的 Prompt
    """
    # 提取记忆
    history_summary = customer_profile['summary']
    history_count = customer_profile['history_count']
    history_risk = customer_profile['risk_count']

    system_prompt = f"""
    你是一个资深电商合规质检员，专注于【云米净水器】业务。你拥有对该用户的历史记忆。
    
    ### 👤 用户档案 (记忆库):
    - 历史印象: {history_summary}
    - 历史咨询次数: {history_count} | 历史风险次数: {history_risk}
    
    ### 🎯 你的双重任务:
    1. 【业务质检】: 识别本次对话是否有**实质性**的客诉风险 (产品质量/售后/服务/物流)。
    2. 【记忆更新】: 结合历史印象和今日表现，生成新的画像摘要。

    ### 🧠 核心思维链 (Step-by-Step):
    在输出JSON前，你必须先在脑海中执行以下判断：
    1. **时态判断**: 用户是在问“将要发生的事”(如:什么时候发货? 会漏水吗?)，还是陈述“已经发生的事”(如:发货晚了! 漏水了!)？
       -> ⚠️ 只有【陈述已发生的坏事】才可能构成风险。
    2. **情绪判断**: 用户说“人呢”是在正常的催促应答，还是在愤怒地控诉客服失联？
       -> ⚠️ 仅有“催促”而无“辱骂/愤怒”时，不视为服务风险。

    ### 一、业务风险维度 (仅当满足上述【已发生】且【负面】条件时触发):
    1. 产品质量: 
       - 风险: 明确反馈机器故障、漏水、噪音巨大、水质浑浊、滤芯寿命异常。
       - 🚫 非风险: 询问“有没有噪音”、“是否浪费水”、“废水比是多少”。(这是功能咨询)
    2. 售后安装: 
       - 风险: 师傅爽约、乱收费、安装后漏水、多次维修未好。
       - 🚫 非风险: 询问“什么时候安装”、“安装费多少钱”。
    3. 服务态度: 
       - 风险: 辱骂用户、推诿责任、客服长时间(超过10分钟)不回复导致用户愤怒。
       - 🚫 非风险: 发送“人呢”、“在吗”、“怎么不说话”(常规唤起)。
    4. 物流异常: 
       - 风险: 物流停滞超过3天、明确发货超时违约、收到货破损/错发。
       - 🚫 非风险: 询问“什么时候发货”、“能不能今天发”、“发顺丰吗”。

    ### 二、绝对豁免 (一票否决，直接 Score=0, is_risk=false):
    - **所有售前咨询**: 只要用户还在通过链接/口头询问产品参数、价格、赠品、发货时效，一律视为无风险。
    - **功能确认**: 用户询问“排废水”、“声音大”等产品特性确认行为。
    - **常规催促**: “快点回”、“人呢”，且未伴随辱骂。
    - **问题解决**: 用户自查解决、误会消除、情绪好转(发笑脸/说谢谢)。

    ### 三、输出格式 (纯JSON):
    {{
        "category": "分类名称 (若无风险填'常规咨询')",
        "score": 0-10 (注意：售前咨询/功能询问严禁超过 3分),
        "is_risk": true/false (必须有确凿的故障或违约事实才为true),
        "thought": "必须包含三段论：1.判断售前/售后阶段；2.区分询问/投诉意图；3.给出结论。例如：'用户询问排废水问题，属于售前功能咨询，并非反馈故障，因此无风险'。",
        "risk_line_indices": [行号],
        "new_user_summary": "更新后的用户画像(50字以内，例如：'用户依然关注滤芯价格，但情绪比上次好转')。"
    }}
    """
    
    try:
        if provider == 'deepseek':
            client = client_ds
            model = "deepseek-chat"
            resp_fmt = {"type": "json_object"}
        elif provider == 'doubao':
            client = client_db
            model = DB_MODEL_ENDPOINT
            resp_fmt = None 
        else:
            raise ValueError("Unknown Provider")

        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": transcript}
            ],
            temperature=0.1,
            response_format=resp_fmt
        )
        
        raw_content = response.choices[0].message.content
        clean_content = re.sub(r'```json\s*|\s*```', '', raw_content).strip()
        json_match = re.search(r'\{.*\}', clean_content, re.DOTALL)
        
        if json_match:
            return json.loads(json_match.group())
        return json.loads(clean_content)

    except Exception as e:
        print(f"AI Error: {e}")
        return {"is_risk": False, "thought": f"调用异常: {str(e)}", "score": 0, "new_user_summary": history_summary}

# ================= [Web JSON 导出] =================

def export_db_to_web_json():
    print(f"\n📤 [导出] 正在刷新前端数据: {WEB_DATA_FILE} ...")
    os.makedirs(os.path.dirname(WEB_DATA_FILE), exist_ok=True)
    
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    try:
        # 关联查询：Session + Customer Info (获取头像和画像)
        cursor.execute('''
            SELECT s.*, c.avatar_url, c.user_summary 
            FROM sessions s
            LEFT JOIN customers c ON s.customer_uid = c.uid
            ORDER BY s.date DESC
        ''')
        sessions = [dict(row) for row in cursor.fetchall()]
        
        export_data = []
        for sess in sessions:
            cursor.execute("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC", (sess['session_id'],))
            messages = [dict(row) for row in cursor.fetchall()]
            
            session_obj = {
                "id": sess['session_id'],
                "sessionId": sess['session_id'],
                "date": sess['date'],
                "customerName": sess['customer_name'] or "未知用户",
                "customerAvatar": sess['avatar_url'],  # [新增] 导出头像
                "userSummary": sess['user_summary'],   # [新增] 导出画像
                "goodsId": sess['goods_id'],
                "orderId": sess['order_id'],
                "ai_analysis": {
                    "category": sess['ai_category'] or "无问题",
                    "score": sess['ai_score'],
                    "thought": sess['ai_thought'],
                    "is_risk": bool(sess['is_risk'])
                },
                "messages": []
            }
            
            for msg in messages:
                session_obj["messages"].append({
                    "time": msg['time'],
                    "sender": msg['sender'],
                    "role": msg['role'],
                    "content": msg['content'],
                    "display_content": msg['display_content'] or msg['content'],
                    "is_collapsed": bool(msg['is_collapsed']),
                    "_ai_risk_flag": bool(msg['ai_risk_flag'])
                })
            export_data.append(session_obj)
            
        with open(WEB_DATA_FILE, 'w', encoding='utf-8') as f:
            json.dump(export_data, f, ensure_ascii=False, indent=2)
        print(f"✅ 导出成功！共包含 {len(export_data)} 个会话。")
        
    except Exception as e:
        print(f"❌ 导出失败: {e}")
    finally:
        conn.close()

# ================= [主流程] =================

def main():
    print("🚀 [启动] 数据清洗与AI质检处理器 (记忆增强版)...")
    
    setup_clients()
    init_db_schema()

    # 1. [新增] 先执行文件同步入库
    sync_json_to_db()

    # 2. 拉取未分析数据
    print(f"📥 正在扫描数据库中未分析的会话...")
    sessions_map, all_messages_flat = get_unprocessed_sessions()
    
    if sessions_map:
        total_sessions = len(sessions_map)
        print(f"📦 发现 {total_sessions} 个待处理会话。")
        
        frequent_replies = identify_auto_replies(all_messages_flat)

        print(f"🧠 [DeepSeek] 开始带记忆分析...")
        processed_count = 0
        risk_count = 0
        
        # 建立长连接用于循环内查询
        conn_query = sqlite3.connect(DB_PATH)

        for session_id, sess_data in sessions_map.items():
            processed_count += 1
            customer_name = sess_data.get('customer_name', 'Unknown')
            customer_uid = sess_data.get('customer_uid')
            
            print(f"   [{processed_count}/{total_sessions}] 分析: {customer_name} ...", end="\r")

            # A. 调档 (获取记忆)
            profile = get_customer_profile(conn_query, customer_uid)
            
            # B. 清洗
            clean_msgs = preprocess_single_session(sess_data['messages'], frequent_replies)
            transcript, indices_map = prepare_transcript_for_ai(clean_msgs)
            
            # C. AI 分析 (传入 Profile)
            if len(transcript) <= 20:
                 ai_res = {"is_risk": False, "thought": "对话过短，无实质内容", "category": "无问题", "score": 0, "new_user_summary": profile['summary']}
            else:
                 ai_res = call_model_api_with_memory(transcript, 'deepseek', profile)

            # D. 结果处理
            if ai_res.get('is_risk'):
                risk_count += 1
                risk_lines = ai_res.get('risk_line_indices', [])
                if isinstance(risk_lines, list):
                    for ai_idx in risk_lines:
                        try:
                            idx_key = int(ai_idx)
                            if idx_key in indices_map:
                                clean_msgs[indices_map[idx_key]]['_ai_risk_flag'] = True
                        except: continue
            
            # E. 结果回写 (Session)
            save_session_results(session_id, ai_res, clean_msgs)
            
            # F. [新增] 记忆回写 (Customer)
            update_customer_memory(session_id, customer_uid, ai_res.get('new_user_summary'), ai_res.get('is_risk'))

        conn_query.close()
        print(f"\n✅ 分析完成！本次发现 {risk_count} 个风险项，记忆已更新。")
        
        # 3. 导出给前端
        export_db_to_web_json()
    
    else:
        print("✅ 当前没有新的未分析数据。")

if __name__ == "__main__":
    main()