"""散布図生成ライブラリ

このモジュールでは、matplotlibを使用して散布図を生成します。
"""

# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
# matplotlib/scipy/numpyの型情報が不完全なため、このファイルでは一部の型チェックを緩和

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from scipy import stats


def create_scatter_plot(
    data: list[tuple[int, int, str]],
    output_path: Path,
    title: str = "CodeQL Detection vs JS Lines",
    xlabel: str = "JavaScript Lines Count",
    ylabel: str = "Detection Count",
    log_scale_x: bool = False,
    log_scale_y: bool = False,
    show_correlation: bool = False,
    show_regression: bool = False,
    xlim: tuple[float, float] | None = None,
    ylim: tuple[float, float] | None = None,
) -> None:
    """散布図を作成して保存する

    Args:
        data: 散布図用のデータ [(js_lines_count, detection_count, full_name), ...]
        output_path: 出力ファイルパス
        title: グラフのタイトル
        xlabel: X軸ラベル
        ylabel: Y軸ラベル
        log_scale_x: x軸を対数軸にするかどうか（デフォルト: False）
        log_scale_y: y軸を対数軸にするかどうか（デフォルト: False）
        show_correlation: スピアマンの順位相関係数を表示するかどうか（デフォルト: False）
        show_regression: 回帰直線を表示するかどうか（デフォルト: False）
        xlim: x軸の範囲 (min, max)。Noneの場合は自動設定
        ylim: y軸の範囲 (min, max)。Noneの場合は自動設定
    """
    # 出力ディレクトリが存在しない場合は作成
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # データを分解
    x_data = [item[0] for item in data]
    y_data = [item[1] for item in data]

    # 散布図を作成
    plt.figure(figsize=(10, 6))
    plt.scatter(x_data, y_data, alpha=0.6, edgecolors="w", linewidth=0.5)

    # x軸を対数軸に設定（オプション）
    if log_scale_x:
        plt.xscale("log")

    # y軸を対数軸に設定（オプション）
    if log_scale_y:
        plt.yscale("log")

    # グラフの装飾
    plt.title(title, fontsize=14, fontweight="bold")
    plt.xlabel(xlabel, fontsize=12)
    plt.ylabel(ylabel, fontsize=12)
    plt.grid(True, alpha=0.3)

    # 軸範囲の設定
    if xlim is not None:
        plt.xlim(xlim)
    if ylim is not None:
        plt.ylim(ylim)

    # 回帰直線を計算・表示（オプション）
    if show_regression and len(data) >= 2:
        # 対数変換（必要に応じて）
        x_calc = np.log10(x_data) if log_scale_x else np.array(x_data)
        y_calc = np.log10(y_data) if log_scale_y else np.array(y_data)

        # 線形回帰
        result = stats.linregress(x_calc, y_calc)
        slope = result.slope
        intercept = result.intercept

        # 回帰直線の描画範囲を決定（xlimが設定されている場合はその範囲、なければデータの範囲）
        if xlim is not None:
            x_min_line = np.log10(xlim[0]) if log_scale_x else xlim[0]
            x_max_line = np.log10(xlim[1]) if log_scale_x else xlim[1]
        else:
            x_min_line = min(x_calc)
            x_max_line = max(x_calc)

        # 回帰直線の計算
        x_line = np.linspace(x_min_line, x_max_line, 100)
        y_line = slope * x_line + intercept

        # 元のスケールに戻す（対数軸の場合）
        if log_scale_x:
            x_line = 10**x_line
        if log_scale_y:
            y_line = 10**y_line

        # 回帰直線を描画
        plt.plot(x_line, y_line, "r--", linewidth=2, alpha=0.8, label="Regression line")

    # スピアマンの順位相関係数を計算・表示（オプション）
    if show_correlation and len(data) >= 2:
        result = stats.spearmanr(x_data, y_data)
        correlation = result.statistic
        pvalue = result.pvalue
        # グラフの右上に相関係数を表示
        correlation_text = f"Spearman's ρ = {correlation:.3f}\np-value = {pvalue:.3e}"
        plt.text(
            0.95,
            0.95,
            correlation_text,
            transform=plt.gca().transAxes,
            fontsize=10,
            verticalalignment="top",
            horizontalalignment="right",
            bbox={"boxstyle": "round", "facecolor": "white", "alpha": 0.8},
        )

    # レイアウトを調整して保存
    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches="tight")
    plt.close()


