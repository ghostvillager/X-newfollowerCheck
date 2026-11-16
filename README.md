# X Follower Tracker (Multi-account) v2.3

数万人規模のフォロワーを内部REST v1.1 APIで取得・差分管理するChrome拡張機能。  
**アカウント名ごと**にデータを管理し、**拡張機能フォルダ内の `json/`** に保存・読み込みします。

保存方式は [RocalHTMLSite のページ画像ダウンロード](https://github.com/ghostvillager/RocalHTMLSite) と同じく、  
**Native Messaging + レジストリ登録** で任意パスへ書き込みます（Downloads フォルダは使いません）。

## フォルダ構成

```
X-newfollowerCheck/          ← このフォルダを拡張機能として読み込む
  ├── manifest.json
  ├── background.js
  ├── popup.html / popup.js / styles.css
  ├── icons/
  ├── json/                  ← JSONの保存先（自動作成）
  ├── native-host/
  │   ├── native-host.bat
  │   ├── native-host.js
  │   └── com.x.follower.tracker.json
  └── セットアップ.bat
```

## 初回セットアップ

1. **Node.js** と **Python 3** を用意
2. Chrome で `chrome://extensions` → デベロッパーモード ON  
   → 「パッケージ化されていない拡張機能を読み込む」→ **このフォルダ** を選択
3. `setup.py` を実行（または `セットアップ.bat`）

```bat
py -3 setup.py
```

スクリプトが行うこと:
- `json` フォルダ作成
- 拡張機能の読み込み手順を表示
- 拡張機能IDの入力（パスから計算した候補あり）
- `native-host/com.x.follower.tracker.json` を絶対パス＋IDで更新
- 日本語パス対応の `.reg` を生成して `reg import`
- `json` への書き込みテスト

オプション:
```bat
py -3 setup.py --id 拡張機能のID
py -3 setup.py --yes
```

4. 拡張機能を再読み込み → 「再接続」で JSON パスが表示されればOK

## ファイル名

| 種類 | ファイル名 |
|------|------------|
| 単一アカウント | `{アカウント名}_{YYYYMMDD}_{HHmmss}.json` |
| 全アカウント | `all_{YYYYMMDD}_{HHmmss}.json` |

例: `json/ghostvillager_20261116_190530.json`

## 使い方

1. X にログインした状態で「フルスキャン開始」
2. 別アカウントは X で切り替えてから再スキャン
3. 上部セレクトで保存済みアカウントを切り替え
4. 「このアカウント出力」→ `json/` に保存
5. 「最新読込」→ `json/` 内の最新（選択中アカウント優先）を読み込み

## 注意

- 非公式セッション利用。過度な連続実行は避ける
- Xの仕様変更で動かなくなる可能性あり
- 自己責任で利用
- Native Host には Node.js が必要
