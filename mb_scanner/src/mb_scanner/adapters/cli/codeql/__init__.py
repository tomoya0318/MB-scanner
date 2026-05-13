"""CodeQL関連のCLIコマンド"""

import typer

from mb_scanner.adapters.cli.codeql.create_db import create_database, create_database_batch
from mb_scanner.adapters.cli.codeql.extract import extract_code, extract_code_batch
from mb_scanner.adapters.cli.codeql.query import query, query_batch
from mb_scanner.adapters.cli.codeql.summary import summary

codeql_app = typer.Typer(help="CodeQL関連コマンド")

codeql_app.command("create-db")(create_database)
codeql_app.command("create-db-batch")(create_database_batch)
codeql_app.command("query")(query)
codeql_app.command("query-batch")(query_batch)
codeql_app.command("summary")(summary)
codeql_app.command("extract-code")(extract_code)
codeql_app.command("extract-code-batch")(extract_code_batch)
