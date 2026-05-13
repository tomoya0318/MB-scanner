"""箱ひげ図生成ライブラリ

このモジュールは、CodeQLクエリ実行結果のサマリーデータから箱ひげ図を生成します。
複数のクエリ結果を横並びで比較できる形式で可視化します。
"""

# pyright: reportUnknownMemberType=false
# matplotlibの型情報が不完全なため、このファイルでは一部の型チェックを緩和

import json
from pathlib import Path
import warnings

import matplotlib.pyplot as plt


def load_summary_data(json_file: Path) -> dict[str, int | list[int]]:
    """JSONファイルからサマリーデータを読み込む

    Args:
        json_file: 読み込むJSONファイルのパス

    Returns:
        dict: クエリID、総プロジェクト数、検出数のリストを含む辞書
            - query_id: クエリID (例: "id_10")
            - total_projects: 総プロジェクト数
            - values: 各プロジェクトの検出数のリスト

    Raises:
        FileNotFoundError: ファイルが存在しない場合
    """
    if not json_file.exists():
        raise FileNotFoundError(f"File not found: {json_file}")

    with json_file.open("r") as f:
        data = json.load(f)

    return {
        "query_id": data["query_id"],
        "total_projects": data["total_projects"],
        "values": list(data["results"].values()),
    }


def create_boxplot_summary(
    input_dir: Path,
    output_path: Path,
    log_scale: bool = False,
    title: str = "CodeQL Query Results - Box Plot Summary",
    query_order: list[str] | None = None,
) -> None:
    """複数のクエリ結果から箱ひげ図を生成する

    Args:
        input_dir: サマリーJSONファイルが格納されたディレクトリ
        output_path: 出力する画像ファイルのパス
        log_scale: Y軸を対数スケールにするかどうか（デフォルト: False）
        title: グラフのタイトル（デフォルト: "CodeQL Query Results - Box Plot Summary"）
        query_order: クエリIDの表示順序（例: ["id_10", "id_18", "id_222"]）
                     指定がない場合はファイル名順

    Raises:
        ValueError: JSONファイルが見つからない場合
    """
    # JSONファイルを取得
    json_files = sorted(input_dir.glob("*.json"))

    if not json_files:
        raise ValueError(f"No JSON files found in {input_dir}")

    # データを読み込む（検出があったプロジェクトのみ、0は追加しない）
    # まず全データを辞書に格納
    data_dict: dict[str, list[int]] = {}

    for json_file in json_files:
        summary = load_summary_data(json_file)
        query_id = str(summary["query_id"])
        values = summary["values"]
        if not isinstance(values, list):
            msg = f"Invalid data format in {json_file}"
            raise ValueError(msg)
        data_dict[query_id] = values

    # 順序指定がある場合はその順序で、ない場合はソート順で並べる
    if query_order:
        # 指定された順序でデータを並べる
        labels = query_order
        data_list = [data_dict[query_id] for query_id in query_order if query_id in data_dict]

        # 指定されていないクエリがある場合は警告
        missing_queries = set(query_order) - set(data_dict.keys())
        if missing_queries:
            warnings.warn(f"Specified queries not found: {missing_queries}", stacklevel=2)
    else:
        # デフォルトはソート順
        labels = sorted(data_dict.keys())
        data_list = [data_dict[label] for label in labels]

    # 図のサイズを設定（横長）
    fig_width = max(12, len(data_list) * 2.5)
    _fig, ax = plt.subplots(figsize=(fig_width, 6))

    # 箱ひげ図を作成
    bp = ax.boxplot(data_list, patch_artist=True)

    # X軸のラベルを設定
    ax.set_xticks(range(1, len(labels) + 1))
    ax.set_xticklabels(labels)

    # スタイリング
    for patch in bp["boxes"]:
        patch.set_facecolor("lightblue")

    # ラベルとタイトルを設定
    ax.set_xlabel("Query ID", fontsize=12)
    ax.set_ylabel("Detection Count", fontsize=12)
    ax.set_title(title, fontsize=14, fontweight="bold")

    # 対数スケールの設定
    if log_scale:
        ax.set_yscale("log")

    # グリッドを追加
    ax.grid(True, alpha=0.3, axis="y")

    # レイアウト調整
    plt.tight_layout()

    # 出力ディレクトリを作成
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # 画像を保存
    plt.savefig(output_path, dpi=300, bbox_inches="tight")
    plt.close()
