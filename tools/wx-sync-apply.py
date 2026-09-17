#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wx-sync-apply.py —— 把「编辑源」的小程序源码单向同步到「部署镜像」目录。

为什么需要这个工具
------------------
本项目的代码同时存在于两个位置：

  编辑源（edit source）   = <仓库>/miniprogram
                            · 所有改动都在这里发生
                            · 7 道门禁（tools/verify-*.js）也在这里跑
  部署镜像（deploy mirror）= 环境变量 WX_TARGET 指定的目录
                            （例：D:/WeChatProjects/miniprogram-2，因机而异）
                            · 微信开发者工具打开的就是这一层
                            · 云函数上传、预览、真机调试都取这一层

两边一旦不一致，"本地测试全绿"就和"开发者工具里能跑"脱钩了 ——
最典型的后果是：门禁过了，但工具里跑的还是旧代码。
本工具负责单向覆盖（源 → 镜像），wx-sync-check.py 负责验证结果。

用法
----
  WX_TARGET=<你的 miniprogram-2 目录> python tools/wx-sync-apply.py
  WX_TARGET=... python tools/wx-sync-apply.py --dry-run   # 只打印会改什么，不动磁盘
  WX_TARGET=... python tools/wx-sync-apply.py --prune     # 额外删除镜像里"源已不存在"的文件
  python tools/wx-sync-apply.py --target D:/xxx/miniprogram-2   # 也可直接给参数

部署镜像目录因机而异，必须显式提供（环境变量 WX_TARGET 或 --target）；
未提供时打印用法并退出 2。本仓库会作为公开资源发布，因此不把任何人的
本机路径写成默认值 —— 个人目录名一旦进 git 历史就撤不回来了。

退出码：0 = 完成（含 dry-run 无差异）；1 = 出错；2 = 未提供目标目录
"""

import argparse
import hashlib
import os
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = REPO_ROOT / "miniprogram"
DEFAULT_TARGET = os.environ.get("WX_TARGET")   # 无默认值：见文件头「用法」

# 不参与同步的目录 / 文件。
# project.private.config.json 是开发者工具的"本机私有配置"（编译模式、最近打开页面等），
# 天然属于镜像侧，不该被源覆盖，也不该被当成"多出来的文件"删掉。
EXCLUDE_DIRS = {"node_modules", ".git", ".vscode", "__pycache__"}
EXCLUDE_FILES = {"project.private.config.json", ".DS_Store", "Thumbs.db"}


def rel_files(root: Path):
    """列出 root 下所有参与同步的文件（相对路径，posix 风格）。"""
    out = set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in filenames:
            if fn in EXCLUDE_FILES:
                continue
            out.add(Path(dirpath, fn).relative_to(root).as_posix())
    return out


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description="同步 miniprogram/ → 部署镜像")
    ap.add_argument("--source", default=str(DEFAULT_SOURCE), help="编辑源目录")
    ap.add_argument("--target", default=DEFAULT_TARGET,
                    help="部署镜像目录（默认取环境变量 WX_TARGET）")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写盘")
    ap.add_argument("--prune", action="store_true",
                    help="删除镜像里源已不存在的文件（默认只报告不删）")
    args = ap.parse_args()

    target = args.target or os.environ.get("WX_TARGET")
    if not target:
        print("用法：WX_TARGET=<你的 miniprogram-2 目录> python tools/wx-sync-apply.py",
              file=sys.stderr)
        print("      （也可用 --target <目录> 直接指定）", file=sys.stderr)
        return 2

    src = Path(args.source).resolve()
    dst = Path(target).resolve()

    if not src.is_dir():
        print("[ERROR] 编辑源目录不存在：%s" % src)
        return 1
    if not dst.is_dir():
        print("[ERROR] 部署镜像目录不存在：%s" % dst)
        print("        请先用微信开发者工具打开该目录，或确认 WX_TARGET / --target 是否正确。")
        return 1
    if src == dst:
        print("[ERROR] 源与目标是同一个目录：%s" % src)
        return 1

    src_files = rel_files(src)
    dst_files = rel_files(dst)

    copied, added, unchanged = [], [], []
    for rel in sorted(src_files):
        s, d = src / rel, dst / rel
        if rel not in dst_files:
            added.append(rel)
        elif sha256(s) != sha256(d):
            copied.append(rel)
        else:
            unchanged.append(rel)

    extras = sorted(dst_files - src_files)

    print("编辑源   : %s" % src)
    print("部署镜像 : %s" % dst)
    print("-" * 68)

    for rel in added:
        print("  新增  %s" % rel)
    for rel in copied:
        print("  更新  %s" % rel)
    for rel in extras:
        print("  多余  %s%s" % (rel, "" if args.prune else "   （源已不存在，需 --prune 才会删除）"))

    if not added and not copied and not (extras and args.prune):
        print("  无需改动：%d 个文件已一致" % len(unchanged))
        return 0

    if args.dry_run:
        print("-" * 68)
        print("[dry-run] 共需写入 %d 个文件%s，未改动磁盘。"
              % (len(added) + len(copied),
                 ("、删除 %d 个" % len(extras)) if (extras and args.prune) else ""))
        return 0

    for rel in added + copied:
        s, d = src / rel, dst / rel
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(s, d)

    pruned = 0
    if args.prune:
        for rel in extras:
            (dst / rel).unlink()
            pruned += 1

    print("-" * 68)
    print("同步完成：新增 %d、更新 %d、删除 %d、未变 %d。"
          % (len(added), len(copied), pruned, len(unchanged)))
    if extras and not args.prune:
        print("注意：镜像里仍有 %d 个源不存在的文件（未删除）。" % len(extras))
    print("请接着运行：WX_TARGET=<目录> python tools/wx-sync-check.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
