"""GitHubリポジトリのクローン処理を提供するモジュール

このモジュールでは、GitHubリポジトリをローカルにクローンする機能を提供します。
"""

import logging
from pathlib import Path
import subprocess

logger = logging.getLogger(__name__)


class RepositoryCloner:
    """GitHubリポジトリをローカルにクローンするクラス"""

    def __init__(self, github_token: str | None = None) -> None:
        """RepositoryClonerを初期化する

        Args:
            github_token: GitHub APIトークン（プライベートリポジトリの場合に使用）
        """
        self.github_token = github_token

    def clone(
        self,
        repository_url: str,
        destination: Path,
        *,
        depth: int = 1,
        timeout: int = 600,
        skip_if_exists: bool = False,
    ) -> Path:
        """リポジトリをクローンする

        Args:
            repository_url: GitHubリポジトリのURL（https://github.com/owner/repo.git）
            destination: クローン先ディレクトリ
            depth: クローンの深さ（デフォルト: 1 = shallow clone）
            timeout: タイムアウト時間（秒、デフォルト: 600秒）
            skip_if_exists: 既存ディレクトリがある場合スキップするか（デフォルト: False）

        Returns:
            Path: クローンされたディレクトリのパス

        Raises:
            subprocess.CalledProcessError: cloneに失敗した場合
            subprocess.TimeoutExpired: タイムアウトした場合
            ValueError: destinationが既に存在し、skip_if_exists=Falseの場合

        Examples:
            >>> cloner = RepositoryCloner()
            >>> cloner.clone("https://github.com/owner/repo.git", Path("/tmp/repo"))
            Path('/tmp/repo')
            >>> cloner.clone("https://github.com/owner/repo.git", Path("/tmp/repo"), skip_if_exists=True)
            Path('/tmp/repo')
        """
        if destination.exists():
            if skip_if_exists:
                logger.info("Destination already exists, skipping clone: %s", destination)
                return destination

            error_msg = f"Destination directory already exists: {destination}"
            logger.error(error_msg)
            raise ValueError(error_msg)

        # 親ディレクトリが存在しない場合は作成
        destination.parent.mkdir(parents=True, exist_ok=True)

        # git cloneコマンドを構築
        cmd = [
            "git",
            "clone",
            f"--depth={depth}",
            repository_url,
            str(destination),
        ]

        # GitHub Tokenが指定されている場合は、URLに埋め込む
        if self.github_token and repository_url.startswith("https://github.com/"):
            # https://github.com/owner/repo.git -> https://token@github.com/owner/repo.git
            authenticated_url = repository_url.replace(
                "https://github.com/",
                f"https://{self.github_token}@github.com/",
            )
            cmd[3] = authenticated_url
            logger.debug("Using authenticated URL for cloning")

        logger.info("Cloning repository: %s -> %s", repository_url, destination)
        logger.debug("Clone command: git clone --depth=%d <url> %s", depth, destination)

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True,
                timeout=timeout,
            )
            logger.info("Successfully cloned repository: %s", repository_url)
            logger.debug("Clone output: %s", result.stdout)
            return destination

        except subprocess.CalledProcessError as e:
            error_msg = f"Failed to clone repository {repository_url}: {e.stderr}"
            logger.error(error_msg)
            raise

        except subprocess.TimeoutExpired:
            error_msg = f"Clone timeout for repository {repository_url} after {timeout}s"
            logger.error(error_msg)
            raise
