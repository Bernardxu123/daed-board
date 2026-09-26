#!/usr/bin/env python3
"""daed-board 一键部署：把面板文件推到 OpenWrt 路由器。

原理：本机起临时 HTTP 服务，路由器通过 curl 把文件拉取落盘
（/www/daed-board/ 面板本体 + /www/cgi-bin/daed-board-log 日志 CGI + LuCI 菜单入口）。

用法：
  python deploy.py --host 192.168.1.1
  # 密码可用环境变量 DAED_SSH_PASS 传入，否则交互输入
依赖：paramiko（pip install paramiko）。需要路由器开启 SSH 并可写 /www。

说明：脚本会在部署完成后清理临时服务；重复执行安全（幂等覆盖）。
"""
import argparse
import getpass
import http.server
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
PORT = 8765


def pc_lan_ip(router):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((router, 80))
        return s.getsockname()[0]
    finally:
        s.close()


def ssh_exec(host, user, password, *cmds):
    import paramiko
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, look_for_keys=False, allow_agent=False, timeout=10)
    try:
        out_all = []
        for cmd in cmds:
            _in, out, err = client.exec_command(cmd, timeout=120)
            o = out.read().decode("utf-8", "replace")
            e = err.read().decode("utf-8", "replace")
            print(f"$ {cmd}")
            if o:
                print(o, end="" if o.endswith("\n") else "\n")
            if e.strip():
                print("[stderr]", e.strip(), file=sys.stderr)
            out_all.append(o)
        return "\n".join(out_all)
    finally:
        client.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("DAED_SSH_HOST", ""))
    ap.add_argument("--user", default=os.environ.get("DAED_SSH_USER", "root"))
    ap.add_argument("--port", type=int, default=22)
    args = ap.parse_args()
    if not args.host:
        ap.error("请用 --host 指定路由器地址（如 192.168.1.1）")
    password = os.environ.get("DAED_SSH_PASS") or getpass.getpass(f"{args.user}@{args.host} 的 SSH 密码：")

    for f in ("index.html", "app.js", "style.css"):
        if not (HERE / f).exists():
            sys.exit(f"缺少 {f}")

    # 防缓存：上传前给 index.html 的静态引用打上时间戳版本号。
    # 必须走正则：引用可能已带手工 ?v=（匹配不到就静默失效，app.js 会永远拿旧缓存）。
    stamp = str(int(time.time()))
    upload_dir = HERE / "_deploy"
    upload_dir.mkdir(exist_ok=True)
    html = (HERE / "index.html").read_text(encoding="utf-8")
    html = re.sub(r'(app\.js)(\?v=[^"]*)?(")', rf'\1?v={stamp}\3', html)
    html = re.sub(r'(style\.css)(\?v=[^"]*)?(")', rf'\1?v={stamp}\3', html)
    if f'app.js?v={stamp}' not in html or f'style.css?v={stamp}' not in html:
        sys.exit("缓存戳写入失败：index.html 引用格式变了，请检查 deploy.py 的打戳正则")
    (upload_dir / "index.html").write_text(html, encoding="utf-8")
    for f in ("app.js", "style.css"):
        (upload_dir / f).write_bytes((HERE / f).read_bytes())
    for sub in ("luci", "cgi"):
        src = HERE / sub
        if src.exists():
            dst = upload_dir / sub
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src, dst)
    serve_dir = upload_dir

    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=str(serve_dir), **kw)
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://{pc_lan_ip(args.host)}:{PORT}"
    print(f"本地临时服务: {base}")

    def ssh(*cmds):
        return ssh_exec(args.host, args.user, password, *cmds)

    try:
        print("== 创建目录 ==")
        ssh("mkdir -p /www/daed-board")

        print("== 上传面板文件（路由器拉取） ==")
        out = ssh(
            f"curl -sfo /www/daed-board/index.html {base}/index.html"
            f" && curl -sfo /www/daed-board/app.js {base}/app.js"
            f" && curl -sfo /www/daed-board/style.css {base}/style.css"
            " && echo FILES_OK",
        )
        if "FILES_OK" not in out:
            sys.exit("面板文件上传失败")

        print("== 部署日志 CGI ==")
        out = ssh(
            f"curl -sfo /www/cgi-bin/daed-board-log {base}/cgi/daed-board-log"
            " && sed -i 's/\\r$//' /www/cgi-bin/daed-board-log"
            " && chmod +x /www/cgi-bin/daed-board-log"
            " && echo CGI_OK",
        )
        if "CGI_OK" not in out:
            sys.exit("CGI 部署失败")

        print("== 部署 LuCI 入口菜单 ==")
        out = ssh(
            f"curl -sfo /usr/share/luci/menu.d/luci-app-daed-board.json {base}/luci/menu.d/luci-app-daed-board.json"
            f" && curl -sfo /www/luci-static/resources/view/daed-board.js {base}/luci/view/daed-board.js"
            " && /etc/init.d/uhttpd restart"
            " && rm -f /tmp/luci-*index* /tmp/luci-menu* 2>/dev/null; true"
            " && echo LUCI_OK",
        )
        if "LUCI_OK" not in out:
            sys.exit("LuCI 入口部署失败")

        print("== 路由器侧校验 ==")
        ssh("ls -l /www/daed-board /www/cgi-bin/daed-board-log")

        print("== PC 侧校验 ==")
        for url in (f"http://{args.host}/daed-board/index.html",
                    f"http://{args.host}/daed-board/app.js",
                    f"http://{args.host}/cgi-bin/daed-board-log"):
            try:
                with urllib.request.urlopen(url, timeout=8) as r:
                    head = r.read(80)
                print(f"OK {url} ({r.status})")
            except Exception as e:
                print(f"FAIL {url}: {e}")

        print(f"\n部署完成：http://{args.host}/daed-board/  （LuCI：服务 → Daed 仪表盘）")
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
