"""Retire only this public mock. The local development copy is unaffected."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import shutil

EXPIRES_AT = datetime.fromisoformat('2026-12-30T00:00:00+09:00')
MARKER = 'onba-koganemushi-shared-mock-v1'
EXPIRED_PAGE = '''<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>ONBA — 公開終了</title>
<style>body{margin:0;background:#111512;color:#edf0e8;font:16px system-ui;line-height:2}main{max-width:600px;margin:15vh auto;padding:28px}p{color:#a5bf98}h1{font-size:25px;font-weight:500}</style>
<main data-onba-state="expired"><p>ONBA · SHARED MOCK</p><h1>このモックの公開は終了しました。</h1><p>公開終了：2026年12月30日（日本時間）</p></main></html>
'''


def retire(root, now, apply=False):
    root = Path(root).resolve()
    if (root / '.onba-public-mock').read_text().strip() != MARKER:
        raise ValueError('This is not the ONBA public mock checkout')
    if now < EXPIRES_AT:
        return False
    if apply:
        for name in ('audio', 'vendor'):
            path = root / name
            if path.is_symlink():
                raise ValueError('Refusing to follow an asset symlink')
            if path.exists():
                shutil.rmtree(path)
        for name in ('app.js', 'audio-engine.js', 'tracking.js', 'scene.js', 'styles.css', 'entry.js'):
            (root / name).unlink(missing_ok=True)
        (root / 'index.html').write_text(EXPIRED_PAGE)
    return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    due = retire(root, datetime.now(timezone.utc), args.apply)
    print(f'due={str(due).lower()}')
