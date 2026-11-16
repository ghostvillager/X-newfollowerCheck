# -*- coding: utf-8 -*-
"""
X Follower Tracker - セットアップスクリプト

やること:
  1. json フォルダ作成
  2. 拡張機能の読み込み手順を表示
  3. 拡張機能IDの取得（手動入力 / パスから計算）
  4. native-host/com.x.follower.tracker.json を絶対パス＋IDで更新
  5. 日本語パス対応の .reg を生成してレジストリ登録
  6. Native Host の動作テスト（json への書き込み・一覧）
"""

from __future__ import annotations

import sys
sys.dont_write_bytecode = True  # Chrome が __pycache__ を拒否するため

import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

HOST_NAME = "com.x.follower.tracker"
REG_KEY = rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"


def root_dir() -> Path:
    return Path(__file__).resolve().parent


def chrome_unpacked_extension_id(extension_path: Path) -> str:
    """
    Chrome の未パッケージ拡張機能IDをパスから計算する。
    パスを SHA256 → 先頭32ニブルを a-p にマップ。
    """
    # Chrome はパスを小文字化してからハッシュする（Windows では実パスの形式に注意）
    path_str = str(extension_path.resolve())
    # Windows: ドライブレター小文字、バックスラッシュのまま、が一般的
    if os.name == "nt":
        path_str = path_str[0].lower() + path_str[1:] if path_str else path_str
    else:
        path_str = path_str.lower()

    digest = hashlib.sha256(path_str.encode("utf-8")).hexdigest()
    table = "abcdefghijklmnop"  # 0-15
    return "".join(table[int(c, 16)] for c in digest[:32])


def ensure_json_dir(root: Path) -> Path:
    d = root / "json"
    d.mkdir(parents=True, exist_ok=True)
    readme = d / "README.txt"
    if not readme.exists():
        readme.write_text(
            "このフォルダにアカウント名_日時.json が保存されます。\n",
            encoding="utf-8",
        )
    return d


def write_host_manifest(root: Path, extension_id: str) -> Path:
    bat = (root / "native-host" / "native-host.bat").resolve()
    if not bat.exists():
        raise FileNotFoundError(f"native-host.bat が見つかりません: {bat}")

    manifest = {
        "name": HOST_NAME,
        "description": "X Follower Tracker Native Host - json folder I/O",
        "path": str(bat),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }

    out = root / "native-host" / "com.x.follower.tracker.json"
    out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out


def write_reg_file(host_json_path: Path, reg_path: Path) -> Path:
    """
    日本語パスでも壊れないよう UTF-16 LE BOM の .reg を生成する。
    """
    # .reg 内のパスはバックスラッシュを二重に
    value = str(host_json_path.resolve()).replace("\\", "\\\\")
    content = (
        "Windows Registry Editor Version 5.00\r\n"
        "\r\n"
        f"[HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\{HOST_NAME}]\r\n"
        f'@="{value}"\r\n'
    )
    # UTF-16 LE with BOM
    reg_path.write_bytes(b"\xff\xfe" + content.encode("utf-16-le"))
    return reg_path


def import_reg(reg_path: Path) -> None:
    # reg import は UTF-16 LE の .reg を正しく扱える
    cmd = ["reg", "import", str(reg_path)]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(
            "レジストリ登録に失敗しました。\n"
            f"stdout: {r.stdout}\nstderr: {r.stderr}\n"
            f"手動で次を実行: reg import \"{reg_path}\""
        )


