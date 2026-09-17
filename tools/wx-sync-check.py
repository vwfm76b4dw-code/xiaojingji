#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wx-sync-check.py —— 校验「编辑源」与「部署镜像」是否逐字节一致。

判定标准（三条全过才算 SYNC OK）
--------------------------------
  1. 源里每个文件在镜像里都存在
  2. 两边同名文件 sha256 完全一致（逐字节，不做换行/编码归一化）
  3. 镜像里没有源中不存在的多余文件

为什么第 3 条也要管：多余的旧页面（如残留的 pages/index/）会被开发者工具一起编译，
其 .json 里的 usingComponents 可能指向已被删除的组件，直接导致真机白屏 ——
这类问题在只做"源 → 镜像覆盖"的同步里永远不会被暴露。

用法
----
  WX_TARGET=<你的 miniprogram-2 目录> python tools/wx-sync-check.py
  WX_TARGET=... python tools/wx-sync-check.py --quiet     # 只在失败时输出
  python tools/wx-sync-check.py --target D:/xxx/miniprogram-2   # 也可直接给参数

部署镜像目录因机而异，必须显式提供（环境变量 WX_TARGET 或 --target）；
未提供时打印用法并退出 2。本仓库会作为公开资源发布，因此不把任何人的
本机路径写成默认值 —— 个人目录名一旦进 git 历史就撤不回来了。

退出码：0 = SYNC OK；1 = 不一致；2 = 未提供目标目录
"""

import argparse
import hashlib
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = REPO_ROOT / "miniprogram"
DEFAULT_TARGET = os.environ.get("WX_TARGET")   # 无默认值：见文件头「用法」

EXCLUDE_DIRS = {"node_modules", ".git", ".vscode", "__pycache__"}
EXCLUDE_FILES = {"project.private.config.json", ".DS_Store", "Thumbs.db"}


def rel_files(root: Path):
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
    ap = argparse.ArgumentParser(description="校验 miniprogram/ 与部署镜像是否一致")
    ap.add_argument("--source", default=str(DEFAULT_SOURCE), help="编辑源目录")
    ap.add_argument("--target", default=DEFAULT_TARGET,
                    help="部署镜像目录（默认取环境变量 WX_TARGET）")
    ap.add_argument("--quiet", action="store_true", help="只在失败时输出")
    args = ap.parse_args()

    target = args.target or os.environ.get("WX_TARGET")
    if not target:
        print("用法：WX_TARGET=<你的 miniprogram-2 目录> python tools/wx-sync-check.py",
              file=sys.stderr)
        print("      （也可用 --target <目录> 直接指定）", file=sys.stderr)
        return 2

    src = Path(args.source).resolve()
    dst = Path(target).resolve()

    def say(*a):
        if not args.quiet:
            print(*a)

    if not src.is_dir():
        print("[FAIL] 编辑源目录不存在：%s" % src)
        return 1
    if not dst.is_dir():
        print("[FAIL] 部署镜像目录不存在：%s" % dst)
        return 1

    src_files = rel_files(src)
    dst_files = rel_files(dst)

    missing = sorted(src_files - dst_files)
    extras = sorted(dst_files - src_files)
    changed = []
    for rel in sorted(src_files & dst_files):
        if sha256(src / rel) != sha256(dst / rel):
            changed.append(rel)

    say("编辑源   : %s  （%d 个文件）" % (src, len(src_files)))
    say("部署镜像 : %s  （%d 个文件）" % (dst, len(dst_files)))
    say("-" * 68)

    ok = not (missing or extras or changed)
    if ok:
        say("SYNC OK —— 两边 %d 个文件逐字节一致，镜像里没有多余文件。" % len(src_files))
        return 0

    print("SYNC FAIL")
    for rel in missing:
        print("  缺失（源有、镜像没有）  %s" % rel)
    for rel in changed:
        print("  不一致（内容不同）      %s" % rel)
    for rel in extras:
        print("  多余（镜像有、源没有）  %s" % rel)
    print("-" * 68)
    print("共 %d 处不一致（缺失 %d / 不一致 %d / 多余 %d）。"
          % (len(missing) + len(changed) + len(extras), len(missing), len(changed), len(extras)))
    print("修复：WX_TARGET=<目录> python tools/wx-sync-apply.py --prune")
    return 1


if __name__ == "__main__":
    sys.exit(main())
