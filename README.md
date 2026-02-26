# LinQ VAL

医療材料のトレーサビリティ・使用記録・請求照合を行うPWA（Progressive Web App）です。
バーコードスキャンによる材料特定から、UKE（特定保険医療材料）照合、医師承認、ダッシュボードまでを一気通貫で提供します。

## 主な機能

- **バーコードスキャン** — JAN13 / GS1-128(GTIN14) をカメラで読み取り、約30万件の辞書から材料を即時特定
- **実施入力** — オペレーター → 患者 → 術式 → スキャンのステップで使用材料を記録
- **UKE照合** — 使用材料と請求コードの不一致を自動検出し、差分を一覧表示
- **医師承認** — 記録済みの術式・材料を医師が確認・承認
- **ダッシュボード** — 使用ランキング、コスト分析、承認状況をリアルタイムに可視化
- **CSVエクスポート** — 照合結果をダウンロードし外部システムと連携
- **オフライン対応** — Service Workerによりネットワーク切断時も動作

## ロール別ワークフロー

| ロール | 対象ユーザー | 主な操作 |
|--------|-------------|---------|
| 実施入力 | 看護師・CE技士 | 材料スキャン・使用記録 |
| 医事 | 医事課スタッフ | UKEコード照合・CSV出力 |
| 医師 | 医師 | 術式・材料の承認 |

## 技術スタック

| 項目 | 技術 |
|------|------|
| フロントエンド | Vanilla JavaScript (ES6+), HTML5, CSS3 |
| バーコード読取 | Quagga2 |
| データ保存 | LocalStorage / Service Worker Cache |
| フォント | Noto Sans JP, Figtree (Google Fonts) |
| バックエンド | なし（フルクライアントサイド） |

## ディレクトリ構成

```
docs/
├── index.html            # メインページ
├── app.js                # アプリケーションロジック
├── scan.js               # バーコードスキャンモジュール
├── sw.js                 # Service Worker
├── manifest.json         # PWAマニフェスト
├── DEMO_SCENARIO.md      # デモシナリオガイド
├── data/                 # マスタデータ (JSON)
│   ├── operators.json    # オペレーター一覧
│   ├── patients.json     # 患者データ
│   ├── procedures.json   # 術式マスタ (55+)
│   ├── doctors.json      # 医師マスタ (20+)
│   ├── billing_map.json  # 請求コードマッピング
│   └── standard_builder.json  # 術式提案ルール
├── dict_jan/             # JAN13辞書 (CSV, 407ファイル)
├── gtin_index/           # GTIN14辞書 (CSV, 304ファイル)
└── icons/                # アプリアイコン (SVG)
```

## セットアップ

バックエンド不要のため、静的サーバーで配信するだけで利用できます。

```bash
# 例: Python の簡易サーバー
cd docs
python3 -m http.server 8000
```

ブラウザで `http://localhost:8000` を開いてください。
GitHub Pages にデプロイする場合は `docs/` ディレクトリをそのまま公開設定します。

## デモ

デモシナリオの詳細は [docs/DEMO_SCENARIO.md](docs/DEMO_SCENARIO.md) を参照してください。
サンプルデータ（患者9名・オペレーター11名・術式55件以上）が同梱されており、すぐに動作を確認できます。

## 対応ブラウザ

- iOS Safari
- Android Chrome
- デスクトップ Chrome / Edge / Firefox

## ライセンス

このリポジトリにはライセンスが明示されていません。利用条件については管理者にお問い合わせください。