def create_hexbin_plot(
    data: list[tuple[int, int, str]],
    output_path: Path,
    title: str = "CodeQL Detection vs JS Lines",
    xlabel: str = "JavaScript Lines Count",
    ylabel: str = "Detection Count",
    log_scale_x: bool = False,
    log_scale_y: bool = False,
    gridsize: int = 20,
    cmap: str = "YlOrRd",
    show_correlation: bool = False,
    show_regression: bool = False,
    xlim: tuple[float, float] | None = None,
    ylim: tuple[float, float] | None = None,
) -> None:
    """hexbinプロット（六角形ビニング）を作成して保存する

    Args:
        data: プロット用のデータ [(js_lines_count, detection_count, full_name), ...]
        output_path: 出力ファイルパス
        title: グラフのタイトル
        xlabel: X軸ラベル
        ylabel: Y軸ラベル
        log_scale_x: x軸を対数軸にするかどうか（デフォルト: False）
        log_scale_y: y軸を対数軸にするかどうか（デフォルト: False）
        gridsize: 六角形グリッドのサイズ（デフォルト: 20）
        cmap: カラーマップ名（デフォルト: 'YlOrRd'）
        show_correlation: スピアマンの順位相関係数を表示するかどうか（デフォルト: False）
        show_regression: 回帰直線を表示するかどうか（デフォルト: False）
        xlim: x軸の範囲 (min, max)。Noneの場合は自動設定
        ylim: y軸の範囲 (min, max)。Noneの場合は自動設定

    Raises:
        ValueError: データが空の場合
    """
    if not data:
        raise ValueError("データが空です")

    # 出力ディレクトリが存在しない場合は作成
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # データを分解
    x_data = [item[0] for item in data]
    y_data = [item[1] for item in data]

    # hexbinプロットを作成
    plt.figure(figsize=(10, 6))

    # x軸とy軸のスケール設定
    xscale = "log" if log_scale_x else "linear"
    yscale = "log" if log_scale_y else "linear"

    # hexbinプロットを描画
    hexbin = plt.hexbin(
        x_data,
        y_data,
        gridsize=gridsize,
        cmap=cmap,
        xscale=xscale,
        yscale=yscale,
        mincnt=1,
        edgecolors="face",
        linewidths=0.2,
    )

    # カラーバーを追加
    cbar = plt.colorbar(hexbin)
    cbar.set_label("Count", fontsize=12)

    # 回帰直線を計算・表示（オプション）
    if show_regression and len(data) >= 2:
        # 対数変換（必要に応じて）
        x_calc = np.log10(x_data) if log_scale_x else np.array(x_data)
        y_calc = np.log10(y_data) if log_scale_y else np.array(y_data)

        # 線形回帰
        result = stats.linregress(x_calc, y_calc)
        slope = result.slope
        intercept = result.intercept

        # 回帰直線の描画範囲を決定（xlimが設定されている場合はその範囲、なければデータの範囲）
        if xlim is not None:
            x_min_line = np.log10(xlim[0]) if log_scale_x else xlim[0]
            x_max_line = np.log10(xlim[1]) if log_scale_x else xlim[1]
        else:
            x_min_line = min(x_calc)
            x_max_line = max(x_calc)

        # 回帰直線の計算
        x_line = np.linspace(x_min_line, x_max_line, 100)
        y_line = slope * x_line + intercept

        # 元のスケールに戻す（対数軸の場合）
        if log_scale_x:
            x_line = 10**x_line
        if log_scale_y:
            y_line = 10**y_line

        # 回帰直線を描画
        plt.plot(x_line, y_line, "r--", linewidth=2, alpha=0.8, label="Regression line")

    # スピアマンの順位相関係数を計算・表示（オプション）
    if show_correlation and len(data) >= 2:
        result = stats.spearmanr(x_data, y_data)
        correlation = result.statistic
        pvalue = result.pvalue
        # グラフの右上に相関係数を表示
        correlation_text = f"Spearman's ρ = {correlation:.3f}\np-value = {pvalue:.3e}"
        plt.text(
            0.95,
            0.95,
            correlation_text,
            transform=plt.gca().transAxes,
            fontsize=10,
            verticalalignment="top",
            horizontalalignment="right",
            bbox={"boxstyle": "round", "facecolor": "white", "alpha": 0.8},
        )

    # グラフの装飾
    plt.title(title, fontsize=14, fontweight="bold")
    plt.xlabel(xlabel, fontsize=12)
    plt.ylabel(ylabel, fontsize=12)
    plt.grid(True, alpha=0.3)

    # 軸範囲の設定
    if xlim is not None:
        plt.xlim(xlim)
    if ylim is not None:
        plt.ylim(ylim)

    # レイアウトを調整して保存
    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches="tight")
    plt.close()
