"""SARIF 2.1.0 フォーマットのPydanticモデル

SARIF（Static Analysis Results Interchange Format）は静的解析ツールの
結果を表現するための標準フォーマットです。

このモジュールでは、CodeQL出力の解析に必要な最小限の型のみを定義しています。
使用されていないフィールド（tool, invocations等）はAnyで受け入れます。

参照: https://json.schemastore.org/sarif-2.1.0.json
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class SarifTextMessage(BaseModel):
    """テキストメッセージ"""

    text: str


class SarifArtifactLocation(BaseModel):
    """アーティファクト（ファイル）の場所"""

    uri: str
    uriBaseId: str | None = None
    index: int | None = None


class SarifRegion(BaseModel):
    """ソースコード上の領域"""

    startLine: int
    endLine: int | None = None
    startColumn: int | None = None
    endColumn: int | None = None


class SarifPhysicalLocation(BaseModel):
    """物理的なファイル位置"""

    model_config = ConfigDict(extra="allow")

    artifactLocation: SarifArtifactLocation
    region: SarifRegion | None = None


class SarifLocation(BaseModel):
    """ロケーション情報"""

    physicalLocation: SarifPhysicalLocation


class SarifResult(BaseModel):
    """解析結果（SARIF 2.1.0準拠）"""

    model_config = ConfigDict(extra="allow")

    ruleId: str
    message: SarifTextMessage
    locations: list[SarifLocation] | None = None
    level: Literal["none", "note", "warning", "error"] | None = None


class SarifRun(BaseModel):
    """解析の実行"""

    model_config = ConfigDict(extra="allow")

    results: list[SarifResult]
    tool: Any = None
    invocations: Any = None
    artifacts: Any = None


class SarifReport(BaseModel):
    """SARIF 2.1.0 レポートのルートモデル"""

    model_config = ConfigDict(extra="allow")

    version: str
    runs: list[SarifRun]
    schema_: str | None = Field(default=None, alias="$schema")


class SarifFinding(BaseModel):
    """SARIF検出結果（parse_sarif() の戻り値）

    SARIFファイルから抽出された検出結果の簡略版。

    Attributes:
        id: 結果のID（0から始まる連番）
        file_path: ファイルパス（リポジトリルートからの相対パス）
        start_line: 開始行番号
        end_line: 終了行番号
        start_column: 開始列番号（存在しない場合はNone）
        end_column: 終了列番号（存在しない場合はNone）
        message: 検出メッセージ
        severity: 深刻度（warning, error, noteなど）
    """

    id: int
    file_path: str
    start_line: int
    end_line: int
    start_column: int | None = None
    end_column: int | None = None
    message: str
    severity: str
