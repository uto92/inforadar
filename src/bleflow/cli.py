"""bleflow CLI。

各コマンドはモジュールを遅延 import する(起動高速化と、コンポーネント単位の
コミット時点でも他コマンドに影響しないようにするため)。
"""

from __future__ import annotations

import sys

import click


@click.group(context_settings={"help_option_names": ["-h", "--help"]})
@click.option(
    "--settings",
    "-s",
    "settings_path",
    default="config/settings.yaml",
    show_default=True,
    help="設定ファイル(YAML)",
)
@click.pass_context
def main(ctx: click.Context, settings_path: str) -> None:
    """ble-flow: BLE パッシブスキャン人流分析基盤(天神橋1丁目)。"""
    ctx.obj = {"settings_path": settings_path}


def _settings(ctx: click.Context) -> dict:
    from .config import load_settings

    return load_settings(ctx.obj["settings_path"])


@main.command()
@click.option("--seed", type=int, default=None, help="乱数シードを上書き")
@click.option("--force", is_flag=True, help="手書きの deployments.yaml も上書きする")
@click.pass_context
def synth(ctx: click.Context, seed: int | None, force: bool) -> None:
    """合成データを生成する(センサーCSV・ground truth・deployments.yaml)。"""
    from .synth import SynthAbort, run_synth

    settings = _settings(ctx)
    if seed is not None:
        settings["synth"]["seed"] = seed
    try:
        run_synth(settings, force=force)
    except SynthAbort as exc:
        raise click.ClickException(str(exc)) from exc


@main.command()
@click.pass_context
def ingest(ctx: click.Context) -> None:
    """deployments.yaml に従い CSV を DuckDB へ取り込む(ハッシュ化・セッション化)。"""
    from .config import DeploymentsError
    from .ingest import run_ingest

    try:
        run_ingest(_settings(ctx))
    except (DeploymentsError, FileNotFoundError) as exc:
        raise click.ClickException(str(exc)) from exc


@main.command()
@click.pass_context
def analyze(ctx: click.Context) -> None:
    """分析を実行する(ビン集計・通過/滞留・OD・精度検証 → output/analysis/)。"""
    from .analyze import run_analyze

    try:
        run_analyze(_settings(ctx))
    except FileNotFoundError as exc:
        raise click.ClickException(str(exc)) from exc


@main.command()
@click.pass_context
def report(ctx: click.Context) -> None:
    """output/report.html(自己完結の単一HTML)を生成する。"""
    from .report import run_report

    try:
        run_report(_settings(ctx))
    except FileNotFoundError as exc:
        raise click.ClickException(str(exc)) from exc


@main.command()
@click.option("--seed", type=int, default=None, help="乱数シードを上書き")
@click.option("--force", is_flag=True, help="手書きの deployments.yaml も上書きする")
@click.pass_context
def demo(ctx: click.Context, seed: int | None, force: bool) -> None:
    """synth → ingest → analyze → report を合成データで一気通貫実行する。"""
    from .analyze import run_analyze
    from .ingest import run_ingest
    from .report import run_report
    from .synth import SynthAbort, run_synth

    settings = _settings(ctx)
    if seed is not None:
        settings["synth"]["seed"] = seed

    click.secho("── 1/4 synth ──────────────────────────────", bold=True)
    try:
        run_synth(settings, force=force)
    except SynthAbort as exc:
        raise click.ClickException(str(exc)) from exc
    click.secho("── 2/4 ingest ─────────────────────────────", bold=True)
    run_ingest(settings)
    click.secho("── 3/4 analyze ────────────────────────────", bold=True)
    data = run_analyze(settings)
    click.secho("── 4/4 report ─────────────────────────────", bold=True)
    report_path = run_report(settings)

    click.secho("\n══ demo 完了 ══════════════════════════════", bold=True)
    acc = data.get("accuracy")
    if acc:
        verdict = "PASS" if acc["pass_15"] else "FAIL"
        color = "green" if acc["pass_15"] else "red"
        click.echo("ground truth との誤差(時間帯×センサー、補正後ユニーク数):")
        click.echo(f"  真値加重 MAPE : {acc['weighted_mape_pct']:.1f} %")
        click.echo(
            f"  日合計        : 真値 {acc['total_true']:,} / 推定 {acc['total_corrected']:,.0f}"
            f"(誤差 {acc['total_err_pct']:+.1f} %)"
        )
        click.secho(f"  Phase 1 目標 ±15% 以内: {verdict}", fg=color, bold=True)
    else:
        click.echo("ground truth なし(実データモード)のため精度検証はスキップ")
    click.echo(f"レポート: {report_path} をブラウザで開いてください")
    if not acc or not acc["pass_15"]:
        sys.exit(0 if not acc else 1)
