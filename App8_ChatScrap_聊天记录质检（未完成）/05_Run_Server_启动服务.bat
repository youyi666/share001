@echo off
:: 修复中文乱码
chcp 65001 >nul

:: 切换到脚本所在的目录
cd /d "%~dp0"

echo ========================================================
echo   正在启动智能质检看板服务器...
echo   请勿关闭此窗口
echo ========================================================

:: 检查是否安装了 node
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js。 
    pause
    exit
)

:: 启动服务器 (注意文件名加了引号)
:: 如果你的文件名是 "step 3-server.js"，请使用下面这一行：
node "step 3-server.js"

:: 如果服务器意外崩溃，暂停显示错误信息
pause