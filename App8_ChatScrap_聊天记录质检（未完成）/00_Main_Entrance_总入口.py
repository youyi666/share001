# -*- coding: utf-8 -*-
import os
import sys
import subprocess
import time

# --- 新增：强制切换工作目录到脚本所在文件夹 ---
# 获取当前脚本 main.py 的绝对路径
base_path = os.path.dirname(os.path.abspath(__file__))
# 切换工作目录
os.chdir(base_path)
print(f"📂 当前工作路径已切换至: {os.getcwd()}")
# ------------------------------------------

# ================= 配置区域 =================
# 最终精简版架构
SCRIPT_MAP = {
    "1": {
        "name": "🚀 启动爬虫 (生成任务 & 抓取)",
        "file": "06_Sync_Master_数据同步主程序.py",   # 现在的核心入口
        "type": "python"
    },
    "2": {
        "name": "🧠 AI 智能分析 (入库 & 记忆)",
        "file": "03_Analyze_Data_数据分析.py",    # 核心分析器
        "type": "python"
    },
    "3": {
        "name": "🌍 启动 Web 看板",
        "file": "04_Service_API_后端服务.js",     # 可视化服务器
        "type": "node_server"
    }
}

def clear_screen():
    os.system('cls' if os.name == 'nt' else 'clear')

def check_files():
    """检查核心脚本是否存在"""
    missing = []
    for key, item in SCRIPT_MAP.items():
        if not os.path.exists(item['file']):
            missing.append(item['file'])
    
    if missing:
        print("❌ 警告：以下核心文件缺失：")
        for f in missing:
            print(f"   - {f}")
        return False
    return True

def run_script(key):
    config = SCRIPT_MAP.get(key)
    script_path = config['file']
    
    print(f"\n🚀 正在启动: {config['name']} ...")
    print(f"📄 执行文件: {script_path}")
    print("-" * 40)
    
    try:
        if config['type'] == 'python':
            subprocess.call(["python", script_path], shell=True)
            print("-" * 40)
            input("✅ 执行结束，按回车键返回主菜单...")
            
        elif config['type'] == 'node_server':
            print("🌍 服务器将在新窗口启动。关闭该窗口即可停止服务。")
            if os.name == 'nt':
                # Windows 下打开新 CMD 窗口运行
                subprocess.Popen(f'start cmd /k node "{script_path}"', shell=True)
            else:
                subprocess.Popen(["node", script_path])
            time.sleep(2)
            
    except Exception as e:
        print(f"❌ 启动失败: {e}")
        input("按回车键继续...")

def main_menu():
    while True:
        clear_screen()
        print("==========================================")
        print("      🛒 拼多多数据治理系统 (精简版)       ")
        print("==========================================")
        
        for key in sorted(SCRIPT_MAP.keys()):
            item = SCRIPT_MAP[key]
            print(f" {key}. {item['name']}")
            
        print(" 0. 退出系统")
        print("==========================================")
        
        if not check_files():
            print("\n⚠️  检测到文件缺失，请检查目录。")
        
        choice = input("\n👉 请输入序号: ")

        if choice == '0':
            sys.exit()
        elif choice in SCRIPT_MAP:
            run_script(choice)
        else:
            print("❌ 无效选项")
            time.sleep(0.5)

if __name__ == "__main__":
    main_menu()