def test_native_host(root: Path) -> None:
    """
    node で native-host.js 相当の処理を直接テスト
    （stdio プロトコルではなく、json フォルダへの書き込み・一覧）
    """
    js = root / "native-host" / "native-host.js"
    if not js.exists():
        raise FileNotFoundError(f"native-host.js がありません: {js}")

    # node があるか
    try:
        v = subprocess.run(
            ["node", "-v"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        )
        print(f"  Node.js: {v.stdout.strip()}")
    except Exception as e:
        raise RuntimeError(
            "Node.js が見つかりません。https://nodejs.org/ から LTS を入れて再実行してください。"
        ) from e

    # 小さなテストスクリプトを一時実行（json に書いて一覧）
    test_code = r"""
const fs = require('fs');
const path = require('path');
const jsonDir = path.resolve(__dirname, '..', 'json');
if (!fs.existsSync(jsonDir)) fs.mkdirSync(jsonDir, { recursive: true });
const name = 'setup_test.json';
const fp = path.join(jsonDir, name);
fs.writeFileSync(fp, JSON.stringify({ ok: true, t: Date.now() }, null, 2), 'utf8');
const files = fs.readdirSync(jsonDir).filter(f => f.endsWith('.json'));
console.log(JSON.stringify({ jsonDir, wrote: name, files }, null, 2));
"""
    host_dir = root / "native-host"
    r = subprocess.run(
        ["node", "-e", test_code],
        cwd=str(host_dir),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if r.returncode != 0:
        raise RuntimeError(f"Native Host テスト失敗:\n{r.stderr or r.stdout}")

    print("  書き込みテスト結果:")
    for line in (r.stdout or "").strip().splitlines():
        print(f"    {line}")


def ask_extension_id(computed: str) -> str:
    print()
    print("=" * 60)
    print("【重要】先に Chrome で拡張機能を読み込んでください")
    print("=" * 60)
    print()
    print("  1. Chrome のアドレスバーに次を入力して Enter:")
    print("       chrome://extensions")
    print("  2. 右上「デベロッパーモード」を ON")
    print("  3. 「パッケージ化されていない拡張機能を読み込む」")
    print(f"  4. 次のフォルダを選択:")
    print(f"       {root_dir()}")
    print("  5. カードに表示される「ID」をコピー")
    print()
    print(f"  参考: このパスから計算したID候補 → {computed}")
    print("       （通常はこれと一致します。違う場合は表示されているIDを優先）")
    print()

    while True:
        raw = input(f"拡張機能IDを貼り付け（空Enterで計算値を使用）: ").strip()
        if not raw:
            return computed
        # chrome-extension://xxx/ 形式も許容
        raw = raw.replace("chrome-extension://", "").strip("/")
        if len(raw) == 32 and raw.isalpha() and raw.islower():
            return raw
        print("  IDは英小文字32文字です。もう一度入力してください。")


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(description="X Follower Tracker セットアップ")
    parser.add_argument("--id", dest="ext_id", help="拡張機能ID（省略時は対話入力 or パスから計算）")
    parser.add_argument("--yes", action="store_true", help="確認を省略して計算IDを使う")
    args = parser.parse_args()

    if sys.platform != "win32":
        print("このセットアップは Windows + Chrome 向けです。")
        print("（レジストリ登録と Native Messaging）")
        print("非Windowsのため、レジストリ登録はスキップしてファイル準備のみ行います。\n")

    root = root_dir()
    print(f"拡張機能ルート: {root}")
    print()

    # 1. json
    print("[1/5] json フォルダを作成...")
    json_dir = ensure_json_dir(root)
    print(f"  → {json_dir}")

    # 2. 案内 + ID
    print("[2/5] 拡張機能ID...")
    computed = chrome_unpacked_extension_id(root)
    if args.ext_id:
        ext_id = args.ext_id.replace("chrome-extension://", "").strip("/")
    elif args.yes:
        ext_id = computed
        print(f"  --yes 指定のため計算IDを使用: {ext_id}")
    else:
        ext_id = ask_extension_id(computed)
    print(f"  使用するID: {ext_id}")

    # 3. host manifest
    print("[3/5] native-host マニフェストを更新...")
    host_json = write_host_manifest(root, ext_id)
    print(f"  → {host_json}")
    print(f"     path = {(root / 'native-host' / 'native-host.bat').resolve()}")
    print(f"     allowed_origins = chrome-extension://{ext_id}/")

    # 4. .reg 生成 + 登録
    print("[4/5] レジストリ登録（.reg）...")
    reg_path = root / "native-host" / "register-native-host.reg"
    write_reg_file(host_json, reg_path)
    print(f"  .reg 生成: {reg_path}")

    if sys.platform == "win32":
        try:
            import_reg(reg_path)
            print("  reg import 成功")
            print(f"  キー: HKCU\\{REG_KEY}")
            print(f"  値  : {host_json.resolve()}")
        except Exception as e:
            print(f"  [警告] 自動登録に失敗: {e}")
            print(f"  手動で次をダブルクリックするか実行してください:")
            print(f"    reg import \"{reg_path}\"")
    else:
        print("  （非Windowsのため reg import はスキップ）")
        print(f"  Windows では次を実行: reg import \"{reg_path}\"")

    # 5. テスト
    print("[5/5] Native Host / json 書き込みテスト...")
    try:
        test_native_host(root)
        print("  テスト成功")
    except Exception as e:
        print(f"  [警告] テスト失敗: {e}")

    print()
    print("=" * 60)
    print("セットアップ完了")
    print("=" * 60)
    print()
    print("次の手順:")
    print("  1. chrome://extensions で拡張機能を「再読み込み」")
    print("  2. 拡張機能アイコンを開く")
    print("  3. 「再接続」を押し、JSONフォルダのパスが表示されればOK")
    print()
    print(f"JSON保存先: {json_dir}")
    print(f"ファイル名例: {json_dir / 'username_20261116_190000.json'}")
    print()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n中断しました。")
        raise SystemExit(1)
    except Exception as e:
        print(f"\n[エラー] {e}", file=sys.stderr)
        raise SystemExit(1)
